# Forge — Architecture

> An AI-native alternative to GitHub: intent-first version control, autonomous PR review, zero-config ephemeral previews, semantic code search, and keyboard-first issue tracking.

## 1. Guiding principles

1. **Works out-of-the-box.** Jobs run on a Postgres-backed queue (`FOR UPDATE SKIP LOCKED`, 500ms polling, stale-`active` reaper). If Docker is absent, previews run in a locked-down child process. If no `ANTHROPIC_API_KEY` is set, the AI layer runs a deterministic heuristic engine behind the same interface. Zero-dependency local dev is a hard requirement, not a nice-to-have.
2. **Real Git.** The server speaks the native Git **smart HTTP protocol** by shelling out to `git http-backend` as a CGI-style process, plus `git` CLI plumbing for trees, blobs, and diffs. You can `git clone http://localhost:3000/git/demo/hello.git` with the stock Git client and it just works.
3. **One process, many jobs.** A single Node process hosts the Next.js web app, the Git HTTP transport, the background workers, and the ephemeral sandbox runner. Redis/Docker/pgvector are **optional accelerators**, each behind a feature-detecting adapter.
4. **Types end-to-end.** Typed Next.js route handlers + server components for web→server calls, Drizzle for SQL, shared domain types in `packages/shared`.

## 2. Monorepo layout (Turborepo + pnpm workspaces)

```
origin/                         # repo root, pnpm workspace + turborepo
├── ARCHITECTURE.md
├── TASKS.md
├── README.md
├── turbo.json
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json          # shared TS compiler options
├── .gitignore
├── apps/
│   ├── web/                    # Next.js (App Router) UI + custom server
│   │   ├── src/app/            # routes (repo explorer, PRs, issues, search, admin)
│   │   │   ├── (auth)/         # login
│   │   │   ├── (dash)/         # home dashboard
│   │   │   └── [org]/[repo]/   # repo pages: code, pulls, issues, settings
│   │   ├── src/server/         # server-only modules
│   │   │   ├── authz.ts        # authorization (org membership, visibility gates)
│   │   │   ├── db.ts           # Drizzle client (pg driver)
│   │   │   ├── env.ts          # zod-validated env
│   │   │   ├── trpc.ts         # tRPC setup + routers
│   │   │   ├── git-transport.ts# git http-backend CGI bridge + auth
│   │   │   ├── server.ts       # custom Node http server (Next + /git + /trpc)
│   │   │   └── hooks/          # post-receive hook handler
│   │   ├── src/components/      # UI: file tree, diff viewer, palette, etc.
│   │   ├── drizzle/            # generated SQL migrations
│   │   ├── drizzle.config.ts
│   │   └── next.config.ts
│   ├── worker/                # standalone background worker entry
│   │   └── src/index.ts       # polls job queue, runs review/QA/plan/preview jobs
│   └── seed/                  # (scripts live in apps/web/scripts/seed.ts)
├── packages/
│   ├── shared/                # domain types shared client+server
│   │   └── src/index.ts       # Intent, ReviewComment, DiffFile, job payloads…
│   ├── ai/                    # AI layer
│   │   └── src/
│   │       ├── client.ts      # feature-detect ANTHROPIC_API_KEY → real | fallback
│   │       ├── review.ts      # PR review analysis
│   │       ├── qa.ts          # semantic codebase Q&A
│   │       ├── plan.ts        # Intent → implementation plan
│   │       └── embeddings.ts   # chunking + embedding (API or local hash-based)
│   ├── git/                   # Git engine
│   │   └── src/
│   │       ├── engine.ts      # bare repo lifecycle, storage root resolution
│   │       ├── plumbing.ts    # typed wrappers: cat-file, ls-tree, rev-list…
│   │       ├── diff.ts        # unified diff → structured hunks
│   │       └── archive.ts     # git archive extraction for sandboxes
│   ├── queue/                # job queue abstraction
│   │   └── src/
│   │       ├── index.ts       # interface + feature detection
│   │       └── index.ts       # SKIP-LOCKED claim + backoff (Postgres only; no Redis adapter)
│   └── sandbox/               # ephemeral preview runner
│       └── src/
│           ├── index.ts       # adapter selection (docker | process)
│           ├── docker.ts      # docker CLI adapter
│           ├── process.ts     # child_process adapter with limits
│           └── scanner.ts    # package.json lifecycle-script prescan
└── tests/                     # integration tests (Vitest)
    └── e2e/git-flow.test.ts   # real git clone/push against booted server
```

## 3. Why a custom Node server (not pure Next)

Next.js App Router cannot cleanly proxy the Git smart HTTP protocol: `git receive-pack` needs raw bidirectional body streaming and chunked status-line responses. So a thin custom server (`apps/web/src/server/server.ts`) forwards all normal traffic to Next.js and directly serves `/git/*` by bridging to `git http-backend` as a CGI child process. One `pnpm dev` boots web + git + workers.

### 3.1 Git smart HTTP handling

```
client (git CLI)                     apps/web custom server
    │  GET  /git/{owner}/{repo}.git/info/refs?service=git-upload-pack
    │ ─────────────────────────────▶ CGI env → spawn git http-backend
    │  ◀── application/x-git-upload-pack-advertisement
    │  POST /git/{owner}/{repo}.git/git-upload-pack   (fetch: negotiation + pack)
    │ ─────────────────────────────▶ CGI bridge, streamed
    │  POST /git/{owner}/{repo}.git/git-receive-pack  (push)
    │ ─────────────────────────────▶ CGI bridge (PAT with repo:write required)
    │                                 post-receive hook → internal HTTP callback
    │                                 → update DB refs, enqueue index + AI jobs
```

### 3.2 Node CGI bridging notes

`git-http-backend` reads HTTP request metadata from **environment variables** (`REQUEST_METHOD`, `PATH_INFO`, `QUERY_STRING`, `CONTENT_TYPE`, `CONTENT_LENGTH`, `GIT_PROJECT_ROOT`, `GIT_HTTP_EXPORT_ALL`) and the request body from stdin; it writes a CGI response (headers, then body) to stdout. Our bridge:
- streams the request body into the child's stdin,
- parses the CGI response from stdout: headers/body split on `\r\n`,
- relays the `Status:` header as the HTTP status, all other headers, and streams the body to the client (chunked; stock git handles this),
- after a successful receive-pack, the post-receive hook (installed into every bare repo at creation) POSTs the ref updates to the server's internal endpoint.

The post-receive handler then:
1. upserts branches/commits in Postgres,
2. auto-opens/updates PRs matching intent branch patterns (`i{number}-…`),
3. enqueues the semantic-index job, the AI PR review job, and the ephemeral preview job.

## 4. Database schema (PostgreSQL + Drizzle ORM)

| table | purpose | key columns |
|---|---|---|
| `users` | identity | id, email, name, handle, avatarUrl |
| `sessions` | web sessions | token, userId, expiresAt |
| `accounts` | auth-provider links | provider, providerAccountId, userId |
| `verification_tokens` | email tokens | identifier, token, expiresAt |
| `ssh_keys` | user SSH keys | userId, title, fingerprint, publicKey, createdAt |
| `personal_access_tokens` | git/API tokens | userId, name, tokenHash (sha256), prefix, scopes, lastUsedAt |
| `organizations` | owners of repos | id, slug, name, ownerId |
| `repositories` | repo registry | orgId, name, description, visibility, defaultBranch, gitDir |
| `branches` | ref cache | repoId, name, commitSha, isDefault |
| `commits` | commit cache | repoId, sha, message, author, dates, parentShas |
| `pull_requests` | PRs | repoId, number, title, base/head, status, authorId, riskScore, riskSummary, mergedCommitSha |
| `review_comments` | PR comments | prId, commitSha, path, line, side, body, kind (ai_review/human/ai_plan), authorId |
| `intents` | issues/specs/intents | repoId, number, title, description, status, kind, labels, authorId, branchName, linkedPrId, aiState |
| `intent_links` | spec↔code lineage | intentId, prId?, commitSha?, kind |
| `embeddings` | semantic index | repoId, branch, path, lineStart, lineEnd, symbol, content, embedding real[] |
| `job_queue` | Postgres queue fallback | queue, payload, status, runAt, attempts, lockedBy |
| `job_runs` | observability of jobs | type, repoId, prId, status, payload, result, error |
| `job_events` | streamed job logs | jobId, level, message, createdAt |
| `previews` | ephemeral environments | repoId, prId, branch, commitSha, status, buildLogId, containerName, url |
| `activities` | activity feed | repoId, userId, type, data |

### 4.1 Vectors without pgvector

pgvector is not available on this machine (Homebrew Postgres 17 without the extension). The AI layer stores embeddings as `real[]` columns. Retrieval strategy:
- A SQL `cosine_distance(real[], real[])` immutable function is created via migration for optional server-side scoring.
- MVP scale: worker loads a repo's chunks in-process and scores in JS (unit vectors → dot product), which is fast to ~100k chunks. Cross-repo search goes through the SQL function with candidate `LIMIT`s.

## 5. AI layer (`packages/ai`)

`client.ts` feature-detects `ANTHROPIC_API_KEY`:

- **Claude mode** (SDK wired, activates when a key is present): full-diff analysis via the Claude SDK with structured JSON output (findings, riskScore, summary, suggested patches), and RAG-style Q&A with citations.
- **Heuristic mode** (default fallback, fully deterministic): static-analysis rules — secret scanning (AWS/GitHub/Slack/generic key assignments), dangerous API patterns (`eval`, `exec` with concat, SQL string building, unawaited promises, prototype-pollution sinks), missing-test coverage delta, and a weighted risk score. Deterministic output makes integration tests stable.
- Both modes emit the same `ReviewAnalysis` shape → persisted as `review_comments` (kind=ai_review) + `pull_requests.riskScore/riskSummary`.

### 5.1 Semantic indexing & Q&A

**Indexing** (queued on every push): code files are chunked into ~40-line windows aligned to top-level declarations (symbol names extracted); markdown by heading/paragraph. Chunks are embedded with a deterministic local hashing embedder (token n-grams → 256-dim, identifier-split camelCase/snake_case, L2-normalized) — no external embedding API is called today; `embedViaApi` is the seam for one. Persist with path + line range so answers cite exact locations.

**Q&A** (`/search`, repo Ask box): query → same embedder → cosine over repo chunks → top-k → answer. Heuristic mode builds an extractive answer with citations ("Auth is handled in `src/auth.ts:12-48` …"); Claude mode does a RAG pass over the retrieved chunks.

### 5.2 Spec-to-PR workflow

Intent page → "Draft Implementation Plan" → queued AI plan job → structured plan (overview, files to create/modify, steps, acceptance criteria, risks) saved to `intents.aiState.plan`. "Create scaffold" creates branch `i{n}-{slug}` with `INTENT.md` committed via the Git engine, linking intent ↔ branch ↔ later PR through `intent_links`.

## 6. Background queue (`packages/queue`)

Postgres-backed queue: `job_queue` table, atomic claim via a single `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)` statement, 500ms polling, exponential-backoff retries, and a reaper that requeues jobs left `active` by a dead worker (>10 min).

Job types: `semantic_index`, `pr_review`, `qa_answer`, `intent_plan`, `preview_build`. Every job writes log lines to `job_events` (streamed to the UI over SSE) and a `job_runs` row for status.

## 7. Ephemeral sandbox runner (`packages/sandbox`)

Every PR push triggers a preview build. Adapters, feature-detected at runtime:

- **Docker adapter** (when Docker is up): build from a `git archive` snapshot with `--cpus`, `--memory`, tmpfs, no network except npm registry, `docker logs --follow` streaming, `docker stop` on timeout.
- **Process adapter** (fallback; used on this machine): `child_process.spawn` with a per-preview temp dir (`git archive | tar -x`), sanitized env (`PATH`, `HOME=tmpdir`, registry), 60s timeout, 2MB output cap, global concurrency semaphore (4), process-group kill (`detached: true`, `kill(-pid)`), and a **lifecycle-script prescan** that blocks `postinstall` scripts matching `curl … | sh` and friends. Logs stream → `job_events` → SSE → PR page.

## 8. Auth & sessions

- Hand-rolled, dependency-light auth (deliberate: small auditable surface): scrypt password hashing, DB-backed sessions, `forge_session` httpOnly cookie.
- **PATs**: generated in the UI, shown once, stored sha256-hashed. Git uses `http://user:token@host/git/…` (Basic); the API accepts `Authorization: Bearer <pat>`. Scopes: `repo:read`, `repo:write`.
- **SSH keys**: managed + revocable in UI (title, fingerprint, publicKey) — stored for future SSH transport; HTTP with PATs is the current transport.

## 9. UI structure (Next.js App Router)

Dark-mode-first, Linear-inspired, keyboard-first (⌘K command palette, `c`/`i` shortcuts, vim-style list navigation).

Routes:
- `/` — dashboard (repos, activity, open PRs)
- `/login` — sign in
- `/[org]/[repo]` — code: file tree, syntax-highlighted viewer, branch switcher, commit history
- `/[org]/[repo]/pulls` and `/pulls/[number]` — diff viewer, inline comments (human + AI), merge strategies (merge/rebase/squash), preview card + live build logs, risk card
- `/[org]/[repo]/issues` and `/issues/[number]` — intent board, keyboard nav, statuses, AI plan
- `/[org]/[repo]/ask` — semantic codebase Q&A
- `/search` — global semantic search
- `/settings` — SSH keys + PATs
- `/new` — new repo

## 10. Migrations & running

- Schema: `pnpm db:push` (drizzle-kit sync). The `cosine_distance` SQL function is created by test global-setup / seed scripts; there is no versioned migration directory yet.
- `pnpm dev` — boots the custom server (Next + Git HTTP + in-process worker).
- `pnpm worker` — standalone worker process (production split).
- `pnpm seed` — demo org, users, repos, issues, open PRs (one with a deliberately vulnerable diff so the AI reviewer has something to catch).

## 11. Security notes

- Bare repos live under `FORGE_STORAGE_ROOT` (default `./data/repos`), outside any static route exposure.
- `PATH_INFO` is validated (`^[a-z0-9][a-z0-9-]{0,38}/[a-z0-9][a-z0-9_.-]{0,99}\.git$`) **and** checked against the DB before `git http-backend` spawns — no path traversal, no unauthenticated listing.
- Push requires PAT with `repo:write`; pulls require `repo:read` or public visibility.
- All SQL through Drizzle's parameterized builder; raw SQL only for the cosine function definition and queue claims (parameterized).
- Preview runner: sanitized env, timeouts, output caps, process-group kill, lifecycle-script prescan.

## 12. Testing & verification

- `pnpm typecheck` — tsc across the monorepo
- `pnpm test` — 52 Vitest tests across 5 suites, all booting real servers and driving real git where relevant:
  - **unit-engines**: diff parser (line anchors, add/remove/rename), deterministic heuristic review (secrets/eval/missing tests/risk), local embedder (unit vectors, similarity ordering, determinism), lifecycle-script prescan
  - **unit-queue-sse**: SKIP-LOCKED claim exclusivity, retry-until-max-attempts, sandbox builds (success path streams `npm run build` output; `curl|sh` postinstall is BLOCKED pre-execution), `git archive` extraction fidelity
  - **e2e-git-flow**: register→PAT, repo create, empty-repo clone → first push, intent API, `i1-*` branch push → auto-PR, manual PR open + duplicate 409 + no-diff 400, AI review comments, preview build, anonymous push rejected (no keychain replay), squash merge, semantic index + Q&A citations
  - **e2e-auth-issues**: anonymous 401s, register/login/logout, weak-password rejection, session-scoped keys/PATs, UI page rendering (dashboard/org/repo/file view), PR close/reopen → intent status sync, human comments, merge → intent done
  - **e2e-security**: private-repo page gating (anon + non-member), search leakage, org takeover 403, forged hook-token 403, SSE session required, PAT create→use→revoke→rejected, SSH key delete, member promotion grants access, branch protection (force-push/deletion rejected, unprotected allowed, owner settings API), login brute-force lockout (429 + Retry-After)
- `pnpm typecheck` / `pnpm test` / `pnpm build` — quality gates before "done" (no ESLint config yet)
