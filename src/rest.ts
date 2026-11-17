// REST v3 (GitHub API) over the one store.
//
// Shapes follow GitHub's v3 responses: the fields the suite reads (id, node_id,
// number, state, labels, head/base, content.sha, commit.sha, …) plus the usual
// companions, so a real client sees a familiar API. Errors are {"message": …}
// with a JSON content type; every reply carries X-GitHub-Request-Id and
// X-OAuth-Scopes.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  buildCommit,
  buildTreeFromFlat,
  commitFlatTree,
  diffFlatTrees,
  encodeGlobalId,
  hashObject,
  mergeBase,
  parseCommit,
  parseTag,
  threeWayMerge,
  type GitObject,
  type Issue,
  type Label,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import { VIEWER } from './scenario.ts';
import { nowIso, nowSec, queryOf, readJsonBody, sendJson, splitPath } from './util.ts';

// ---------------------------------------------------------------------------
// auth and plumbing
// ---------------------------------------------------------------------------

function authorized(req: IncomingMessage): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  if (!expected) return true; // local runs without a token configured
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${expected}`;
}

function reply(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  sendJson(res, status, body, { 'x-oauth-scopes': 'repo, read:org', ...headers });
}

function hostOf(req: IncomingMessage): string {
  return req.headers.host ?? '127.0.0.1';
}

function absUrl(req: IncomingMessage, path: string): string {
  return `http://${hostOf(req)}${path}`;
}

/** The viewer as a GitHub user object. */
function userJson(): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: encodeGlobalId('User', String(VIEWER.id)),
    avatar_url: '',
    gravatar_id: '',
    url: `/api/v3/users/${VIEWER.login}`,
    html_url: `https://github.com/${VIEWER.login}`,
    type: 'User',
    site_admin: false,
    name: VIEWER.name,
    email: VIEWER.email,
  };
}

/** Paginate a list; returns the page and the Link header value (or null). */
function paginate<T>(req: IncomingMessage, items: readonly T[], query: URLSearchParams): { page: T[]; link: string | null } {
  const perPage = Math.min(100, Math.max(1, parseInt(query.get('per_page') ?? '30', 10) || 30));
  const pageNum = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  const start = (pageNum - 1) * perPage;
  const page = items.slice(start, start + perPage);
  if (start + perPage >= items.length && pageNum === 1 && items.length <= perPage) return { page, link: null };
  const path = (() => {
    try {
      return new URL(req.url ?? '/', 'http://entry').pathname;
    } catch {
      return '/';
    }
  })();
  const other = new URLSearchParams(query);
  other.delete('page');
  const base = `${path}?${other.toString() ? `${other.toString()}&` : ''}per_page=${perPage}`;
  const links: string[] = [];
  if (start + perPage < items.length) links.push(`<${absUrl(req, `${base}&page=${pageNum + 1}`)}>; rel="next"`);
  const lastPage = Math.max(1, Math.ceil(items.length / perPage));
  links.push(`<${absUrl(req, `${base}&page=${lastPage}`)}>; rel="last"`);
  if (pageNum > 1) {
    links.push(`<${absUrl(req, `${base}&page=1`)}>; rel="first"`);
    links.push(`<${absUrl(req, `${base}&page=${pageNum - 1}`)}>; rel="prev"`);
  }
  return { page, link: links.join(', ') };
}

function listReply<T>(req: IncomingMessage, res: ServerResponse, items: readonly T[], query: URLSearchParams): void {
  const { page, link } = paginate(req, items, query);
  reply(res, 200, page, link === null ? {} : { link });
}

// ---------------------------------------------------------------------------
// JSON shapes
// ---------------------------------------------------------------------------

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repo.nodeId,
    name: repo.name,
    full_name: repo.fullName,
    owner: userJson(),
    private: repo.privateFlag,
    html_url: `https://github.com/${repo.fullName}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.fullName}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    git_url: `git://github.com/${repo.fullName}.git`,
    ssh_url: `git@github.com:${repo.fullName}.git`,
    clone_url: `https://github.com/${repo.fullName}.git`,
    homepage: null,
    size: repo.objects.size,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.privateFlag ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    allow_squash_merge: true,
    allow_merge_commit: true,
    allow_rebase_merge: true,
    allow_auto_merge: false,
    delete_branch_on_merge: false,
  };
}

function branchJson(name: string, sha: string): Record<string, unknown> {
  return {
    name,
    commit: { sha, node_id: encodeGlobalId('Commit', sha), url: `/api/v3/commits/${sha}` },
    protected: false,
  };
}

function commitJson(repo: Repo, sha: string): Record<string, unknown> | null {
  const object = repo.objects.get(sha);
  if (!object || object.type !== 'commit') return null;
  let commit: ReturnType<typeof parseCommit>;
  try {
    commit = parseCommit(object.data);
  } catch {
    return null;
  }
  const person = (line: string): { name: string; email: string; date: string } => {
    const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(line);
    if (!match) return { name: VIEWER.name, email: VIEWER.email, date: repo.createdAt };
    return {
      name: match[1] as string,
      email: match[2] as string,
      date: new Date(Number(match[3]) * 1000).toISOString(),
    };
  };
  return {
    sha,
    node_id: encodeGlobalId('Commit', sha),
    commit: {
      author: person(commit.author),
      committer: person(commit.committer),
      message: commit.message.replace(/\n+$/, ''),
      tree: { sha: commit.tree, url: `/api/v3/repos/${repo.fullName}/git/trees/${commit.tree}` },
      url: `/api/v3/repos/${repo.fullName}/git/commits/${sha}`,
      comment_count: 0,
    },
    url: `/api/v3/repos/${repo.fullName}/commits/${sha}`,
    html_url: `https://github.com/${repo.fullName}/commit/${sha}`,
    author: userJson(),
    committer: userJson(),
    parents: commit.parents.map((parent) => ({ sha: parent, url: `/api/v3/repos/${repo.fullName}/commits/${parent}` })),
  };
}

function labelJson(repo: Repo, label: Label): Record<string, unknown> {
  let hash = 0;
  for (const char of label.name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return {
    id: repo.id * 1_000_000 + 700_000 + (hash % 100_000),
    node_id: encodeGlobalId('Label', `${repo.id}:${label.name}`),
    url: `/api/v3/repos/${repo.fullName}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.id * 1_000_000 + issue.number,
    node_id: issue.nodeId,
    url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.fullName}`,
    html_url: `https://github.com/${repo.fullName}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    user: userJson(),
    labels: issue.labels.map((label) => labelJson(repo, label)),
    state: issue.state,
    locked: false,
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
    state_reason: null,
  };
}

function commentJson(repo: Repo, issue: Issue, comment: Issue['comments'][number]): Record<string, unknown> {
  return {
    id: repo.id * 1_000_000 + 900_000 + comment.id,
    node_id: comment.nodeId,
    url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}/comments/${comment.id}`,
    html_url: `https://github.com/${repo.fullName}/issues/${issue.number}#issuecomment-${comment.id}`,
    body: comment.body,
    user: userJson(),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    author_association: 'OWNER',
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const headRepo = repoJson(repo);
  const baseRepo = repoJson(repo);
  return {
    id: repo.id * 1_000_000 + 500_000 + pull.number,
    node_id: pull.nodeId,
    url: `/api/v3/repos/${repo.fullName}/pulls/${pull.number}`,
    html_url: `https://github.com/${repo.fullName}/pull/${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    user: userJson(),
    labels: [],
    milestone: null,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    mergeable: null,
    mergeable_state: 'unknown',
    merged_by: null,
    comments: 0,
    review_comments: 0,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
    head: {
      label: `${VIEWER.login}:${pull.headRef}`,
      ref: pull.headRef,
      sha: pull.headSha,
      user: userJson(),
      repo: headRepo,
    },
    base: {
      label: `${VIEWER.login}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: pull.baseSha,
      user: userJson(),
      repo: baseRepo,
    },
    author_association: 'OWNER',
    auto_merge: null,
    draft: false,
  };
}

// ---------------------------------------------------------------------------
// git helpers for the contents and merge endpoints
// ---------------------------------------------------------------------------

/** Resolve a ref name or oid to a commit oid, or null when it does not resolve. */
function resolveRef(repo: Repo, ref: string | null | undefined): string | null {
  if (ref === null || ref === undefined || ref === '') return repo.defaultTip();
  const branchTip = repo.refs.get(`refs/heads/${ref}`);
  if (branchTip !== undefined) return branchTip;
  const tagTip = repo.refs.get(`refs/tags/${ref}`);
  if (tagTip !== undefined) {
    const object = repo.objects.get(tagTip);
    if (object?.type === 'tag') {
      try {
        return parseTag(object.data).object;
      } catch {
        return tagTip;
      }
    }
    return tagTip;
  }
  if (/^[0-9a-f]{40}$/.test(ref) && repo.objects.has(ref)) return ref;
  return null;
}

/** Create a commit on a branch from a flat tree; returns the new commit oid. */
function commitFlatTreeToBranch(
  store: Store,
  repo: Repo,
  branch: string,
  flat: ReadonlyMap<string, { oid: string; mode: string }>,
  message: string,
): string {
  const created: GitObject[] = [];
  const treeOid = buildTreeFromFlat(repo, flat, created);
  const tip = repo.refs.get(`refs/heads/${branch}`) ?? null;
  const commitData = buildCommit({
    tree: treeOid,
    parents: tip === null ? [] : [tip],
    message: message.endsWith('\n') ? message : `${message}\n`,
    timestamp: nowSec(),
  });
  const commitOid = hashObject('commit', commitData);
  created.push({ type: 'commit', data: commitData });
  store.putObjects(repo, created);
  store.setRef(repo, `refs/heads/${branch}`, commitOid);
  return commitOid;
}

/** MERGEABLE / CONFLICTING / UNKNOWN for a pull request's head against its base. */
export function mergeableState(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (baseTip === undefined || headTip === undefined) return 'UNKNOWN';
  const base = mergeBase(repo, baseTip, headTip);
  if (base === null) {
    // Unrelated histories merge cleanly (theirs wins where ours is untouched).
    return 'MERGEABLE';
  }
  const { conflicts } = threeWayMerge(commitFlatTree(repo, base), commitFlatTree(repo, baseTip), commitFlatTree(repo, headTip));
  return conflicts.length > 0 ? 'CONFLICTING' : 'MERGEABLE';
}

// ---------------------------------------------------------------------------
// shared record builders (REST and GraphQL build the same records)
// ---------------------------------------------------------------------------

/** Create an issue record (number, ids, timestamps) and journal it. */
export function createIssueRecord(store: Store, repo: Repo, title: string, body: string, labels: Label[]): Issue {
  const number = store.takeNumber(repo);
  const now = nowIso();
  const issue: Issue = {
    number,
    id: repo.id * 1_000_000 + number,
    nodeId: encodeGlobalId('Issue', `${repo.id}:${number}`),
    title,
    body,
    state: 'open',
    labels,
    comments: [],
    createdSeq: store.nextSeq,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  };
  store.nextSeq += 1;
  store.upsertIssue(repo, issue);
  return issue;
}

/** Append a comment to an issue and journal it. */
export function addCommentRecord(store: Store, repo: Repo, issue: Issue, body: string): Issue['comments'][number] {
  const commentId = repo.nextCommentId;
  repo.nextCommentId += 1;
  const now = nowIso();
  const comment = {
    id: commentId,
    nodeId: encodeGlobalId('IssueComment', `${repo.id}:${issue.number}:${commentId}`),
    body,
    user: VIEWER.login,
    createdAt: now,
    updatedAt: now,
  };
  issue.comments.push(comment);
  issue.updatedAt = now;
  store.upsertIssue(repo, issue);
  return comment;
}

/** Create a pull request record (number, ids, timestamps) and journal it. */
export function createPullRecord(store: Store, repo: Repo, title: string, body: string, head: string, base: string): Pull {
  const headSha = repo.refs.get(`refs/heads/${head}`) as string;
  const baseSha = repo.refs.get(`refs/heads/${base}`) as string;
  const number = store.takeNumber(repo);
  const now = nowIso();
  const pull: Pull = {
    number,
    id: repo.id * 1_000_000 + 500_000 + number,
    nodeId: encodeGlobalId('PullRequest', `${repo.id}:${number}`),
    title,
    body,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef: head,
    baseRef: base,
    headSha,
    baseSha,
    createdSeq: store.nextSeq,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  };
  store.nextSeq += 1;
  store.upsertPull(repo, pull);
  return pull;
}

/**
 * Squash-merge a pull request onto its base branch: one commit with the merged
 * tree and parents=[base tip]. Returns the merge commit sha, or the reason the
 * merge cannot happen (conflict, missing branch, already merged).
 */
export function performSquashMerge(
  store: Store,
  repo: Repo,
  pull: Pull,
  message: string,
): { ok: true; sha: string } | { ok: false; reason: string } {
  if (pull.merged || pull.state === 'closed') return { ok: false, reason: 'already merged or closed' };
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (baseTip === undefined || headTip === undefined) return { ok: false, reason: 'head or base branch is missing' };
  const base = mergeBase(repo, baseTip, headTip);
  const baseFlat = base === null ? new Map() : commitFlatTree(repo, base);
  const { merged, conflicts } = threeWayMerge(baseFlat, commitFlatTree(repo, baseTip), commitFlatTree(repo, headTip));
  if (conflicts.length > 0) return { ok: false, reason: `merge conflict: ${conflicts.join(', ')}` };
  const mergeSha = commitFlatTreeToBranch(store, repo, pull.baseRef, merged, message);
  const now = nowIso();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = now;
  pull.mergeCommitSha = mergeSha;
  pull.closedAt = now;
  pull.updatedAt = now;
  store.upsertPull(repo, pull);
  return { ok: true, sha: mergeSha };
}

// ---------------------------------------------------------------------------
// the router
// ---------------------------------------------------------------------------

const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;

/** Handle a REST request; returns true when the path belonged to /api/v3. */
export async function handleRest(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  const segments = splitPath(new URL(req.url ?? '/', 'http://entry').pathname);
  if (segments[0] !== 'api' || segments[1] !== 'v3') return false;
  const method = req.method ?? 'GET';
  const query = queryOf(req);
  const rest = segments.slice(2);

  if (!authorized(req)) {
    reply(res, 401, { message: 'Bad credentials' });
    return true;
  }

  const badJson = (): void => reply(res, 400, { message: 'Problems parsing JSON' });
  const readJson = async (): Promise<Record<string, unknown> | null> => {
    try {
      const body = await readJsonBody(req);
      if (body === undefined) return {};
      if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
      return body as Record<string, unknown>;
    } catch {
      return null;
    }
  };

  // -- root, meta, user -------------------------------------------------------
  if (rest.length === 0) {
    if (method !== 'GET') return reply(res, 405, { message: 'Method Not Allowed' }), true;
    return reply(res, 200, {
      current_user_url: '/api/v3/user',
      current_user_authorizations_html_url: 'https://github.com/settings/applications',
      authorizations_url: '/api/v3/authorizations',
      code_search_url: '/api/v3/search/code?q={query}{&page,per_page,sort,order}',
      commit_search_url: '/api/v3/search/commits?q={query}{&page,per_page,sort,order}',
      emails_url: '/api/v3/user/emails',
      emojis_url: '/api/v3/emojis',
      events_url: '/api/v3/events',
      feeds_url: '/api/v3/feeds',
      followers_url: '/api/v3/users/{user}/followers',
      following_url: '/api/v3/users/{user}/following{/target}',
      gists_url: '/api/v3/gists{/gist_id}',
      hub_url: 'https://api.github.com/hub',
      issue_search_url: '/api/v3/search/issues?q={query}{&page,per_page,sort,order}',
      issues_url: '/api/v3/issues',
      keys_url: '/api/v3/user/keys',
      label_search_url: '/api/v3/search/labels?q={query}{&repository_id}{&page,per_page}',
      notifications_url: '/api/v3/notifications',
      organization_repositories_url: '/api/v3/orgs/{org}/repos{?type,page,per_page,sort}',
      organization_url: '/api/v3/orgs/{org}',
      public_gists_url: '/api/v3/gists/public',
      rate_limit_url: '/api/v3/rate_limit',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      repository_search_url: '/api/v3/search/repositories?q={query}{&page,per_page,sort,order}',
      current_user_repositories_url: '/api/v3/user/repos{?type,page,per_page,sort}',
      starred_url: '/api/v3/user/starred{/owner}{/repo}',
      starred_gists_url: '/api/v3/gists/starred',
      topic_search_url: '/api/v3/search/topics?q={query}{&page,per_page}',
      user_url: '/api/v3/users/{user}',
      user_organizations_url: '/api/v3/users/{user}/orgs',
      user_repositories_url: '/api/v3/users/{user}/repos{?type,page,per_page,sort}',
      user_search_url: '/api/v3/search/users?q={query}{&page,per_page,sort,order}',
    }), true;
  }
  if (rest.length === 1 && rest[0] === 'meta') {
    if (method !== 'GET') return reply(res, 405, { message: 'Method Not Allowed' }), true;
    return reply(res, 200, { verifiable_password_authentication: true, installed_version: '1.0.0', api: ['v3'], git: ['v0', 'v2'] }), true;
  }
  if (rest.length === 1 && rest[0] === 'user') {
    if (method !== 'GET') return reply(res, 405, { message: 'Method Not Allowed' }), true;
    return reply(res, 200, userJson()), true;
  }

  // -- /user/repos ------------------------------------------------------------
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'GET') {
      const list = [...store.repoList].filter((repo) => repo.owner === VIEWER.login).map((repo) => repoJson(repo));
      return listReply(req, res, list, query), true;
    }
    if (method === 'POST') {
      const body = await readJson();
      if (body === null) return badJson(), true;
      const name = typeof body.name === 'string' ? body.name : '';
      const description = typeof body.description === 'string' ? body.description : '';
      const isPrivate = body.private === true || body.visibility === 'private';
      if (!REPO_NAME.test(name) || name === '.' || name === '..' || name.endsWith('.git')) {
        return reply(res, 422, { message: 'Repository name is invalid', errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name is invalid' }] }), true;
      }
      if (store.getRepo(VIEWER.login, name) !== null) {
        return reply(res, 422, { message: 'Repository creation failed.', errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }] }), true;
      }
      const repo = store.createRepo(VIEWER.login, name, description, isPrivate);
      return reply(res, 201, repoJson(repo)), true;
    }
    return reply(res, 405, { message: 'Method Not Allowed' }), true;
  }

  // -- /repos/{owner}/{repo}/... ----------------------------------------------
  if (rest[0] === 'repos' && rest.length >= 3) {
    const owner = rest[1] as string;
    const name = rest[2] as string;
    const repo = store.getRepo(owner, name);
    const tail = rest.slice(3);
    if (repo === null) return reply(res, 404, { message: 'Not Found' }), true;

    // GET/PATCH/DELETE /repos/{owner}/{repo}
    if (tail.length === 0) {
      if (method === 'GET') return reply(res, 200, repoJson(repo)), true;
      if (method === 'DELETE') {
        store.deleteRepo(repo);
        return reply(res, 204, null), true;
      }
      if (method === 'PATCH') {
        const body = await readJson();
        if (body === null) return badJson(), true;
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.privateFlag = body.private;
        if (typeof body.default_branch === 'string') {
          if (!repo.refs.has(`refs/heads/${body.default_branch}`)) {
            return reply(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Repository', code: 'custom', field: 'default_branch', message: 'default branch does not exist' }] }), true;
          }
          repo.defaultBranch = body.default_branch;
        }
        repo.updatedAt = nowIso();
        return reply(res, 200, repoJson(repo)), true;
      }
      return reply(res, 405, { message: 'Method Not Allowed' }), true;
    }

    // -- git/refs -------------------------------------------------------------
    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (method === 'POST' && tail.length === 2) {
        const body = await readJson();
        if (body === null) return badJson(), true;
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha) || !repo.objects.has(sha)) {
          return reply(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Reference', code: 'custom', field: 'sha', message: 'sha is not a valid object' }] }), true;
        }
        if (repo.refs.has(ref)) {
          return reply(res, 422, { message: 'Reference already exists', errors: [{ resource: 'Reference', code: 'custom', field: 'ref', message: 'reference already exists' }] }), true;
        }
        store.setRef(repo, ref, sha);
        return reply(res, 201, { ref, node_id: encodeGlobalId('Ref', `${repo.id}:${ref}`), url: `/api/v3/repos/${repo.fullName}/git/refs/${ref.slice(5)}`, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: `/api/v3/repos/${repo.fullName}/git/${repo.objects.get(sha)?.type ?? 'commit'}s/${sha}` } }), true;
      }
      if (method === 'GET' && tail.length >= 3) {
        const ref = `refs/${tail.slice(2).join('/')}`;
        const oid = repo.refs.get(ref);
        if (oid === undefined) return reply(res, 404, { message: 'Not Found' }), true;
        return reply(res, 200, { ref, node_id: encodeGlobalId('Ref', `${repo.id}:${ref}`), url: `/api/v3/repos/${repo.fullName}/git/refs/${ref.slice(5)}`, object: { sha: oid, type: repo.objects.get(oid)?.type ?? 'commit', url: `/api/v3/repos/${repo.fullName}/git/commits/${oid}` } }), true;
      }
      return reply(res, 405, { message: 'Method Not Allowed' }), true;
    }

    // -- branches ---------------------------------------------------------------
    if (tail[0] === 'branches') {
      if (method !== 'GET') return reply(res, 405, { message: 'Method Not Allowed' }), true;
      if (tail.length === 1) {
        const branches = [...repo.refs.keys()]
          .filter((ref) => ref.startsWith('refs/heads/'))
          .sort()
          .map((ref) => branchJson(ref.slice('refs/heads/'.length), repo.refs.get(ref) as string));
        return listReply(req, res, branches, query), true;
      }
      if (tail.length === 2) {
        const branch = tail[1] as string;
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (sha === undefined) return reply(res, 404, { message: 'Not Found' }), true;
        return reply(res, 200, branchJson(branch, sha)), true;
      }
      return reply(res, 404, { message: 'Not Found' }), true;
    }

    // -- commits ----------------------------------------------------------------
    if (tail[0] === 'commits' && tail.length === 1) {
      if (method !== 'GET') return reply(res, 405, { message: 'Method Not Allowed' }), true;
      const tip = resolveRef(repo, query.get('sha'));
      if (tip === null) return reply(res, 200, []), true;
      const seen = new Set<string>();
      const ordered: string[] = [];
      const queue = [tip];
      while (queue.length > 0) {
        const oid = queue.shift() as string;
        if (seen.has(oid)) continue;
        seen.add(oid);
        const object = repo.objects.get(oid);
        if (!object || object.type !== 'commit') continue;
        ordered.push(oid);
        for (const parent of parseCommit(object.data).parents) queue.push(parent);
      }
      const list = ordered.map((oid) => commitJson(repo, oid)).filter((entry): entry is Record<string, unknown> => entry !== null);
      return listReply(req, res, list, query), true;
    }

    // -- contents ---------------------------------------------------------------
    if (tail[0] === 'contents') {
      const path = tail.slice(1).join('/');
      if (method === 'GET') {
        const tip = resolveRef(repo, query.get('ref'));
        if (tip === null) return reply(res, 404, { message: 'Not Found' }), true;
        const flat = commitFlatTree(repo, tip);
        if (path === '') {
          const entries = directoryListing(repo, flat, '');
          return reply(res, 200, entries), true;
        }
        const entry = flat.get(path);
        if (entry) {
          const blob = repo.objects.get(entry.oid);
          const bytes = blob?.type === 'blob' ? blob.data : Buffer.alloc(0);
          return reply(res, 200, {
            type: 'file',
            encoding: 'base64',
            size: bytes.length,
            name: path.split('/').pop() ?? path,
            path,
            content: bytes.toString('base64'),
            sha: entry.oid,
            url: `/api/v3/repos/${repo.fullName}/contents/${path}`,
            git_url: `/api/v3/repos/${repo.fullName}/git/blobs/${entry.oid}`,
            html_url: `https://github.com/${repo.fullName}/blob/${repo.defaultBranch}/${path}`,
            download_url: `/api/v3/repos/${repo.fullName}/contents/${path}?ref=${encodeURIComponent(query.get('ref') ?? repo.defaultBranch)}`,
          }), true;
        }
        const dirPrefix = `${path}/`;
        const hasChildren = [...flat.keys()].some((key) => key.startsWith(dirPrefix));
        if (!hasChildren) return reply(res, 404, { message: 'Not Found' }), true;
        return reply(res, 200, directoryListing(repo, flat, path)), true;
      }
      if (method === 'PUT') {
        const body = await readJson();
        if (body === null) return badJson(), true;
        const message = typeof body.message === 'string' ? body.message : 'Update file';
        const contentB64 = typeof body.content === 'string' ? body.content : '';
        const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
        const givenSha = typeof body.sha === 'string' ? body.sha : null;
        let content: Buffer;
        try {
          content = Buffer.from(contentB64, 'base64');
        } catch {
          return reply(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Content', code: 'custom', field: 'content', message: 'content is not valid base64' }] }), true;
        }
        let tip = repo.refs.get(`refs/heads/${branch}`);
        if (tip === undefined) {
          const defaultTip = repo.defaultTip();
          if (defaultTip !== null) {
            store.setRef(repo, `refs/heads/${branch}`, defaultTip);
            tip = defaultTip;
          }
        }
        const flat = tip === undefined ? new Map() : commitFlatTree(repo, tip);
        const existing = flat.get(path);
        if (givenSha !== null) {
          if (existing === undefined || existing.oid !== givenSha) {
            return reply(res, 409, { message: 'Conflict: sha does not match the current file' }), true;
          }
        } else if (existing !== undefined) {
          return reply(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Content', code: 'custom', field: 'sha', message: 'sha is required to update an existing file' }] }), true;
        }
        const blobOid = hashObject('blob', content);
        store.putObjects(repo, [{ type: 'blob', data: content }]);
        flat.set(path, { oid: blobOid, mode: '100644' });
        const commitOid = commitFlatTreeToBranch(store, repo, branch, flat, message);
        const fileJson = {
          type: 'file',
          encoding: 'base64',
          size: content.length,
          name: path.split('/').pop() ?? path,
          path,
          content: content.toString('base64'),
          sha: blobOid,
          url: `/api/v3/repos/${repo.fullName}/contents/${path}`,
          git_url: `/api/v3/repos/${repo.fullName}/git/blobs/${blobOid}`,
          html_url: `https://github.com/${repo.fullName}/blob/${branch}/${path}`,
          download_url: `/api/v3/repos/${repo.fullName}/contents/${path}`,
        };
        return reply(res, existing === undefined ? 201 : 200, {
          content: fileJson,
          commit: { sha: commitOid, node_id: encodeGlobalId('Commit', commitOid), message, url: `/api/v3/repos/${repo.fullName}/commits/${commitOid}` },
        }), true;
      }
      if (method === 'DELETE') {
        const body = await readJson();
        if (body === null) return badJson(), true;
        const message = typeof body.message === 'string' ? body.message : 'Delete file';
        const givenSha = typeof body.sha === 'string' ? body.sha : null;
        const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
        const tip = repo.refs.get(`refs/heads/${branch}`);
        if (tip === undefined) return reply(res, 404, { message: 'Not Found' }), true;
        const flat = commitFlatTree(repo, tip);
        const existing = flat.get(path);
        if (existing === undefined) return reply(res, 404, { message: 'Not Found' }), true;
        if (givenSha !== null && existing.oid !== givenSha) {
          return reply(res, 409, { message: 'Conflict: sha does not match the current file' }), true;
        }
        flat.delete(path);
        const commitOid = commitFlatTreeToBranch(store, repo, branch, flat, message);
        return reply(res, 200, { commit: { sha: commitOid, node_id: encodeGlobalId('Commit', commitOid), message, url: `/api/v3/repos/${repo.fullName}/commits/${commitOid}` } }), true;
      }
      return reply(res, 405, { message: 'Method Not Allowed' }), true;
    }

    // -- labels -----------------------------------------------------------------
    if (tail[0] === 'labels') {
      if (method === 'GET' && tail.length === 1) {
        return listReply(req, res, [...repo.labels.values()].map((label) => labelJson(repo, label)), query), true;
      }
      if (method === 'POST' && tail.length === 1) {
        const body = await readJson();
        if (body === null) return badJson(), true;
        const name = typeof body.name === 'string' ? body.name : '';
        const color = typeof body.color === 'string' ? body.color.replace(/^#/, '').toLowerCase() : 'ededed';
        const description = typeof body.description === 'string' ? body.description : '';
        if (name === '') return reply(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Label', code: 'custom', field: 'name', message: 'name is required' }] }), true;
        if (repo.labels.has(name)) {
          return reply(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Label', code: 'custom', field: 'name', message: 'already exists' }] }), true;
        }
        const label: Label = { name, color, description };
        store.upsertLabel(repo, label);
        return reply(res, 201, labelJson(repo, label)), true;
      }
      return reply(res, 405, { message: 'Method Not Allowed' }), true;
    }

    // -- issues -----------------------------------------------------------------
    if (tail[0] === 'issues') {
      if (tail.length === 1) {
        if (method === 'POST') {
          const body = await readJson();
          if (body === null) return badJson(), true;
          const title = typeof body.title === 'string' ? body.title : '';
          const issueBody = typeof body.body === 'string' ? body.body : '';
          const labelNames = Array.isArray(body.labels) ? (body.labels as unknown[]).filter((x): x is string => typeof x === 'string') : [];
          if (title === '') return reply(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Issue', code: 'custom', field: 'title', message: 'title is required' }] }), true;
          const labels: Label[] = [];
          for (const labelName of labelNames) {
            const label = repo.labels.get(labelName);
            if (!label) return reply(res, 422, { message: `Validation Failed: label "${labelName}" does not exist`, errors: [{ resource: 'Issue', code: 'custom', field: 'labels', message: `label "${labelName}" does not exist` }] }), true;
            labels.push(label);
          }
          const issue = createIssueRecord(store, repo, title, issueBody, labels);
          return reply(res, 201, issueJson(repo, issue)), true;
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const direction = query.get('direction') ?? 'desc';
          let list = [...repo.issues.values()];
          if (state !== 'all') list = list.filter((issue) => issue.state === state);
          list.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
          return listReply(req, res, list.map((issue) => issueJson(repo, issue)), query), true;
        }
        return reply(res, 405, { message: 'Method Not Allowed' }), true;
      }
      const issueNumber = parseInt(tail[1] as string, 10);
      const issue = Number.isFinite(issueNumber) ? repo.issues.get(issueNumber) : undefined;
      if (issue === undefined) return reply(res, 404, { message: 'Not Found' }), true;
      if (tail.length === 2) {
        if (method === 'GET') return reply(res, 200, issueJson(repo, issue)), true;
        if (method === 'PATCH') {
          const body = await readJson();
          if (body === null) return badJson(), true;
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          if (body.state === 'open' || body.state === 'closed') {
            issue.state = body.state;
            issue.closedAt = body.state === 'closed' ? nowIso() : null;
          }
          if (Array.isArray(body.labels)) {
            const labels: Label[] = [];
            for (const labelName of body.labels as unknown[]) {
              if (typeof labelName !== 'string') continue;
              const label = repo.labels.get(labelName);
              if (!label) return reply(res, 422, { message: `Validation Failed: label "${labelName}" does not exist` }), true;
              labels.push(label);
            }
            issue.labels = labels;
          }
          issue.updatedAt = nowIso();
          store.upsertIssue(repo, issue);
          return reply(res, 200, issueJson(repo, issue)), true;
        }
        return reply(res, 405, { message: 'Method Not Allowed' }), true;
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        if (method === 'GET') {
          return listReply(req, res, issue.comments.map((comment) => commentJson(repo, issue, comment)), query), true;
        }
        if (method === 'POST') {
          const body = await readJson();
          if (body === null) return badJson(), true;
          const commentBody = typeof body.body === 'string' ? body.body : '';
          if (commentBody === '') return reply(res, 422, { message: 'Validation Failed', errors: [{ resource: 'IssueComment', code: 'custom', field: 'body', message: 'body is required' }] }), true;
          const comment = addCommentRecord(store, repo, issue, commentBody);
          return reply(res, 201, commentJson(repo, issue, comment)), true;
        }
        return reply(res, 405, { message: 'Method Not Allowed' }), true;
      }
      return reply(res, 404, { message: 'Not Found' }), true;
    }

    // -- pulls ------------------------------------------------------------------
    if (tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (method === 'POST') {
          const body = await readJson();
          if (body === null) return badJson(), true;
          const title = typeof body.title === 'string' ? body.title : '';
          const pullBody = typeof body.body === 'string' ? body.body : '';
          const head = typeof body.head === 'string' ? body.head : '';
          const base = typeof body.base === 'string' ? body.base : '';
          if (title === '' || head === '' || base === '') {
            return reply(res, 422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'custom', field: 'title', message: 'title, head and base are required' }] }), true;
          }
          const headSha = repo.refs.get(`refs/heads/${head}`);
          const baseSha = repo.refs.get(`refs/heads/${base}`);
          if (headSha === undefined || baseSha === undefined) {
            return reply(res, 422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'custom', field: 'head', message: 'head or base branch does not exist' }] }), true;
          }
          for (const existing of repo.pulls.values()) {
            if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
              return reply(res, 422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'custom', field: 'head', message: 'a pull request already exists for this head and base' }] }), true;
            }
          }
          const pull = createPullRecord(store, repo, title, pullBody, head, base);
          return reply(res, 201, pullJson(repo, pull)), true;
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          let list = [...repo.pulls.values()];
          if (state !== 'all') list = list.filter((pull) => pull.state === state);
          list.sort((a, b) => b.createdSeq - a.createdSeq);
          return listReply(req, res, list.map((pull) => pullJson(repo, pull)), query), true;
        }
        return reply(res, 405, { message: 'Method Not Allowed' }), true;
      }
      const pullNumber = parseInt(tail[1] as string, 10);
      const pull = Number.isFinite(pullNumber) ? repo.pulls.get(pullNumber) : undefined;
      if (pull === undefined) return reply(res, 404, { message: 'Not Found' }), true;
      if (tail.length === 2) {
        if (method === 'GET') return reply(res, 200, pullJson(repo, pull)), true;
        return reply(res, 405, { message: 'Method Not Allowed' }), true;
      }
      if (tail.length === 3 && tail[2] === 'files') {
        if (method !== 'GET') return reply(res, 405, { message: 'Method Not Allowed' }), true;
        const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
        const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
        const baseFlat = baseTip ? commitFlatTree(repo, baseTip) : new Map();
        const headFlat = headTip ? commitFlatTree(repo, headTip) : new Map();
        const changes = diffFlatTrees(repo, baseFlat, headFlat);
        const files = changes.map((change) => ({
          sha: change.newOid ?? change.oldOid ?? '',
          filename: change.path,
          status: change.status === 'removed' ? 'changed' : change.status,
          additions: change.additions,
          deletions: change.deletions,
          changes: change.additions + change.deletions,
          blob_url: `https://github.com/${repo.fullName}/blob/${pull.headSha}/${change.path}`,
          raw_url: `/api/v3/repos/${repo.fullName}/contents/${change.path}`,
          contents_url: `/api/v3/repos/${repo.fullName}/contents/${change.path}`,
          patch: '',
        }));
        return listReply(req, res, files, query), true;
      }
      if (tail.length === 3 && tail[2] === 'merge') {
        if (method !== 'PUT') return reply(res, 405, { message: 'Method Not Allowed' }), true;
        const body = await readJson();
        if (body === null) return badJson(), true;
        const message = typeof body.commit_message === 'string' && body.commit_message !== ''
          ? body.commit_message
          : `Merge pull request #${pull.number} from ${pull.headRef}`;
        const result = performSquashMerge(store, repo, pull, message);
        if (!result.ok) {
          return reply(res, 405, { message: result.reason }), true;
        }
        return reply(res, 200, { sha: result.sha, merged: true, message }), true;
      }
      return reply(res, 404, { message: 'Not Found' }), true;
    }

    return reply(res, 404, { message: 'Not Found' }), true;
  }

  return reply(res, 404, { message: 'Not Found' }), true;
}

/** The directory listing for one tree level: files and subdirectories, by name. */
function directoryListing(
  repo: Repo,
  flat: ReadonlyMap<string, { oid: string; mode: string }>,
  dir: string,
): Array<Record<string, unknown>> {
  const prefix = dir === '' ? '' : `${dir}/`;
  const entries = new Map<string, { type: 'file' | 'dir'; oid: string; size: number }>();
  for (const [path, value] of flat) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      entries.set(rest, { type: 'file', oid: value.oid, size: repo.objects.get(value.oid)?.data.length ?? 0 });
    } else {
      const name = rest.slice(0, slash);
      if (!entries.has(name)) entries.set(name, { type: 'dir', oid: '', size: 0 });
    }
  }
  // A directory's sha is its tree oid: rebuild it from the flat map when needed.
  const dirTreeOid = (name: string): string => {
    const subPrefix = `${prefix}${name}/`;
    const subFlat = new Map<string, { oid: string; mode: string }>();
    for (const [path, value] of flat) {
      if (path.startsWith(subPrefix)) subFlat.set(path.slice(subPrefix.length), value);
    }
    const created: GitObject[] = [];
    return buildTreeFromFlat(repo, subFlat, created);
  };
  return [...entries.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([name, entry]) => {
      const path = prefix === '' ? name : `${prefix}${name}`;
      const sha = entry.type === 'dir' ? dirTreeOid(name) : entry.oid;
      return {
        type: entry.type,
        size: entry.size,
        name,
        path,
        sha,
        url: `/api/v3/repos/${repo.fullName}/contents/${path}`,
        git_url: `/api/v3/repos/${repo.fullName}/git/${entry.type === 'dir' ? 'trees' : 'blobs'}/${sha}`,
        html_url: `https://github.com/${repo.fullName}/tree/${repo.defaultBranch}/${path}`,
        download_url: entry.type === 'file' ? `/api/v3/repos/${repo.fullName}/contents/${path}` : null,
      };
    });
}
