// The forge's one process: one HTTP server, one store, four surfaces.
//
//   GET  /healthz                       -> {"ok": true} (no auth; the env's boot check)
//   /{owner}/{repo}.git/*               -> git smart HTTP (upload-pack v2/v0, receive-pack v0)
//   /api/v3/*                           -> REST v3
//   POST /api/graphql                   -> GraphQL v4
//   POST /mcp                           -> MCP (Streamable HTTP)
//
// A request that fails after the headers went out cannot be answered again, so
// the handler guards every reply; a single bad request never kills the process.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Store } from './src/store.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './src/git.ts';
import { handleRest } from './src/rest.ts';
import { handleGraphql } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { pathOf, queryOf, sendError, sendJson, splitPath } from './src/util.ts';

export function createApp() {
  const store = new Store();
  return createServer((req, res) => {
    void route(req, res, store).catch((err: unknown) => {
      process.stderr.write(`[forge] request failed: ${err instanceof Error ? err.message : String(err)}\n`);
      try {
        if (!res.headersSent) sendError(res, 500, err instanceof Error ? err.message : 'Internal Server Error');
        else res.end();
      } catch {
        // The peer is gone; nothing left to do.
      }
    });
  });
}

async function route(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  const path = pathOf(req);
  const method = req.method ?? 'GET';

  if (path === '/healthz') {
    if (method !== 'GET') {
      sendError(res, 405, 'Method Not Allowed');
      return;
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  if (path === '/api/graphql' || path.startsWith('/api/graphql?')) {
    if (await handleGraphql(req, res, store)) return;
  }
  if (path === '/mcp' || path.startsWith('/mcp?')) {
    if (await handleMcp(req, res, store)) return;
  }
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (await handleRest(req, res, store)) return;
  }

  // git smart HTTP: /{owner}/{repo}.git/info/refs, /{owner}/{repo}.git/git-upload-pack,
  // /{owner}/{repo}.git/git-receive-pack
  const segments = splitPath(path);
  if (segments.length >= 3 && segments[1]?.endsWith('.git') === true) {
    const owner = segments[0] as string;
    const repoName = (segments[1] as string).slice(0, -'.git'.length);
    const repo = store.getRepo(owner, repoName);
    const action = segments[2];
    if (action === 'info' && segments[3] === 'refs' && method === 'GET') {
      const service = queryOf(req).get('service') ?? '';
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('Missing service parameter\n');
        return;
      }
      handleInfoRefs(req, res, repo, service);
      return;
    }
    if (action === 'git-upload-pack' && method === 'POST') {
      if (repo === null) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('Not Found\n');
        return;
      }
      await handleUploadPack(req, res, repo);
      return;
    }
    if (action === 'git-receive-pack' && method === 'POST') {
      if (repo === null) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('Not Found\n');
        return;
      }
      await handleReceivePack(req, res, repo, store);
      return;
    }
  }

  sendError(res, 404, 'Not Found');
}
