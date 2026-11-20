# mf-github-core-clone-01-202611200724

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/lairegodd/mf-github-core-clone-01-202611200724/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/lairegodd/mf-github-core-clone-01-202611200724/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in one dependency-free Node 22 process. It serves its own in-memory store over
four surfaces, with no git binary, no database and no packages:

- **git smart HTTP** at `/{owner}/{repo}.git`: `upload-pack` speaks protocol v2 (`ls-refs` with
  `symrefs`/`peel`/`unborn`/`ref-prefix`, `fetch` with shallow `deepen`, `shallow-info`, side-band-64k
  packfiles) and v0; `receive-pack` (v0) takes packs with OFS/REF deltas, applies each ref on its own
  (fast-forward only for branches, `ng … non-fast-forward` otherwise) and answers `report-status` inside
  side-band-64k. Objects are hashed, inflated and deflated with `node:crypto` and `node:zlib` alone.
- **REST v3** under `/api/v3`: user and repositories (paginated with `Link` headers), contents (create,
  update with stale-sha `409`, delete, directory listings), branches, commits, git refs/trees/blobs, labels,
  issues and comments, pull requests with changed files and squash / merge / rebase merges (`405` on a
  conflict). Every reply is JSON with an `X-GitHub-Request-Id`.
- **GraphQL v4** at `/api/graphql`: a small GraphQL engine (parser, validator, executor, introspection,
  batching) with the Repository / Issue / PullRequest schema `gh` and `github-mcp-server` use, Relay global
  ids and cursor pagination, plus the issue and pull-request mutations.
- **MCP** at `/mcp`: JSON-RPC 2.0 over streamable HTTP, revision 2026-07-28 (`server/discover`) and the
  handshake revisions (`initialize`), with 25 github-mcp-server-style tools acting on the same store.

Hot paths are cached: ref advertisements and upload-pack responses per repository version, deflated pack
entries per object, and serialized issue JSON per issue.

| File | What it holds |
| --- | --- |
| `main.ts` | lifecycle (register / poll done), HTTP server, auth, git routing, the REST v3 router |
| `forge.ts` | the store: repositories, issues, labels, comments, pull requests, merges, JSON shapes |
| `git.ts` | object database, tree/commit codecs, pack reader/writer, upload-pack and receive-pack |
| `graphql.ts` | GraphQL lexer, parser, validator, executor, schema and introspection |
| `mcp.ts` | the MCP endpoint and its tools |

## Run it

```sh
# under the make.fun harness (registers with $MAKEFUN_ENV_URL, token in $MAKEFUN_SHOP_TOKEN):
node main.ts

# standalone, for local use:
MAKEFUN_FORGE_PORT=3000 MAKEFUN_SHOP_TOKEN=dev node main.ts
git -c http.extraHeader="Authorization: Bearer dev" clone http://127.0.0.1:3000/adaiversen/demo.git
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=sdsxccgd&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
