// GraphQL v4 over the one store.
//
// A small, dependency-free GraphQL implementation: a lexer and recursive-descent
// parser for the documents the suite sends (variables, inline enums and input
// objects, aliases, inline fragments, named fragments, operation names, batched
// arrays), and an executor that walks the parsed selections against plain
// resolver objects built from the store. Unknown fields answer HTTP 200 with an
// `errors` array naming the field; an unknown repository answers
// `data.repository = null` with no errors.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  commitFlatTree,
  decodeGlobalId,
  diffFlatTrees,
  encodeGlobalId,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import { VIEWER } from './scenario.ts';
import { addCommentRecord, createIssueRecord, createPullRecord, mergeableState, performSquashMerge } from './rest.ts';
import { readJsonBody, sendJson } from './util.ts';

// ---------------------------------------------------------------------------
// lexer
// ---------------------------------------------------------------------------

type TokenKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';
interface Token {
  kind: TokenKind;
  value: string;
}

const PUNCT = new Set(['!', '$', '&', '(', ')', ':', '=', '@', '[', ']', '{', '|', '}']);

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const push = (kind: TokenKind, value: string): void => {
    tokens.push({ kind, value });
  };
  while (i < input.length) {
    const char = input[i] as string;
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === ',' || char === '\uFEFF') {
      i += 1;
      continue;
    }
    if (char === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (char === '.' && input.slice(i, i + 3) === '...') {
      push('punct', '...');
      i += 3;
      continue;
    }
    if (PUNCT.has(char)) {
      push('punct', char);
      i += 1;
      continue;
    }
    if (char === '"') {
      if (input.slice(i, i + 3) === '"""') {
        const end = input.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        push('string', input.slice(i + 3, end));
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < input.length) {
        const c = input[j] as string;
        if (c === '"') break;
        if (c === '\\') {
          const next = input[j + 1] as string;
          if (next === 'u') {
            value += String.fromCharCode(parseInt(input.slice(j + 2, j + 6), 16));
            j += 6;
            continue;
          }
          const escapes: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' };
          value += escapes[next] ?? next;
          j += 2;
          continue;
        }
        value += c;
        j += 1;
      }
      if (j >= input.length) throw new Error('unterminated string');
      push('string', value);
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(char)) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      let isFloat = false;
      if (input[j] === '.' && /[0-9]/.test(input[j + 1] as string)) {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      }
      push(isFloat ? 'float' : 'int', input.slice(i, j));
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(char)) {
      let j = i;
      while (j < input.length && /[_0-9A-Za-z]/.test(input[j] as string)) j += 1;
      push('name', input.slice(i, j));
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(char)} in GraphQL document`);
  }
  push('eof', '');
  return tokens;
}

// ---------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

export interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Record<string, ValueNode>;
  selections: SelectionNode[] | null;
}
export interface FragmentSpreadNode {
  kind: 'spread';
  name: string;
}
export interface InlineFragmentNode {
  kind: 'inline';
  typeCondition: string | null;
  selections: SelectionNode[];
}
export type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

export interface VarDef {
  name: string;
  defaultValue: ValueNode | null;
}
export interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation' | 'subscription';
  name: string | null;
  varDefs: VarDef[];
  selections: SelectionNode[];
}
export interface FragmentNode {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, got ${token.value}`);
    if (value !== undefined && token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
    return token.value;
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  parseDocument(): { operations: OperationNode[]; fragments: Map<string, FragmentNode> } {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({
          kind: 'operation',
          operation: 'query',
          name: null,
          varDefs: [],
          selections: this.parseSelectionSet(),
        });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(name, { kind: 'fragment', name, typeCondition, selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        const operation = this.next().value as 'query' | 'mutation' | 'subscription';
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        let varDefs: VarDef[] = [];
        if (this.peek().kind === 'punct' && this.peek().value === '(') varDefs = this.parseVariableDefinitions();
        this.skipDirectives();
        operations.push({ kind: 'operation', operation, name, varDefs, selections: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unexpected token ${token.value} in GraphQL document`);
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): VarDef[] {
    const defs: VarDef[] = [];
    this.expectPunct('(');
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.peek().kind === 'punct' && this.peek().value === '=') {
        this.next();
        defaultValue = this.parseValue(true);
      }
      this.skipDirectives();
      defs.push({ name, defaultValue });
    }
    this.expectPunct(')');
    return defs;
  }

  private parseType(): void {
    if (this.peek().kind === 'punct' && this.peek().value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      const next = this.peek();
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selections: this.parseSelectionSet() };
      }
      if (next.kind === 'name') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'spread', name };
      }
      this.skipDirectives();
      return { kind: 'inline', typeCondition: null, selections: this.parseSelectionSet() };
    }
    const name = this.expectName();
    let alias: string | null = null;
    let fieldName = name;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = name;
      fieldName = this.expectName();
    }
    let args: Record<string, ValueNode> = {};
    if (this.peek().kind === 'punct' && this.peek().value === '(') args = this.parseArguments();
    this.skipDirectives();
    let selections: SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === '{') selections = this.parseSelectionSet();
    return { kind: 'field', name: fieldName, alias, args, selections };
  }

  private parseArguments(): Record<string, ValueNode> {
    const args: Record<string, ValueNode> = {};
    this.expectPunct('(');
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args[name] = this.parseValue(false);
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(isConst: boolean): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      if (isConst) throw new Error('variable in constant value');
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue(isConst));
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields[name] = this.parseValue(isConst);
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'int') return { kind: 'int', value: parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.value}`);
  }
}

// ---------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------

type GqlSource = Record<string, unknown> & { __typename?: string };
type Resolver = (args: Record<string, unknown>, ctx: ExecContext) => unknown;

interface ExecContext {
  store: Store;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
  errors: Array<{ message: string }>;
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => resolveValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = resolveValue(value, variables);
      return out;
    }
  }
}

function resolveArgs(field: FieldNode, ctx: ExecContext): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(field.args)) args[key] = resolveValue(value, ctx.variables);
  return args;
}

function resolveSelections(source: GqlSource, selections: SelectionNode[], ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (!fragment) {
        ctx.errors.push({ message: `Unknown fragment "${selection.name}".` });
        continue;
      }
      if (fragment.typeCondition !== source.__typename && fragment.typeCondition !== undefined) continue;
      Object.assign(out, resolveSelections(source, fragment.selections, ctx));
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition !== null && selection.typeCondition !== source.__typename) continue;
      Object.assign(out, resolveSelections(source, selection.selections, ctx));
      continue;
    }
    const key = selection.alias ?? selection.name;
    out[key] = resolveField(source, selection, ctx);
  }
  return out;
}

function resolveField(source: GqlSource, field: FieldNode, ctx: ExecContext): unknown {
  const typename = source.__typename ?? 'Query';
  if (field.name === '__typename') return typename;
  const raw = source[field.name];
  if (raw === undefined) {
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typename}".` });
    return null;
  }
  let value: unknown;
  try {
    value = typeof raw === 'function' ? (raw as Resolver)(resolveArgs(field, ctx), ctx) : raw;
  } catch (err) {
    ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
    return null;
  }
  if (field.selections === null) return value;
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((item) =>
      item !== null && typeof item === 'object' ? resolveSelections(item as GqlSource, field.selections as SelectionNode[], ctx) : item,
    );
  }
  if (typeof value === 'object') return resolveSelections(value as GqlSource, field.selections, ctx);
  return value;
}

function executeOperation(
  operation: OperationNode,
  root: GqlSource,
  ctx: ExecContext,
): Record<string, unknown> {
  const variables: Record<string, unknown> = { ...ctx.variables };
  for (const def of operation.varDefs) {
    if (!(def.name in variables) || variables[def.name] === undefined) {
      if (def.defaultValue !== null) variables[def.name] = resolveValue(def.defaultValue, ctx.variables);
    }
  }
  const childCtx: ExecContext = { ...ctx, variables };
  const data = resolveSelections(root, operation.selections, childCtx);
  ctx.errors.push(...childCtx.errors);
  return data;
}

// ---------------------------------------------------------------------------
// cursors and connections
// ---------------------------------------------------------------------------

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : parseInt(match[1] as string, 10);
  } catch {
    return null;
  }
}

function connection<T>(
  items: readonly T[],
  args: Record<string, unknown>,
  toNode: (item: T) => GqlSource,
  typename: string,
): GqlSource {
  const first = typeof args.first === 'number' ? Math.max(0, args.first) : undefined;
  const after = typeof args.after === 'string' ? args.after : null;
  let start = 0;
  if (after !== null) {
    const decoded = decodeCursor(after);
    if (decoded !== null) start = decoded + 1;
  }
  const end = first === undefined ? items.length : Math.min(items.length, start + first);
  const slice = items.slice(start, end);
  const nodes = slice.map(toNode);
  const edges = slice.map((item, i) => ({ __typename: 'Edge', node: toNode(item), cursor: encodeCursor(start + i) }));
  return {
    __typename: typename,
    nodes,
    edges,
    totalCount: items.length,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: end < items.length,
      hasPreviousPage: start > 0,
      startCursor: edges.length > 0 ? (edges[0] as { cursor: string }).cursor : null,
      endCursor: edges.length > 0 ? (edges[edges.length - 1] as { cursor: string }).cursor : null,
    },
  };
}

// ---------------------------------------------------------------------------
// object builders
// ---------------------------------------------------------------------------

function viewerObject(): GqlSource {
  return {
    __typename: 'User',
    login: VIEWER.login,
    id: encodeGlobalId('User', String(VIEWER.id)),
    databaseId: VIEWER.id,
    name: VIEWER.name,
    email: VIEWER.email,
    url: `https://github.com/${VIEWER.login}`,
    avatarUrl: '',
  };
}

function labelObject(repo: Repo, name: string, color: string, description: string): GqlSource {
  return {
    __typename: 'Label',
    id: encodeGlobalId('Label', `${repo.id}:${name}`),
    name,
    color,
    description,
    url: `/api/v3/repos/${repo.fullName}/labels/${encodeURIComponent(name)}`,
  };
}

function commentObject(repo: Repo, issue: Issue, comment: Issue['comments'][number]): GqlSource {
  return {
    __typename: 'IssueComment',
    id: comment.nodeId,
    databaseId: repo.id * 1_000_000 + 900_000 + comment.id,
    body: comment.body,
    author: () => viewerObject(),
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    url: `https://github.com/${repo.fullName}/issues/${issue.number}#issuecomment-${comment.id}`,
  };
}

function issueObject(ctx: ExecContext, repo: Repo, issue: Issue): GqlSource {
  return {
    __typename: 'Issue',
    id: issue.nodeId,
    databaseId: issue.id,
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
    url: `https://github.com/${repo.fullName}/issues/${issue.number}`,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    closedAt: issue.closedAt,
    author: () => viewerObject(),
    repository: () => repositoryObject(ctx, repo),
    labels: (args: Record<string, unknown>) =>
      connection(
        issue.labels,
        args,
        (label) => labelObject(repo, label.name, label.color, label.description),
        'LabelConnection',
      ),
    comments: (args: Record<string, unknown>) =>
      connection(
        issue.comments,
        args,
        (comment) => commentObject(repo, issue, comment),
        'IssueCommentConnection',
      ),
  };
}

function sortedIssues(repo: Repo, args: Record<string, unknown>): Issue[] {
  let list = [...repo.issues.values()];
  if (Array.isArray(args.states) && args.states.length > 0) {
    const wanted = new Set((args.states as unknown[]).map((state) => String(state).toLowerCase()));
    list = list.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
  const direction = orderBy.direction === 'ASC' ? 1 : -1;
  list.sort((a, b) => (a.createdSeq - b.createdSeq) * direction || (a.number - b.number) * direction);
  return list;
}

function sortedPulls(repo: Repo, args: Record<string, unknown>): Pull[] {
  let list = [...repo.pulls.values()];
  if (Array.isArray(args.states) && args.states.length > 0) {
    const wanted = new Set((args.states as unknown[]).map((state) => String(state).toLowerCase()));
    list = list.filter((pull) => wanted.has(pull.state === 'open' ? 'open' : 'closed'));
  }
  const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
  const direction = orderBy.direction === 'ASC' ? 1 : -1;
  list.sort((a, b) => (a.createdSeq - b.createdSeq) * direction || (a.number - b.number) * direction);
  return list;
}

function flatOf(repo: Repo, oid: string | null | undefined): Map<string, { oid: string; mode: string }> {
  if (oid === null || oid === undefined) return new Map();
  return commitFlatTree(repo, oid);
}

function pullObject(ctx: ExecContext, repo: Repo, pull: Pull): GqlSource {
  return {
    __typename: 'PullRequest',
    id: pull.nodeId,
    databaseId: pull.id,
    number: pull.number,
    title: pull.title,
    state: pull.state === 'open' ? 'OPEN' : 'CLOSED',
    body: pull.body,
    merged: pull.merged,
    mergeable: () => mergeableState(repo, pull),
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    headRefOid: repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha,
    baseRefOid: repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha,
    url: `https://github.com/${repo.fullName}/pull/${pull.number}`,
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    closedAt: pull.closedAt,
    mergedAt: pull.mergedAt,
    mergeCommit: () =>
      pull.mergeCommitSha === null
        ? null
        : { __typename: 'Commit', oid: pull.mergeCommitSha, message: `Merge pull request #${pull.number}` },
    author: () => viewerObject(),
    repository: () => repositoryObject(ctx, repo),
    files: (args: Record<string, unknown>) => {
      const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
      const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
      const changes = diffFlatTrees(repo, flatOf(repo, baseTip), flatOf(repo, headTip));
      const nodes = changes.map((change) => ({
        __typename: 'PullRequestChangedFile',
        path: change.path,
        additions: change.additions,
        deletions: change.deletions,
        changeType: change.status === 'added' ? 'ADDED' : change.status === 'removed' ? 'REMOVED' : 'MODIFIED',
      }));
      return connection(nodes, args, (node) => node, 'PullRequestChangedFileConnection');
    },
  };
}

function repositoryObject(ctx: ExecContext, repo: Repo): GqlSource {
  return {
    __typename: 'Repository',
    id: repo.nodeId,
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: repo.fullName,
    description: repo.description,
    url: `https://github.com/${repo.fullName}`,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
    isPrivate: repo.privateFlag,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    owner: () => viewerObject(),
    defaultBranchRef: () => {
      const tip = repo.defaultTip();
      if (tip === null) return null;
      return { __typename: 'Ref', name: repo.defaultBranch, prefix: 'refs/heads/', target: { __typename: 'Commit', oid: tip } };
    },
    issue: (args: Record<string, unknown>) => {
      const number = args.number as number | undefined;
      if (typeof number !== 'number') return null;
      const issue = repo.issues.get(number);
      return issue === undefined ? null : issueObject(ctx, repo, issue);
    },
    issues: (args: Record<string, unknown>) =>
      connection(sortedIssues(repo, args), args, (issue) => issueObject(ctx, repo, issue), 'IssueConnection'),
    pullRequest: (args: Record<string, unknown>) => {
      const number = args.number as number | undefined;
      if (typeof number !== 'number') return null;
      const pull = repo.pulls.get(number);
      return pull === undefined ? null : pullObject(ctx, repo, pull);
    },
    pullRequests: (args: Record<string, unknown>) =>
      connection(sortedPulls(repo, args), args, (pull) => pullObject(ctx, repo, pull), 'PullRequestConnection'),
  };
}

function nodeObject(ctx: ExecContext, id: string): GqlSource | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  if (decoded.kind === 'Repository') {
    const repo = ctx.store.findRepoById(parseInt(decoded.key, 10));
    return repo === null ? null : repositoryObject(ctx, repo);
  }
  if (decoded.kind === 'Issue' || decoded.kind === 'PullRequest') {
    const [repoIdText, numberText] = decoded.key.split(':');
    const repo = ctx.store.findRepoById(parseInt(repoIdText as string, 10));
    if (repo === null) return null;
    const number = parseInt(numberText as string, 10);
    if (decoded.kind === 'Issue') {
      const issue = repo.issues.get(number);
      return issue === undefined ? null : issueObject(ctx, repo, issue);
    }
    const pull = repo.pulls.get(number);
    return pull === undefined ? null : pullObject(ctx, repo, pull);
  }
  if (decoded.kind === 'IssueComment') {
    const [repoIdText, issueText, commentText] = decoded.key.split(':');
    const repo = ctx.store.findRepoById(parseInt(repoIdText as string, 10));
    if (repo === null) return null;
    const issue = repo.issues.get(parseInt(issueText as string, 10));
    if (issue === undefined) return null;
    const comment = issue.comments.find((entry) => entry.id === parseInt(commentText as string, 10));
    return comment === undefined ? null : commentObject(repo, issue, comment);
  }
  return null;
}

// ---------------------------------------------------------------------------
// introspection
// ---------------------------------------------------------------------------

function typeField(name: string): GqlSource {
  return { __typename: '__Field', name, description: null, type: { __typename: '__Type', name: 'String', kind: 'SCALAR' } };
}

const INTROSPECTION: Record<string, GqlSource> = {
  Issue: {
    __typename: '__Type',
    name: 'Issue',
    kind: 'OBJECT',
    description: null,
    fields: [
      'id', 'databaseId', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'closedAt',
      'author', 'labels', 'comments', 'repository', 'viewerCanUpdate', 'locked', 'milestone',
    ].map(typeField),
    enumValues: null,
  },
  PullRequest: {
    __typename: '__Type',
    name: 'PullRequest',
    kind: 'OBJECT',
    description: null,
    fields: [
      'id', 'databaseId', 'number', 'title', 'state', 'body', 'headRefName', 'baseRefName', 'headRefOid',
      'baseRefOid', 'mergeable', 'merged', 'files', 'author', 'repository', 'createdAt', 'updatedAt',
      'closedAt', 'mergedAt', 'mergeCommit', 'isDraft', 'additions', 'deletions', 'changedFiles',
    ].map(typeField),
    enumValues: null,
  },
  Repository: {
    __typename: '__Type',
    name: 'Repository',
    kind: 'OBJECT',
    description: null,
    fields: [
      'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
      'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url',
      'createdAt', 'updatedAt', 'isPrivate', 'fork', 'stargazers', 'watchers',
    ].map(typeField),
    enumValues: null,
  },
  SearchType: {
    __typename: '__Type',
    name: 'SearchType',
    kind: 'ENUM',
    description: null,
    fields: null,
    enumValues: [
      'ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'PACKAGE', 'MARKETPLACE',
      'WIKI', 'PROJECT', 'MILESTONE', 'PULL_REQUEST',
    ].map((name) => ({ __typename: '__EnumValue', name, description: null })),
  },
};

// ---------------------------------------------------------------------------
// roots
// ---------------------------------------------------------------------------

function queryRoot(ctx: ExecContext): GqlSource {
  return {
    __typename: 'Query',
    viewer: () => viewerObject(),
    repository: (args: Record<string, unknown>) => {
      const owner = args.owner as string | undefined;
      const name = args.name as string | undefined;
      if (typeof owner !== 'string' || typeof name !== 'string') return null;
      const repo = ctx.store.getRepo(owner, name);
      return repo === null ? null : repositoryObject(ctx, repo);
    },
    node: (args: Record<string, unknown>) => {
      const id = args.id as string | undefined;
      if (typeof id !== 'string') return null;
      return nodeObject(ctx, id);
    },
    __type: (args: Record<string, unknown>) => {
      const name = args.name as string | undefined;
      if (typeof name !== 'string') return null;
      return INTROSPECTION[name] ?? null;
    },
    __schema: () => ({ __typename: '__Schema', description: null, types: null, queryType: { name: 'Query' }, mutationType: { name: 'Mutation' } }),
  };
}

function decodeRepoId(globalId: unknown): number | null {
  if (typeof globalId !== 'string') return null;
  const decoded = decodeGlobalId(globalId);
  if (decoded === null || decoded.kind !== 'Repository') return null;
  const id = parseInt(decoded.key, 10);
  return Number.isFinite(id) ? id : null;
}

function mutationRoot(ctx: ExecContext): GqlSource {
  return {
    __typename: 'Mutation',
    createIssue: (args: Record<string, unknown>) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repoId = decodeRepoId(input.repositoryId);
      const repo = repoId === null ? null : ctx.store.findRepoById(repoId);
      if (repo === null) throw new Error('repository not found');
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : '';
      const issue = createIssueRecord(ctx.store, repo, title, body, []);
      return {
        __typename: 'CreateIssuePayload',
        issue: issueObject(ctx, repo, issue),
        clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
      };
    },
    closeIssue: (args: Record<string, unknown>) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = typeof input.issueId === 'string' ? decodeGlobalId(input.issueId) : null;
      if (decoded === null || decoded.kind !== 'Issue') throw new Error('issue not found');
      const [repoIdText, numberText] = decoded.key.split(':');
      const repo = ctx.store.findRepoById(parseInt(repoIdText as string, 10));
      const issue = repo?.issues.get(parseInt(numberText as string, 10));
      if (repo === null || issue === undefined) throw new Error('issue not found');
      issue.state = 'closed';
      issue.closedAt = new Date().toISOString();
      issue.updatedAt = issue.closedAt;
      ctx.store.upsertIssue(repo, issue);
      return {
        __typename: 'CloseIssuePayload',
        issue: issueObject(ctx, repo, issue),
        clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
      };
    },
    createPullRequest: (args: Record<string, unknown>) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repoId = decodeRepoId(input.repositoryId);
      const repo = repoId === null ? null : ctx.store.findRepoById(repoId);
      if (repo === null) throw new Error('repository not found');
      const head = typeof input.headRefName === 'string' ? input.headRefName : '';
      const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : '';
      if (!repo.refs.has(`refs/heads/${head}`) || !repo.refs.has(`refs/heads/${base}`)) {
        throw new Error('head or base branch does not exist');
      }
      const existing = [...repo.pulls.values()].find(
        (pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base,
      );
      const pull = existing ?? createPullRecord(ctx.store, repo, title, body, head, base);
      return {
        __typename: 'CreatePullRequestPayload',
        pullRequest: pullObject(ctx, repo, pull),
        clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
      };
    },
    mergePullRequest: (args: Record<string, unknown>) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = typeof input.pullRequestId === 'string' ? decodeGlobalId(input.pullRequestId) : null;
      if (decoded === null || decoded.kind !== 'PullRequest') throw new Error('pull request not found');
      const [repoIdText, numberText] = decoded.key.split(':');
      const repo = ctx.store.findRepoById(parseInt(repoIdText as string, 10));
      const pull = repo?.pulls.get(parseInt(numberText as string, 10));
      if (repo === null || pull === undefined) throw new Error('pull request not found');
      const message = `Merge pull request #${pull.number} from ${pull.headRef}`;
      const result = performSquashMerge(ctx.store, repo, pull, message);
      if (!result.ok) throw new Error(result.reason);
      return {
        __typename: 'MergePullRequestPayload',
        pullRequest: pullObject(ctx, repo, pull),
        clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
      };
    },
    addComment: (args: Record<string, unknown>) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = typeof input.subjectId === 'string' ? decodeGlobalId(input.subjectId) : null;
      if (decoded === null || decoded.kind !== 'Issue') throw new Error('subject not found');
      const [repoIdText, numberText] = decoded.key.split(':');
      const repo = ctx.store.findRepoById(parseInt(repoIdText as string, 10));
      const issue = repo?.issues.get(parseInt(numberText as string, 10));
      if (repo === null || issue === undefined) throw new Error('subject not found');
      const body = typeof input.body === 'string' ? input.body : '';
      const comment = addCommentRecord(ctx.store, repo, issue, body);
      return {
        __typename: 'AddCommentPayload',
        commentEdge: {
          __typename: 'IssueCommentEdge',
          node: commentObject(repo, issue, comment),
          cursor: encodeCursor(issue.comments.length - 1),
        },
        subject: issueObject(ctx, repo, issue),
        clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

function authorized(req: IncomingMessage): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  if (!expected) return true;
  return (req.headers.authorization ?? '') === `Bearer ${expected}`;
}

function runDocument(
  document: { query?: unknown; variables?: unknown; operationName?: unknown },
  store: Store,
): Record<string, unknown> {
  const query = typeof document.query === 'string' ? document.query : '';
  const variables =
    document.variables !== null && typeof document.variables === 'object' && !Array.isArray(document.variables)
      ? (document.variables as Record<string, unknown>)
      : {};
  const operationName = typeof document.operationName === 'string' ? document.operationName : null;
  if (query.trim() === '') return { errors: [{ message: 'Must provide query string.' }] };
  let parsed: { operations: OperationNode[]; fragments: Map<string, FragmentNode> };
  try {
    parsed = new Parser(lex(query)).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'Syntax Error' }] };
  }
  let operation: OperationNode | null = parsed.operations[0] ?? null;
  if (operationName !== null) {
    operation = parsed.operations.find((entry) => entry.name === operationName) ?? null;
  }
  if (operation === null) return { errors: [{ message: `Unknown operation named "${operationName}".` }] };
  const ctx: ExecContext = { store, variables, fragments: parsed.fragments, errors: [] };
  const root = operation.operation === 'mutation' ? mutationRoot(ctx) : queryRoot(ctx);
  const data = executeOperation(operation, root, ctx);
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}

/** Handle POST /api/graphql; returns true when the path matched. */
export async function handleGraphql(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  if (!req.url?.startsWith('/api/graphql')) return false;
  if (req.method !== 'POST') {
    sendJson(res, 405, { errors: [{ message: 'Method Not Allowed' }] });
    return true;
  }
  if (!authorized(req)) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return true;
  }
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return true;
  }
  if (Array.isArray(body)) {
    const results = body.map((entry) =>
      entry !== null && typeof entry === 'object' ? runDocument(entry as Record<string, unknown>, store) : { errors: [{ message: 'Invalid request.' }] },
    );
    sendJson(res, 200, results);
    return true;
  }
  if (body === null || typeof body !== 'object') {
    sendJson(res, 400, { errors: [{ message: 'Invalid request.' }] });
    return true;
  }
  sendJson(res, 200, runDocument(body as Record<string, unknown>, store));
  return true;
}
