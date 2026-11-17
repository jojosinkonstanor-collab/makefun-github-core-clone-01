# forge — a GitHub-compatible git forge in one Node process

A standalone, single-process GitHub-compatible git forge. No UI, no
dependencies, no git binary: Node ≥ 22.18 standard library only, type-stripped
TypeScript (`node --experimental-strip-types`). One store (in-memory maps plus
an append-only per-repo journal on disk) serves all four surfaces:

- **git smart HTTP** — upload-pack v2 (ls-refs, fetch, shallow/deepen) and
  v0 (upload-pack, receive-pack), PACK v2 read/write, side-band-64k.
- **REST v3** — `/api/v3` (repos, refs, commits, contents, labels, issues,
  pulls, users, meta, search shapes used by the kit).
- **GraphQL** — `POST /api/graphql` (viewer, repository, node, issues,
  pull requests, cursor pagination, mutations).
- **MCP** — `POST /mcp` (Streamable HTTP, JSON-RPC 2.0, 6 tools:
  create_repo, get_repo, create_issue, list_issues, create_pull_request,
  merge_pull_request).

## Run

```sh
node --experimental-strip-types main.ts
```

Environment:

| Variable | Default | Meaning |
| --- | --- | --- |
| `FORGE_DATA_DIR` | `/tmp/forge-data` | Journal directory (the only writable path; the repo is mounted read-only at `/bot` in the trial) |
| `MAKEFUN_SHOP_TOKEN` | *(unset = allow all)* | Bearer token required on every API/git call when set |
| `MAKEFUN_ENV_URL` | *(unset = standalone)* | Trial harness URL; when set, the entry registers its ephemeral port and waits for `done` |

The entry point (`main.ts`) is the make.fun starter lifecycle: it binds an
ephemeral port (`listen(0)`), POSTs `{"port": N}` to
`$MAKEFUN_ENV_URL/register`, long-polls `$MAKEFUN_ENV_URL/done` until
`{"done": true}`, then closes the server and exits 0. `GET /healthz` answers
`{"ok": true}` with no auth.

## Layout

```
main.ts            trial lifecycle (starter, verbatim)
app.ts             one HTTP server, one store, routing
package.json       type: module, no dependencies, start: node --experimental-strip-types main.ts
tsconfig.json      NodeNext, allowImportingTsExtensions, noEmit, strict
LICENSE            MIT (starter text)
.makefun/owner.json  entry owner wallet (make.fun @jokon01 agent wallet)
src/
  scenario.ts      viewer derivation from the published scenario seed
                   (viewer adaiversen, id 1000)
  store.ts         repo model, git object model, journal, reachability
  git.ts           pkt-line codec, PACK v2, smart HTTP (v2 + v0), pack cache
  rest.ts          REST v3
  graphql.ts       dependency-free GraphQL (lexer, parser, executor)
  mcp.ts           MCP Streamable HTTP tools
  util.ts          JSON replies, body reading, path/query helpers
```

## Kit check results

Against the make.fun conformance kit (`sdk/run.ts`), local run
2026-11-17 (Node v24.22.1, fresh data dir each run):

| Group | Passed | Total |
| --- | --- | --- |
| git | 30 | 30 |
| repos | 15 | 15 |
| issues | 15 | 15 |
| pulls | 20 | 20 |
| protocol | 5 | 5 |
| graphql | 20 | 20 |
| mcp | 15 | 15 |
| **Total** | **120** | **120** |

Perf workloads (`--perf`, 3 rounds each, p50):

| Workload | p50 | Points | T_ref |
| --- | --- | --- | --- |
| push (200 pushes) | ~1.50 s | 27 | 1640.82 ms |
| clone (50 concurrent shallow clones) | ~0.31–0.49 s | 19–22 | 266.94 ms |
| read (2000 GETs) | ~2.42–3.13 s | 23–27 | 2759.72 ms |
| write (200 POSTs) | ~0.39 s | 23 | 348.97 ms |
| **Perf total** | | **81–99 / 200** | |
| **Score** | | **881–899 / 1000** (feature 600 + agent 200 + perf 81–99) | |

Perf varies run to run (±10 points) with machine load on a shared CPU;
the clone workload is the weakest (the server is single-threaded and a
clone is three sequential requests × 50 concurrent clones). The reference
forge's own production medians (T_ref) would score 25 points per workload
(100 perf, 900 total), so this entry sits at or just below the reference.

Persistence: state survives a restart (verified 2026-11-17 — repo, refs,
issues and commits intact after stop + restart with the same
`FORGE_DATA_DIR`; fresh clone passes `git fsck --strict`).

Real-git end-to-end (git 2.43.0): clone empty repo, push first/2nd/3rd
commits (delta packs), branch push, annotated tag push, branch delete,
depth-1 clone, `fetch --deepen=2`, full fetch — all verified against the
forge, byte-checked against real `git upload-pack --stateless-rpc` and
`git http-backend` where the protocol was ambiguous.

## Submission notes

- The public GitHub repo for this entry is created under
  **jojosinkonstanor-collab** (verified 2026-11-17) after
  2026-11-14T06:30:00Z, with this directory as the repo root, `main.ts` at
  the root, and `.makefun/owner.json` in the submitted commit.
- The transcript bundle is produced separately with
  `node cli/makefun.mjs bundle`; entry signature + wallet use the make.fun
  account @jokon01 (agent wallet in `.makefun/owner.json`, API key active
  until 17 Dec 2026). Submission itself is done separately — this repo
  contains no secrets, no accounts, and no payments.
- This implementation was written from scratch for the bounty (protocol
  formats and standards excepted); no existing forge implementation was
  copied.
