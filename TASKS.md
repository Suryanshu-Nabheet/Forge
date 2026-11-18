# TASKS — FORGE-NEXT implementation checklist

> Protocol: work top-to-bottom. Tick `[x]` as each item completes. No placeholders in critical paths.

## Phase 2 — Foundation & Git transport engine
- [x] 2.1 Monorepo scaffold: `pnpm-workspace.yaml`, `turbo.json`, root `package.json`, `tsconfig.base.json`, `.gitignore`, `.env.example`
- [x] 2.2 `packages/shared` — domain types (DiffFile, ReviewAnalysis, Intent, JobPayloads, etc.)
- [x] 2.3 `packages/git` — storage root resolution, bare repo `init`, post-receive hook installer
- [x] 2.4 `packages/git` — plumbing wrappers (rev-parse, ls-tree, cat-file, rev-list, diff-tree) with typed results
- [x] 2.5 `packages/git` — diff builder: commit-to-commit unified diff → structured hunks with line anchors
- [x] 2.5b `packages/git` — `git archive` extraction helper (sandbox snapshots)
- [x] 2.6 Drizzle schema (all tables from ARCHITECTURE §4) + `db:push` + cosine-distance SQL function
- [x] 2.7 Better-Auth setup (email/password) + Drizzle adapter + session cookie for custom server
- [x] 2.8 PAT issuance/verification (sha256 at rest) + Basic/Bearer auth resolvers for git transport
- [x] 2.9 SSH key model (title/fingerprint/publicKey) + settings UI
- [x] 2.10 Custom Node server: forward to Next, serve `/git/*` via `git http-backend` CGI bridge, route `/internal/hooks/post-receive`
- [x] 2.11 post-receive → DB ref/commit sync + intent-pattern PR auto-open
- [x] 2.12 Verify end-to-end: `git clone` (anon + PAT), `git push` (PAT), branches/commits in DB

## Phase 3 — Core collaboration UI
- [x] 3.1 App shell: dark theme (Tailwind + shadcn-style tokens), top nav, ⌘K palette, toasts
- [x] 3.2 Dashboard `/` — repo list, activity feed
- [x] 3.3 Repo explorer: file tree, code viewer, branch switcher, commit history
- [x] 3.4 New repo page (`/new`) — creates org/repo + bare git dir + DB row + default branch
- [x] 3.5 Pull requests list + PR view: Monaco-style diff viewer, inline comments, merge box (merge/rebase/squash)
- [x] 3.6 Issues/intents list + detail: keyboard nav, statuses, labels, spec sections
- [x] 3.7 Settings: SSH keys + PATs UI
- [x] 3.8 Global search page + repo Ask page (semantic, citations)

## Phase 4 — AI-native layer
- [x] 4.1 `packages/ai` client: feature-detect `ANTHROPIC_API_KEY` → Claude mode | heuristic mode
- [x] 4.2 Review engine: diff → findings (security/logic/tests/risk) both modes, same output shape
- [x] 4.3 PR review job: triggered on PR open/update, posts inline `review_comments`, risk score on PR
- [x] 4.4 Embeddings: chunking (tree-sitter where available, else text chunks), local hash embedder (API mode wired)
- [x] 4.5 Semantic index job on push → `embeddings` rows; Ask endpoint → top-k chunks → cited answer
- [x] 4.6 Intent plan job: "Draft Implementation Plan" → structured plan into `intents.aiState.plan`
- [x] 4.7 Spec-to-PR: create branch `i{n}-{slug}` with INTENT.md scaffold, link intent ↔ PR via `intent_links`

## Phase 5 — Ephemeral sandbox runner
- [x] 5.1 `packages/sandbox` interface + feature detection (docker | process)
- [x] 5.2 Process adapter: git archive snapshot, sanitized env, timeout/output cap/concurrency semaphore, process-group kill
- [x] 5.3 Lifecycle-script prescan (block `curl|sh` install scripts)
- [x] 5.4 Preview job: on PR push → build → stream logs to `job_events` → SSE → PR page card + re-run
- [x] 5.5 Docker adapter (same interface, used when Docker up)

## Phase 6 — Verification & polish
- [x] 6.1 Seed script: demo org, users, PATs, repos, issues, PRs (incl. one vulnerable diff for AI review demo)
- [x] 6.2 Integration tests: git clone/push E2E, PAT auth, diff correctness, queue run, heuristic review determinism, sandbox build, Q&A citations, merge strategies
- [x] 6.3 `pnpm typecheck` green
- [x] 6.4 `pnpm test` green
- [x] 6.5 `pnpm build` green
- [x] 6.6 README.md with exact run commands
