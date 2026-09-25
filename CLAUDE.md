# CLAUDE.md — Development Rules for This Repository

This file defines the rules Claude (or any AI assistant) must follow when
writing or modifying code in this repository. Read this before making any
changes. If a request conflicts with these rules, flag the conflict instead
of silently ignoring the rule.

## 1. Project Context

This is the **AI Code Review & PR Quality Bot**. Before doing any work,
read, in this order:

1. `.claude/project_scope.md` — what this project is, goals, non-goals,
   success criteria. Do not expand scope beyond what this file defines
   without explicit confirmation from the repo owner first.
2. `.claude/architecture.md` — system design, component responsibilities,
   data model, folder structure, and the resolved decisions (language,
   framework, ORM).
3. `.claude/implementation_plan.md` — the phase-by-phase build plan.
   **Follow this in order.** Do not start a later phase's branch until the
   current phase is merged and its Definition of Done (Section 12 below) is
   met.
4. `.claude/error_handling.md` — required error-handling patterns for every
   layer of the system.
5. `docs/decisions/` — Architecture Decision Records (ADRs). Check here
   before proposing to change something that was already decided (e.g. the
   backend framework) — if a decision needs revisiting, say so explicitly
   rather than silently working around it.

## 2. Default Interaction Mode: Guide, Don't Implement

The repo owner is building this project specifically to **learn** backend
engineering, Docker, and LLM integration — not just to get a working bot.
Because of this, default behavior differs from a typical coding assistant:

- **Do not write and commit code on your own initiative by default.** For
  each step in `.claude/implementation_plan.md`, explain what needs to be
  done and why, show the relevant snippet or approach, and let the repo
  owner write/type it themselves.
- Break work into small steps and pause after each one for the owner to
  implement it, rather than producing a whole phase's worth of files in one
  response.
- When explaining a step, include: what the code needs to do, why it's
  structured that way (tying back to `.claude/architecture.md` or
  `.claude/error_handling.md` where relevant), and what to watch out for.
- After the owner writes something, review it against the rules in this
  file rather than rewriting it wholesale — point out what to fix and why.
- **Exception — full autonomy on explicit request only.** If the owner
  says something like "just do it," "implement this yourself," "go ahead
  and write it," or similar for a specific task, implement it directly for
  that task. This does not change the default for later steps — return to
  guide-mode afterward unless told otherwise.
- If a task is pure boilerplate with no real learning value (e.g.
  scaffolding config files, `.gitignore`, dependency installs), it's fine
  to just do it without a big explanation — use judgment, but default to
  teaching for anything touching the app's actual logic (request handling,
  auth, chunking, LLM calls, DB writes, comment posting).

## 3. General Engineering Rules

- **No unexplained magic.** Every non-obvious decision (why a library, why a
  pattern) gets a one-line comment or a new ADR in `docs/decisions/`.
- **Small, reviewable commits.** One logical change per commit. No
  "misc fixes" or "wip" commit messages.
- **Conventional commits required**: `feat:`, `fix:`, `docs:`, `refactor:`,
  `test:`, `chore:`. Example: `feat: add service auth token verification`.
- **No commented-out code left in commits.** Delete it; git history keeps it.
- **No secrets, API keys, or tokens in code, comments, or commit messages.**
  All secrets go through environment variables (see `.env.example`).
- **Functions should do one thing.** If a function needs "and" to describe
  it, split it.
- **Prefer explicit over clever.** Readability beats brevity.

## 4. Linting & Formatting

- ESLint and Prettier configs in this repo are the source of truth — do not
  override rules inline (`// eslint-disable`) without a comment explaining
  why, and prefer fixing the underlying issue.
- All code must pass lint before being considered complete. Do not deliver
  code with known lint errors "to fix later."
- Run formatter before committing. No manual formatting debates.

## 5. Git & PR Workflow

- Every feature/fix goes on its own branch: `feature/<short-name>` or
  `fix/<short-name>`.
- No direct commits to `main`. All changes go through a PR, even solo.
- PR descriptions must explain **what** changed and **why**, not just repeat
  the commit list.
- This repo's own bot (once functional, from Phase 4 onward) should review
  its own PRs. Do not bypass or silence bot findings without a written
  reason in the PR thread.

## 6. Backend & API Rules

- The `/review` endpoint **must** verify the `SERVICE_AUTH_TOKEN` bearer
  token with a constant-time comparison before any processing. Reject
  missing/incorrect tokens with `401` immediately — no exceptions, even in
  local dev (use a test secret). See `.claude/architecture.md` §6 for why
  this is a shared secret rather than an HMAC-signed payload.
- Never trust client input. Validate and sanitize all incoming payloads
  before using them in DB queries or LLM prompts.
- Use parameterized queries / the ORM's query builder only. No raw string
  concatenation for SQL, ever.
- All API routes must have explicit error responses for: invalid input,
  auth failure, not found, and internal error. See
  `.claude/error_handling.md`.
- The service must never call the GitHub API and must never hold or
  request a GitHub token of any kind — GitHub interaction happens only
  inside the calling GitHub Actions workflow. See
  [ADR 0002](../docs/decisions/0002-github-actions-trigger-instead-of-webhook-queue.md).
  If a task seems to need the service to talk to GitHub directly, flag it
  before proceeding — that's a sign something has drifted from the
  architecture.
- The `/review` request is handled synchronously (no job queue — see ADR
  0002): give it a generous but explicit internal timeout so a stuck LLM
  call fails clearly rather than hanging indefinitely.

## 7. LLM Integration Rules

- All LLM calls that need structured data **must** use structured output /
  JSON schema enforcement — never regex-parse free-text responses.
- Every LLM call must have a timeout and a retry policy (see
  `.claude/error_handling.md`).
- Log token usage per review for cost tracking. Do not let this fall out of
  scope — it's needed to catch runaway costs early.
- Do not send full repository contents to the LLM. Only the relevant diff
  (plus minimal surrounding context) — respect token budgets, chunk large
  diffs rather than truncating silently.
- Prompts live in version-controlled files (`/prompts/`), not inline
  strings scattered across the codebase — they should be reviewable and
  diffable like code.

## 8. Database Rules

- All schema changes go through migrations. No manual schema edits against
  a running database.
- Every table needs `created_at` (and `updated_at` where rows are mutable).
- Foreign keys must be enforced at the DB level, not just in application
  logic.
- Destructive migrations (drops, renames) require a written note in the PR
  explaining backward-compatibility impact.

## 9. Docker Rules

- `docker-compose up` must be sufficient to run the entire stack locally
  with no undocumented manual steps.
- All environment-specific config goes through `.env` files, never hardcoded
  into `docker-compose.yml` or Dockerfiles.
- Keep images minimal — use slim/alpine base images where compatible, and
  multi-stage builds for anything with a build step.
- Document any non-obvious Docker networking or volume decisions in
  `docs/docker-notes.md`.

## 10. Documentation Rules

- Every new feature that changes setup, usage, or architecture requires a
  corresponding update to `README.md` or `.claude/project_scope.md` in the
  **same PR** — not as a follow-up task.
- Architecture diagrams should be kept in sync with actual implementation;
  if a diagram is now wrong, fix it or flag it.
- No feature is "done" until it's documented well enough that a new
  developer could use it without asking the author a question.

## 11. What To Do When Uncertain

- If a requirement is ambiguous, **do not guess silently** — state the
  assumption being made and proceed, or ask if the ambiguity is significant
  enough to cause rework.
- If a change would touch security-sensitive code (auth, request
  verification, secret handling), flag it explicitly even if not asked to.
- If asked to do something that contradicts a rule in this file, or a
  decision already recorded in `docs/decisions/`, say so before proceeding.

## 12. Definition of Done (applies to every task)

A task is not complete until:
- [ ] Code passes lint and formatting checks
- [ ] Errors are handled per `.claude/error_handling.md`
- [ ] Relevant docs are updated in the same PR
- [ ] No secrets or debug logging left in the code
- [ ] Changes are covered by at least a basic test where feasible
- [ ] Docker setup (if affected) still works end-to-end