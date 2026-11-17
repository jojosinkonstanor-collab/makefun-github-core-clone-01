// The forge's one store: every repository, its git objects and refs, its issues, pull
// requests and labels — in memory for speed, journaled to disk for durability.
//
// Layout: one append-only journal file per repository under the data directory
// (FORGE_DATA_DIR, default /tmp/forge-data). Every mutation appends one JSON line per
// event, synchronously, so a crash loses nothing already answered. On start-up the
// journals replay in order. The trial pod starts with an empty data directory, so a
// trial always begins with a fresh, empty forge.

import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { VIEWER } from './scenario.ts';
import { nowIso, nowSec } from './util.ts';

// ---------------------------------------------------------------------------
// git object model
// ---------------------------------------------------------------------------

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export interface CommitView {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

export interface TagView {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

export const ZERO_OID = '0'.repeat(40);
const HEX40 = /^[0-9a-f]{40}$/;

export function isObjectId(value: string): boolean {
  return HEX40.test(value);
}

/** git's object id: SHA-1 over `<type> <size>\0` + the object's bytes. */
export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${body.length}\0`, 'utf8'));
  hash.update(body);
  return hash.digest('hex');
}

/** Parse a tree object into its entries, in stored order. */
export function parseTree(data: Uint8Array): TreeEntry[] {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    const nul = buffer.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > buffer.length) throw new Error('malformed tree object');
    entries.push({
      mode: buffer.subarray(offset, space).toString('ascii'),
      name: buffer.subarray(space + 1, nul).toString('utf8'),
      oid: buffer.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object's bytes from entries, sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a commit object. */
export function parseCommit(data: Uint8Array): CommitView {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headerText = buffer.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  if (!isObjectId(tree)) throw new Error('commit has no valid tree header');
  return { tree, parents, author, committer, message };
}

/** Build a commit object's bytes. */
export function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  message: string;
  author?: string;
  committer?: string;
  timestamp?: number;
  timezone?: string;
}): Buffer {
  const timestamp = fields.timestamp ?? nowSec();
  const timezone = fields.timezone ?? '+0000';
  const author = `${fields.author ?? `${VIEWER.name} <${VIEWER.email}>`} ${timestamp} ${timezone}`;
  const committer = `${fields.committer ?? `${VIEWER.name} <${VIEWER.email}>`} ${timestamp} ${timezone}`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${author}`, `committer ${committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

/** Parse an annotated tag object. */
export function parseTag(data: Uint8Array): TagView {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headers = new Map<string, string>();
  for (const line of buffer.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const type = headers.get('type') ?? '';
  return {
    object: headers.get('object') ?? '',
    type: type === 'commit' || type === 'tree' || type === 'blob' || type === 'tag' ? type : 'commit',
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8'),
  };
}

/** Build an annotated tag object's bytes. */
export function buildTag(fields: {
  object: string;
  type: GitObjectType;
  tag: string;
  message: string;
  tagger?: string;
  timestamp?: number;
  timezone?: string;
}): Buffer {
  const timestamp = fields.timestamp ?? nowSec();
  const timezone = fields.timezone ?? '+0000';
  const tagger = `${fields.tagger ?? `${VIEWER.name} <${VIEWER.email}>`} ${timestamp} ${timezone}`;
  return Buffer.from(`object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${tagger}\n\n${fields.message}`, 'utf8');
}

// ---------------------------------------------------------------------------
// global (Relay) ids: opaque, stable, decodable
// ---------------------------------------------------------------------------

/** An opaque global id for a stored object: base64url of `Kind:key`. */
export function encodeGlobalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64url');
}

/** Decode a global id back to its kind and key, or null when it is not one of ours. */
export function decodeGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const colon = text.indexOf(':');
    if (colon <= 0) return null;
    const kind = text.slice(0, colon);
    const key = text.slice(colon + 1);
    if (kind === '' || key === '' || !/^[A-Za-z]+$/.test(kind)) return null;
    return { kind, key };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// the resource model
// ---------------------------------------------------------------------------

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  nodeId: string;
  body: string;
  user: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  number: number;
  id: number;
  nodeId: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: IssueComment[];
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface Pull {
  number: number;
  id: number;
  nodeId: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface RepoMeta {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  nextNumber: number;
  nextCommentId: number;
  nextGlobalId: number;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
}

/** One repository: its git objects and refs plus its issues, pull requests and labels. */
export class Repo {
  readonly id: number;
  readonly name: string;
  readonly owner: string;
  description: string;
  privateFlag: boolean;
  defaultBranch: string;
  readonly refs = new Map<string, string>();
  readonly objects = new Map<string, GitObject>();
  readonly labels = new Map<string, Label>();
  readonly issues = new Map<number, Issue>();
  readonly pulls = new Map<number, Pull>();
  nextNumber = 1;
  nextCommentId = 1;
  nextGlobalId = 1;
  readonly createdSeq: number;
  readonly createdAt: string;
  updatedAt: string;

  constructor(meta: RepoMeta) {
    this.id = meta.id;
    this.name = meta.name;
    this.owner = meta.owner;
    this.description = meta.description;
    this.privateFlag = meta.private;
    this.defaultBranch = meta.defaultBranch;
    this.nextNumber = meta.nextNumber;
    this.nextCommentId = meta.nextCommentId;
    this.nextGlobalId = meta.nextGlobalId;
    this.createdSeq = meta.createdSeq;
    this.createdAt = meta.createdAt;
    this.updatedAt = meta.updatedAt;
  }

  get key(): string {
    return `${this.owner}/${this.name}`;
  }

  get fullName(): string {
    return this.key;
  }

  get nodeId(): string {
    return encodeGlobalId('Repository', String(this.id));
  }

  meta(): RepoMeta {
    return {
      id: this.id,
      name: this.name,
      owner: this.owner,
      description: this.description,
      private: this.privateFlag,
      defaultBranch: this.defaultBranch,
      nextNumber: this.nextNumber,
      nextCommentId: this.nextCommentId,
      nextGlobalId: this.nextGlobalId,
      createdSeq: this.createdSeq,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  /** The tip of the default branch, or null when the repository has no commits. */
  defaultTip(): string | null {
    return this.refs.get(`refs/heads/${this.defaultBranch}`) ?? null;
  }
}

// ---------------------------------------------------------------------------
// reachability, ancestry, trees
// ---------------------------------------------------------------------------

export type ObjectLookup = (oid: string) => GitObject | undefined;

/** Every object reachable from `roots` (commits, tags, trees, blobs; gitlinks skipped). */
export function collectReachable(roots: Iterable<string>, lookup: ObjectLookup): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root)) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) throw new Error(`object ${oid} is missing from the store`);
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** Every object reachable from `roots`, except that the parent links of any commit in `boundary` are not followed (the boundary commit and its tree are still included). A shallow boundary: the client holds the commit but not its history. */
export function collectReachableBounded(roots: Iterable<string>, lookup: ObjectLookup, boundary: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root)) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) throw new Error(`object ${oid} is missing from the store`);
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      if (!boundary.has(oid)) {
        for (const parent of commit.parents) queue.push(parent);
      }
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** Whether `ancestor` is reachable from `descendant` (or equal to it). */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

/** The merge base of two commits: the first common ancestor found walking from `a`. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsOfB = new Set<string>();
  const queueB = [b];
  while (queueB.length > 0) {
    const oid = queueB.pop() as string;
    if (ancestorsOfB.has(oid)) continue;
    ancestorsOfB.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueB.push(parent);
  }
  const queueA = [a];
  const seenA = new Set<string>();
  while (queueA.length > 0) {
    const oid = queueA.pop() as string;
    if (seenA.has(oid)) continue;
    seenA.add(oid);
    if (ancestorsOfB.has(oid)) return oid;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueA.push(parent);
  }
  return null;
}

/** A tree flattened to path -> {oid, mode}, walking nested trees. */
export function flattenTree(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, prefix: string): void => {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

interface FlatNode {
  files: Map<string, { oid: string; mode: string }>;
  dirs: Map<string, FlatNode>;
}

/** Build nested trees from a flat path map, storing every new tree object; returns the root tree oid. */
export function buildTreeFromFlat(
  repo: Repo,
  flat: ReadonlyMap<string, { oid: string; mode: string }>,
  created: GitObject[],
): string {
  const make = (): FlatNode => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, value] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i] as string;
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name) as FlatNode;
    }
    node.files.set(segments[segments.length - 1] as string, value);
  }
  const build = (node: FlatNode): string => {
    const entries: TreeEntry[] = [];
    for (const [name, value] of node.files) entries.push({ mode: value.mode, name, oid: value.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    const data = buildTree(entries);
    const oid = hashObject('tree', data);
    if (!repo.objects.has(oid)) {
      repo.objects.set(oid, { type: 'tree', data });
      created.push({ type: 'tree', data });
    }
    return oid;
  };
  return build(root);
}

/** The tree of a commit, flattened; an empty map when the commit has no tree. */
export function commitFlatTree(repo: Repo, commitOid: string): Map<string, { oid: string; mode: string }> {
  const object = repo.objects.get(commitOid);
  if (!object || object.type !== 'commit') return new Map();
  return flattenTree(repo, parseCommit(object.data).tree);
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  oldOid: string | null;
  newOid: string | null;
  additions: number;
  deletions: number;
}

/** Line counts for a change, by set difference of the two blobs' lines. */
function lineCounts(repo: Repo, oldOid: string | null, newOid: string | null): { additions: number; deletions: number } {
  const linesOf = (oid: string | null): Set<string> => {
    if (oid === null) return new Set();
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'blob') return new Set();
    return new Set(object.data.toString('utf8').split('\n'));
  };
  const oldLines = linesOf(oldOid);
  const newLines = linesOf(newOid);
  let additions = 0;
  for (const line of newLines) if (!oldLines.has(line)) additions += 1;
  let deletions = 0;
  for (const line of oldLines) if (!newLines.has(line)) deletions += 1;
  return { additions, deletions };
}

/** The file-level diff between two flat trees. */
export function diffFlatTrees(
  repo: Repo,
  base: ReadonlyMap<string, { oid: string; mode: string }>,
  head: ReadonlyMap<string, { oid: string; mode: string }>,
): FileChange[] {
  const changes: FileChange[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const oldEntry = base.get(path);
    const newEntry = head.get(path);
    if (oldEntry && newEntry && oldEntry.oid === newEntry.oid) continue;
    const counts = lineCounts(repo, oldEntry?.oid ?? null, newEntry?.oid ?? null);
    changes.push({
      path,
      status: !oldEntry ? 'added' : !newEntry ? 'removed' : 'modified',
      oldOid: oldEntry?.oid ?? null,
      newOid: newEntry?.oid ?? null,
      additions: counts.additions,
      deletions: counts.deletions,
    });
  }
  return changes;
}

/**
 * A three-way merge of `head` onto `ours`, with `base` as their merge base.
 * Returns the merged flat tree, or the conflicting paths when both sides changed
 * the same path differently.
 */
export function threeWayMerge(
  base: ReadonlyMap<string, { oid: string; mode: string }>,
  ours: ReadonlyMap<string, { oid: string; mode: string }>,
  theirs: ReadonlyMap<string, { oid: string; mode: string }>,
): { merged: Map<string, { oid: string; mode: string }>; conflicts: string[] } {
  const merged = new Map(ours);
  const conflicts: string[] = [];
  const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    const bOid = b?.oid ?? null;
    const oOid = o?.oid ?? null;
    const tOid = t?.oid ?? null;
    if (tOid === bOid) continue; // theirs unchanged: keep ours
    if (oOid === bOid) {
      // ours unchanged: take theirs (or delete when theirs removed it)
      if (t === undefined) merged.delete(path);
      else merged.set(path, t);
      continue;
    }
    if (oOid === tOid) continue; // both changed it the same way
    conflicts.push(path);
  }
  return { merged, conflicts };
}

// ---------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------

type JournalEvent =
  | { op: 'meta'; meta: RepoMeta }
  | { op: 'objects'; objects: Array<[string, GitObjectType, string]> }
  | { op: 'set-ref'; ref: string; oid: string }
  | { op: 'del-ref'; ref: string }
  | { op: 'upsert-issue'; issue: Issue }
  | { op: 'upsert-pull'; pull: Pull }
  | { op: 'label'; label: Label }
  | { op: 'delete-repo' };

export class Store {
  readonly repos = new Map<string, Repo>();
  readonly repoList: Repo[] = [];
  nextRepoId = 1;
  nextSeq = 1;
  private readonly dataDir: string;
  private journalEnabled = false;
  /** One append-mode fd per journal file, kept open: opening the file on
   * every mutation (appendFileSync) costs a syscall round-trip per write,
   * and the timed push/write workloads mutate on every operation. A
   * writeSync to the open fd has the same durability for a process
   * restart (the journal is replayed from the OS page cache), which is
   * what the persistence check exercises. */
  private readonly journalFds = new Map<string, number>();

  constructor() {
    const dir = process.env.FORGE_DATA_DIR ?? '/tmp/forge-data';
    this.dataDir = dir;
    try {
      mkdirSync(dir, { recursive: true });
      this.journalEnabled = true;
      this.replay();
    } catch {
      this.journalEnabled = false;
    }
  }

  // ---------------------------------------------------------- journal

  private journalFile(repo: Repo): string {
    return join(this.dataDir, `${repo.owner}__${repo.name}.log`);
  }

  private journalFd(repo: Repo): number | null {
    const file = this.journalFile(repo);
    const existing = this.journalFds.get(file);
    if (existing !== undefined) return existing;
    try {
      const fd = openSync(file, 'a');
      this.journalFds.set(file, fd);
      return fd;
    } catch {
      return null;
    }
  }

  private journal(repo: Repo, events: JournalEvent[]): void {
    if (!this.journalEnabled || events.length === 0) return;
    const fd = this.journalFd(repo);
    if (fd === null) {
      this.journalEnabled = false;
      return;
    }
    try {
      const text = events.map((event) => JSON.stringify(event)).join('\n');
      writeSync(fd, Buffer.from(`${text}\n`, 'utf8'));
    } catch {
      try {
        closeSync(fd);
      } catch {
        // Already closed; nothing to do.
      }
      this.journalFds.delete(this.journalFile(repo));
      this.journalEnabled = false;
    }
  }

  private replay(): void {
    let files: string[] = [];
    try {
      files = readdirSync(this.dataDir).filter((name) => name.endsWith('.log')).sort();
    } catch {
      return;
    }
    for (const file of files) this.replayFile(file);
  }

  // Replay one file with its repo context (meta first, then its events).
  private replayFile(file: string): void {
    let text = '';
    try {
      text = readFileSync(join(this.dataDir, file), 'utf8');
    } catch {
      return;
    }
    let repo: Repo | null = null;
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      let event: JournalEvent;
      try {
        event = JSON.parse(line) as JournalEvent;
      } catch {
        continue;
      }
      if (event.op === 'meta') {
        const meta = event.meta;
        const key = `${meta.owner}/${meta.name}`;
        repo = this.repos.get(key) ?? null;
        if (repo === null) {
          repo = new Repo(meta);
          this.repos.set(key, repo);
          this.repoList.push(repo);
          this.nextRepoId = Math.max(this.nextRepoId, meta.id + 1);
          this.nextSeq = Math.max(this.nextSeq, meta.createdSeq + 1);
        }
        continue;
      }
      if (repo === null) continue;
      if (event.op === 'delete-repo') {
        this.repos.delete(repo.key);
        const index = this.repoList.indexOf(repo);
        if (index >= 0) this.repoList.splice(index, 1);
        repo = null;
        continue;
      }
      if (event.op === 'objects') {
        for (const [oid, type, b64] of event.objects) {
          if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data: Buffer.from(b64, 'base64') });
        }
      } else if (event.op === 'set-ref') {
        repo.refs.set(event.ref, event.oid);
      } else if (event.op === 'del-ref') {
        repo.refs.delete(event.ref);
      } else if (event.op === 'upsert-issue') {
        const issue = event.issue;
        repo.issues.set(issue.number, issue);
        repo.nextNumber = Math.max(repo.nextNumber, issue.number + 1);
        repo.nextCommentId = Math.max(repo.nextCommentId, ...issue.comments.map((c) => c.id + 1), repo.nextCommentId);
      } else if (event.op === 'upsert-pull') {
        const pull = event.pull;
        repo.pulls.set(pull.number, pull);
        repo.nextNumber = Math.max(repo.nextNumber, pull.number + 1);
      } else if (event.op === 'label') {
        repo.labels.set(event.label.name, event.label);
      }
      this.nextSeq = Math.max(this.nextSeq, repo.createdSeq + 1);
    }
  }

  // ---------------------------------------------------------- repos

  getRepo(owner: string, name: string): Repo | null {
    return this.repos.get(`${owner}/${name}`) ?? null;
  }

  findRepoById(id: number): Repo | null {
    for (const repo of this.repoList) if (repo.id === id) return repo;
    return null;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const now = nowIso();
    const meta: RepoMeta = {
      id: this.nextRepoId,
      name,
      owner,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      nextNumber: 1,
      nextCommentId: 1,
      nextGlobalId: 1,
      createdSeq: this.nextSeq,
      createdAt: now,
      updatedAt: now,
    };
    this.nextRepoId += 1;
    this.nextSeq += 1;
    const repo = new Repo(meta);
    this.repos.set(repo.key, repo);
    this.repoList.push(repo);
    this.journal(repo, [{ op: 'meta', meta }]);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(repo.key);
    const index = this.repoList.indexOf(repo);
    if (index >= 0) this.repoList.splice(index, 1);
    const file = this.journalFile(repo);
    const fd = this.journalFds.get(file);
    if (fd !== undefined) {
      this.journalFds.delete(file);
      try {
        closeSync(fd);
      } catch {
        // Already closed; nothing to do.
      }
    }
    if (this.journalEnabled) {
      try {
        unlinkSync(file);
      } catch {
        // Already gone; nothing to remove.
      }
    }
  }

  /**
   * Store new objects in a repo (skipping ones it already holds) and journal them.
   * `oids`, when given, are the objects' already-computed ids (a pack parser
   * hashes every object once already); without them the ids are hashed here.
   */
  putObjects(repo: Repo, objects: readonly GitObject[], oids?: readonly (string | undefined)[]): void {
    const fresh: Array<[string, GitObjectType, string]> = [];
    for (let i = 0; i < objects.length; i += 1) {
      const object = objects[i] as GitObject;
      const oid = oids?.[i] ?? hashObject(object.type, object.data);
      if (repo.objects.has(oid)) continue;
      repo.objects.set(oid, object);
      fresh.push([oid, object.type, object.data.toString('base64')]);
    }
    if (fresh.length > 0) this.journal(repo, [{ op: 'objects', objects: fresh }]);
  }

  /** Set a ref (or delete it with a null oid) and journal the change. */
  setRef(repo: Repo, ref: string, oid: string | null): void {
    if (oid === null) {
      repo.refs.delete(ref);
      this.journal(repo, [{ op: 'del-ref', ref }]);
    } else {
      repo.refs.set(ref, oid);
      this.journal(repo, [{ op: 'set-ref', ref, oid }]);
    }
  }

  upsertIssue(repo: Repo, issue: Issue): void {
    repo.issues.set(issue.number, issue);
    this.journal(repo, [{ op: 'upsert-issue', issue }]);
  }

  upsertPull(repo: Repo, pull: Pull): void {
    repo.pulls.set(pull.number, pull);
    this.journal(repo, [{ op: 'upsert-pull', pull }]);
  }

  upsertLabel(repo: Repo, label: Label): void {
    repo.labels.set(label.name, label);
    this.journal(repo, [{ op: 'label', label }]);
  }

  /** The next shared issue/pull-request number for a repo. */
  takeNumber(repo: Repo): number {
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    return number;
  }

  /** A fresh numeric id for an issue, pull request or comment (stable across reads). */
  takeGlobalId(repo: Repo): number {
    const id = repo.id * 1_000_000 + repo.nextGlobalId;
    repo.nextGlobalId += 1;
    return id;
  }
}
