# Forge

An AI-native alternative to GitHub: intent-first version control, autonomous PR review, zero-config ephemeral previews, semantic code search, and keyboard-first issue tracking — all running against **real Git** over the smart HTTP protocol.

## What's inside

| Capability | How it works |
|---|---|
| **Real Git hosting** | `git clone`/`push`/`pull` over HTTP via `git http-backend` CGI bridge, **and over SSH** (`ssh://git@host:2222/org/repo.git`) authenticated against your uploaded SSH keys. Stock git clients work unchanged. |
| **Intent-first VCs** | Issues/Specs/Intents link to branches, commits, and PRs (`intent_links`). Branches named `i{n}-*` auto-open PRs against intent #n. |
| **Autonomous PR review** | Every PR push triggers an async worker: security findings (secrets, eval, injection sinks, prototype pollution), logic smells, missing-test detection, and a 0–100 risk score — posted as inline PR comments. Claude API when `ANTHROPIC_API_KEY` is set; a deterministic static analyzer otherwise. |
| **Manual PRs** | Open a pull request from any head → base pair via the UI/API — the `i{n}-*` intent convention is a convenience, not a requirement. |
| **Commit & compare views** | Per-branch commit history with tags, per-commit diff pages (with parent links), and a branch-compare page (commits + full diff, with one-click "Open pull request"). |
| **Stars, forks & watchers** | Star/watch any repo (counts on the header, toggles are optimistic); forks mirror the git data into your personal org with lineage tracked and shown on both sides. |
| **Webhooks** | Per-repo hooks (push, pull_request, pr_merged, ping) with per-hook HMAC-SHA256 secrets, delivery log with status/latency/response codes, and hardening (10s timeout, no redirects, response cap, http(s) only). |
| **Branch protection** | Protected branches (default: `main`) reject force-pushes and deletions at a `pre-receive` hook. Owners manage the list per repo in the repo Settings tab. |
| **PR approvals** | Approve / request changes in the PR page. Merging into a protected branch requires ≥1 approval from a non-author and zero outstanding change requests. |
| **Org membership** | Private repos are readable/writable only by org members and owners, enforced across pages, API routes, git transport, search, and SSE. |
| **PAT revocation** | Tokens and SSH keys can be revoked from Settings; revoked PATs are rejected immediately. |
| **Notifications** | Per-user inbox of activity across your orgs with an unread badge; deep links to the PR or intent. |
| **Login rate limiting** | 5 failed attempts per email+IP per minute → 429 with Retry-After. |
| **Semantic code search & Q&A** | Pushes trigger indexing: files are chunked (symbol-aware for code, heading-aware for prose) and embedded. `/search` does global semantic search; the repo "Ask AI" page answers natural-language questions with file:line citations. |
| **Spec-to-PR workflow** | "Draft implementation plan" generates a structured plan (files to create/modify, steps, acceptance criteria). "Create branch scaffold" pushes a spec branch with a committed `docs/intents/*.md`. |
| **Ephemeral previews** | Every PR push builds in an isolated sandbox — Docker adapter when available, hardened child-process adapter otherwise (sanitized env, 60s timeout, 2MB output cap, concurrency limit, process-group kill, malicious-lifecycle-script prescan). Build logs stream into the PR page. |
| **Zero-config local dev** | Postgres is the only hard dependency. Queue, embeddings, and sandbox all have local fallbacks; Redis, Docker, pgvector, and the Claude API slot in automatically when present. |

## Quickstart

```bash
# 0. Prereqs: Node 22+, pnpm, PostgreSQL running locally
createdb forge                     # once

# 1. Install
pnpm install

# 2. Schema + demo data (users, org, repo, intents, a deliberately vulnerable PR)
DATABASE_URL=postgresql://$USER@localhost:5432/forge pnpm db:push
FORGE_STORAGE_ROOT=apps/web/data pnpm seed

# 3. Run (web + git transport + background workers in one process)
DATABASE_URL=postgresql://$USER@localhost:5432/forge \
FORGE_STORAGE_ROOT=apps/web/data \
pnpm --filter @forge/web dev
```

Then open **http://localhost:3000** — the demo repo is at `/acme/iris`.

The seed prints a Personal Access Token; use it for git pushes:

```bash
git clone http://localhost:3000/git/acme/iris.git
cd iris
git checkout -b i3-admin-revocation
# ... commit code ...
git push http://ada:<PAT>@localhost:3000/git/acme/iris.git HEAD:i3-admin-revocation
```

Pushing an `i3-*` branch links to intent #3 and auto-opens a PR; seconds later the autonomous reviewer posts findings (the seeded branch contains a hard-coded token and an `eval()` — watch it get flagged), a preview build runs, and the branch is indexed for search.

Sign in to the web UI with **ada@acme.dev / password123** (or register your own account). All mutations — repo creation, intents, merges, comments, PATs, SSH keys — require a session; git operations use PATs over Basic auth (HTTP) or uploaded SSH keys (SSH transport, `FORGE_SSH_PORT`, default 2222).

## Commands

```bash
pnpm typecheck        # tsc across all packages + apps
pnpm test             # 83 tests across 6 suites: engine units (diff parser, heuristic
                      #  review, embedder, scanner), queue claim semantics, sandbox
                      #  builds (success + malicious-script blocking), auth flows
                      #  (register/login/logout/401s/session scoping), UI rendering
                      #  (dashboard/org/repo/file view), the full E2E git flow
                      #  (clone, PAT push, auto-PR, manual PRs, AI review, preview,
                      #  auth rejection, squash merge, Q&A citations, intent
                      #  lifecycle), the security suite (private-repo gating,
                      #  org membership, branch protection, PAT revocation,
                      #  hook auth, brute-force lockout), and the new-features suite
                      #  (star/watch/fork, commit + compare pages, SSH transport
                      #  clone/push/auth rejection, webhook delivery + HMAC)
pnpm --filter @forge/web exec next build   # production build
pnpm worker           # standalone worker process (optional; dev runs one in-process)
pnpm db:push          # apply Drizzle schema
pnpm seed             # reset + seed demo data
```

## Configuration

Everything optional except Postgres:

```bash
DATABASE_URL=postgresql://user@localhost:5432/forge   # required
FORGE_STORAGE_ROOT=apps/web/data                     # bare repos + sandboxes
FORGE_PORT=3000                                      # web + git HTTP listen here
FORGE_SSH_PORT=2222                                  # git-over-SSH port (0 disables)
FORGE_SSH_HOST_KEY=path/to/key                       # SSH host key (auto-generated ed25519 on first boot)
ANTHROPIC_API_KEY=...                                # Claude review/QA/plans (else deterministic heuristics)
FORGE_HOOK_TOKEN=...                                 # shared secret for git hook callbacks (auto-generated)
```

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md). Monorepo map:

```
apps/web        Next.js UI + custom Node server (Next + /git CGI bridge + hooks + SSE + worker)
apps/worker     standalone worker entry for production splits
packages/git    bare-repo lifecycle, typed git plumbing, diff parser, archive extraction
packages/db     Drizzle schema (24 tables), auth (scrypt sessions, PATs, SSH keys, org membership)
packages/jobs   post-receive handler (ref sync, auto-PR, enqueue) + job processors + webhook delivery
packages/ai     review engine (Claude + heuristic), embeddings, Q&A, plan generator
packages/sandbox process + docker preview runners with prescan
packages/queue  Postgres SKIP-LOCKED queue (reference claim implementation)
packages/shared domain types shared end-to-end
```

## Verified behavior

`pnpm test` exercises, against a real booted server and real git client:

- anonymous clone of a public repo; empty-repo clone → first push
- PAT-authenticated push; unauthenticated push rejected
- register/login/logout; anonymous mutations get 401; PATs and SSH keys are session-scoped
- PR close/reopen syncs the linked intent status; merge marks it done
- repo file viewer resolves blobs at any depth; org page lists repos
- sandbox blocks `curl | sh` lifecycle scripts before executing anything
- queue claims are SKIP-LOCKED safe; retries with backoff until max attempts
- push to `i1-*` branch → PR auto-opened against intent #1, linked via `intent_links`
- AI review job posts inline `review_comments`; preview job records a sandbox build
- squash merge updates the base branch and marks the PR merged
- semantic index job chunks+embeds files; Q&A cites the pushed file with line ranges
- diff parser line-anchor correctness; deterministic heuristic findings; embedder sanity; malicious-install-script blocking
- star/watch toggles with counts; fork mirrors git data under the forker's personal org with lineage; collision-suffixed fork names
- commit history page, commit detail diff page, compare page (commits + diff + "open PR" flow)
- SSH transport: clone + push with a registered key, unknown keys rejected, non-members cannot fetch private repos over SSH
- webhooks: ping on creation, push/pull_request/pr_merged events delivered with valid HMAC-SHA256 signatures, delivery log recorded, `file://` URLs rejected, deleted hooks stop delivering
