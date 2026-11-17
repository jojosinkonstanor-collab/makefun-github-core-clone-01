// MCP over Streamable HTTP: JSON-RPC 2.0, plain JSON answers (no SSE needed).
//
// The modern era (2026-07-28): `server/discover` advertises the server and its
// tools, with serverInfo also under _meta["io.modelcontextprotocol/serverInfo"].
// The legacy `initialize` handshake is kept as a fallback. Tools act on the
// same store as REST and GraphQL, so a repository or issue created over MCP
// reads back over REST with the same ids.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { encodeGlobalId, type Repo, type Store } from './store.ts';
import { VIEWER } from './scenario.ts';
import { createIssueRecord, createPullRecord, performSquashMerge } from './rest.ts';
import { readBody, sendJson } from './util.ts';

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2026-07-28';

const SERVER_INFO = { name: SERVER_NAME, version: SERVER_VERSION };

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required: string[];
  };
}

/** The six tools, in a fixed order; the same bytes on every tools/list call. */
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by its owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner (login) of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The full name of the repository, owner/repo.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner (login) of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The full name of the repository, owner/repo.' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner (login) of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The full name of the repository, owner/repo.' },
        state: { type: 'string', description: 'The state to filter by: open, closed, or all.', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner (login) of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The full name of the repository, owner/repo.' },
        title: { type: 'string', description: 'The title of the pull request.' },
        body: { type: 'string', description: 'The body of the pull request.' },
        head: { type: 'string', description: 'The name of the branch with the changes.' },
        base: { type: 'string', description: 'The name of the branch to merge into.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner (login) of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The full name of the repository, owner/repo.' },
        pull_number: { type: 'number', description: 'The number of the pull request.' },
        number: { type: 'number', description: 'The number of the pull request.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

// ---------------------------------------------------------------------------
// tool implementations
// ---------------------------------------------------------------------------

type Args = Record<string, unknown>;

function repoOf(store: Store, args: Args): Repo {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repoName = typeof args.repo === 'string' ? args.repo : '';
  if ((owner === '' || repoName === '') && typeof args.full_name === 'string') {
    const [o, r] = (args.full_name as string).split('/');
    if (o !== undefined && r !== undefined) {
      owner = o;
      repoName = r;
    }
  }
  const repo = store.getRepo(owner, repoName);
  if (repo === null) throw new Error(`repository ${owner}/${repoName} not found`);
  return repo;
}

function repoSummary(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repo.nodeId,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: VIEWER.id },
    private: repo.privateFlag,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: `https://github.com/${repo.fullName}`,
    url: `/api/v3/repos/${repo.fullName}`,
    has_issues: true,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
  };
}

function callTool(store: Store, name: string, args: Args): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = typeof args.name === 'string' ? args.name : '';
      if (repoName === '') throw new Error('name is required');
      if (store.getRepo(VIEWER.login, repoName) !== null) throw new Error(`repository ${repoName} already exists`);
      const description = typeof args.description === 'string' ? args.description : '';
      const isPrivate = args.private === true;
      const repo = store.createRepo(VIEWER.login, repoName, description, isPrivate);
      return repoSummary(repo);
    }
    case 'get_repo': {
      return repoSummary(repoOf(store, args));
    }
    case 'create_issue': {
      const repo = repoOf(store, args);
      const title = typeof args.title === 'string' ? args.title : '';
      if (title === '') throw new Error('title is required');
      const body = typeof args.body === 'string' ? args.body : '';
      const issue = createIssueRecord(store, repo, title, body, []);
      return {
        id: issue.id,
        node_id: issue.nodeId,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        labels: [],
        url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
        html_url: `https://github.com/${repo.fullName}/issues/${issue.number}`,
        created_at: issue.createdAt,
        updated_at: issue.updatedAt,
      };
    }
    case 'list_issues': {
      const repo = repoOf(store, args);
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = [...repo.issues.values()];
      if (state !== 'all') list = list.filter((issue) => issue.state === state);
      list.sort((a, b) => b.createdSeq - a.createdSeq);
      return {
        total_count: list.length,
        issues: list.map((issue) => ({
          id: issue.id,
          node_id: issue.nodeId,
          number: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
          labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
          created_at: issue.createdAt,
          updated_at: issue.updatedAt,
        })),
      };
    }
    case 'create_pull_request': {
      const repo = repoOf(store, args);
      const title = typeof args.title === 'string' ? args.title : '';
      const head = typeof args.head === 'string' ? args.head : '';
      const base = typeof args.base === 'string' ? args.base : '';
      if (title === '' || head === '' || base === '') throw new Error('title, head and base are required');
      if (!repo.refs.has(`refs/heads/${head}`) || !repo.refs.has(`refs/heads/${base}`)) {
        throw new Error('head or base branch does not exist');
      }
      const existing = [...repo.pulls.values()].find(
        (pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base,
      );
      const body = typeof args.body === 'string' ? args.body : '';
      const pull = existing ?? createPullRecord(store, repo, title, body, head, base);
      return {
        id: pull.id,
        node_id: pull.nodeId,
        number: pull.number,
        title: pull.title,
        body: pull.body,
        state: pull.state,
        head: { ref: pull.headRef, sha: pull.headSha },
        base: { ref: pull.baseRef, sha: pull.baseSha },
        url: `/api/v3/repos/${repo.fullName}/pulls/${pull.number}`,
        html_url: `https://github.com/${repo.fullName}/pull/${pull.number}`,
        created_at: pull.createdAt,
        updated_at: pull.updatedAt,
      };
    }
    case 'merge_pull_request': {
      const repo = repoOf(store, args);
      const number = typeof args.pull_number === 'number' ? args.pull_number : typeof args.number === 'number' ? args.number : NaN;
      if (!Number.isFinite(number)) throw new Error('pull_number is required');
      const pull = repo.pulls.get(number);
      if (pull === undefined) throw new Error(`pull request ${number} not found`);
      const message = `Merge pull request #${pull.number} from ${pull.headRef}`;
      const result = performSquashMerge(store, repo, pull, message);
      if (!result.ok) throw new Error(result.reason);
      return {
        merged: true,
        sha: result.sha,
        message,
        pull_request: { number: pull.number, state: pull.state, merged: pull.merged, merge_commit_sha: result.sha },
      };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------

function rpcResult(id: unknown, result: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function authorized(req: IncomingMessage): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  if (!expected) return true;
  return (req.headers.authorization ?? '') === `Bearer ${expected}`;
}

/** Handle POST /mcp (and GET /mcp with 405); returns true when the path matched. */
export async function handleMcp(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  if (req.url !== '/mcp' && !req.url?.startsWith('/mcp?')) return false;
  if (req.method === 'GET') {
    sendJson(res, 405, rpcError(null, -32600, 'Method Not Allowed'));
    return true;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, rpcError(null, -32600, 'Method Not Allowed'));
    return true;
  }
  if (!authorized(req)) {
    sendJson(res, 401, rpcError(null, -32001, 'Unauthorized'));
    return true;
  }
  let body: unknown;
  try {
    const raw = await readBody(req);
    body = raw.length === 0 ? null : JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, rpcError(null, -32700, 'Parse error'));
    return true;
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    sendJson(res, 400, rpcError(null, -32600, 'Invalid Request'));
    return true;
  }
  const request = body as Record<string, unknown>;
  const id = request.id ?? null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (request.params ?? {}) as Record<string, unknown>;

  // A notification has no id: answer 202 with an empty body.
  if (id === null && (method === 'notifications/initialized' || method.startsWith('notifications/'))) {
    res.writeHead(202);
    res.end();
    return true;
  }

  if (method === 'server/discover') {
    const result = {
      supportedVersions: [PROTOCOL_VERSION, '2025-06-18', '2025-03-26'],
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
      _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
    };
    const envelope = rpcResult(id, result);
    (envelope as Record<string, unknown>)._meta = { 'io.modelcontextprotocol/serverInfo': SERVER_INFO };
    sendJson(res, 200, envelope);
    return true;
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION;
    const result = {
      protocolVersion: requested,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
      _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
    };
    sendJson(res, 200, rpcResult(id, result));
    return true;
  }
  if (method === 'ping') {
    sendJson(res, 200, rpcResult(id, {}));
    return true;
  }
  if (method === 'tools/list') {
    sendJson(res, 200, rpcResult(id, { tools: TOOLS }));
    return true;
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const toolArgs = (params.arguments ?? {}) as Args;
    const known = TOOLS.some((tool) => tool.name === toolName);
    if (!known) {
      sendJson(res, 200, rpcError(id, -32602, `Unknown tool: ${toolName}`));
      return true;
    }
    try {
      const output = callTool(store, toolName, toolArgs);
      const text = JSON.stringify(output);
      sendJson(res, 200, rpcResult(id, { content: [{ type: 'text', text }], structuredContent: output }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 200, rpcError(id, -32602, message));
    }
    return true;
  }
  sendJson(res, 200, rpcError(id, -32601, `Method not found: ${method}`));
  return true;
}
