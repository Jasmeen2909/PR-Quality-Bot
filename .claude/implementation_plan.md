# IMPLEMENTATION_PLAN.md — Step-by-Step Build Plan

This expands `project_scope.md` §8's phase table into concrete, ordered
steps, for the GitHub Actions-triggered architecture in
[ADR 0002](../docs/decisions/0002-github-actions-trigger-instead-of-webhook-queue.md).
Follow it top to bottom — each phase builds on the last and assumes the
previous phase's Definition of Done (`../CLAUDE.md` §12) is met.

**How to use this doc**: each phase = one or more branches
(`feature/<short-name>` per `../CLAUDE.md` §5). Do not start a phase's
branch until the previous phase is merged. Before opening a PR for any
step, run through the Definition of Done checklist in `../CLAUDE.md` §12.
Remember `../CLAUDE.md` §2 — work through each step with the repo owner,
don't implement whole phases unattended unless explicitly told to.

---

## Phase 0 — Repo & Tooling Setup

Not in `project_scope.md`'s phase table, but a prerequisite for everything
else — `../CLAUDE.md`'s rules (lint, conventional commits, branches) need
somewhere to apply.

Branch: `feature/project-scaffold`

1. `git init`; create `main` branch; push an empty initial commit.
2. Scaffold the Next.js app (TypeScript, App Router — see
   `architecture.md` §1 for why TypeScript) in the repo root. This app
   *is* the backend service — there's no separate worker to scaffold.
3. Set up ESLint + Prettier configs; commit them as the source of truth
   (`../CLAUDE.md` §4).
4. Set up `lib/` skeleton folders per `architecture.md` §11
   (`db/`, `checks/`, `llm/`, `diff/`, `schemas/`), each with a placeholder
   `index.ts`.
5. Write `.env.example` with the variable names from `architecture.md` §12
   (`SERVICE_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` — default
   `claude-haiku-4-5-20251001` — `DATABASE_URL` — no real values).
6. Write a minimal `README.md`: what this project is, prerequisites, "how
   to run" (to be filled in fully once `docker-compose up` exists in
   Phase 5), and a placeholder section for "how to point a repo at this
   service" (filled in during Phase 1).
7. Commit a `docker-compose.yml` skeleton with just a `postgres` service
   (no `service` yet — that needs a real Dockerfile first; no `redis` at
   all, per ADR 0002).
8. Create `.github/workflows/pr-review.yml` as a skeleton: trigger
   (`on: pull_request`) and a checkout step only — no HTTP call yet, that's
   Phase 1.
9. Verify `npm run lint` and `npm run format` pass on the empty scaffold.

**Definition of Done for this phase**: lint passes, README explains how to
install deps and run the dev server, no secrets committed.

---

## Phase 1 — Service Skeleton + Workflow Trigger (matches `project_scope.md` Phase 1)

Branch: `feature/service-skeleton-and-trigger`

1. Generate a `SERVICE_AUTH_TOKEN` value; add it to your local `.env`
   (never commit) and document the variable name in `.env.example`.
2. Implement `app/api/review/route.ts`:
   a. Read the `Authorization` header, extract the bearer token.
   b. Compare it to `SERVICE_AUTH_TOKEN` with a constant-time comparison
      (`architecture.md` §6). Mismatch → `401`
      (`error_handling.md` §3).
   c. Parse and validate payload shape (has `repo`, `pr_number`, `diff`,
      `action`). Invalid → `400`.
   d. For now: log the request (repo + PR number + action) as structured
      JSON (not `console.log` free text — `error_handling.md` §8) and
      respond `200` with a stub findings array (`{ findings: [] }`) — no
      LLM call yet, that's Phase 2.
3. Update `.github/workflows/pr-review.yml`:
   a. Add a step that computes the diff (e.g. `git diff` against the base
      ref GitHub Actions checks out, or use a diff action).
   b. Add a step that `curl`s (or uses `actions/github-script`) to
      `POST /review` on the service, with the diff, PR metadata, and
      `Authorization: Bearer ${{ secrets.SERVICE_AUTH_TOKEN }}`.
   c. Set `SERVICE_AUTH_TOKEN` as a GitHub Actions repository secret
      (documented in README, not committed anywhere).
   d. For now, just log the response — comment posting is Phase 4.
4. Tests: valid token → `200` + stub response logged; invalid token →
   `401`; malformed payload → `400`.
5. Update README: how to run the service locally, how to set
   `SERVICE_AUTH_TOKEN` as an Actions secret in the target repo, how to
   point the workflow's request URL at a locally-tunnelled service for
   testing (or note that local testing of the full loop needs the service
   publicly reachable — same caveat any webhook-free trigger has when
   testing against real GitHub Actions runs).

**Verify**: open a real PR against a test repo with the workflow file
committed; confirm the workflow runs, calls the service, and the service
logs the request and returns the stub response.

---

## Phase 2 — Deterministic Checks + Diff + LLM Call (matches `project_scope.md` Phase 2)

Branch: `feature/diff-llm-pipeline`

1. `lib/checks/missingTests.ts`: for each changed file in the diff that
   looks like source code, check whether a corresponding test file path
   also appears in the diff; if not, emit a `tests`/`warning` finding
   directly, tagged `source: 'deterministic'`. No LLM call
   (`architecture.md` §7).
2. `lib/checks/secretScan.ts`: regex scan of added (`+`) lines in the diff
   for common secret shapes (AWS-style keys, generic API key assignments,
   private-key PEM headers); emit `security`/`critical` findings directly,
   tagged `source: 'deterministic'`. No LLM call (`architecture.md` §7).
3. Wire both checks to run first, over the raw diff, before any chunking
   — a check throwing should be logged and skipped for that file, never
   abort the whole request (`error_handling.md` §2).
4. `lib/schemas/findings.ts`: define two related schemas — the findings
   schema Claude's tool call must match (`architecture.md` §9, no
   `source` field), and the full finding-record schema used internally
   and for persistence, which adds `source: 'deterministic' | 'llm'`
   (assigned by the service, never by Claude — `architecture.md` §9).
5. `lib/schemas/request.ts`: define and validate the incoming request
   payload shape (diff, repo metadata, PR metadata, action).
6. `/prompts/`: write the review prompt as a version-controlled file (not
   inline in code) — instructs the LLM to return findings in categories
   (style/tests/security/clarity/commit-message) with severity, and
   includes a short summary of what the deterministic checks already
   found so the LLM doesn't re-flag the same issue (`architecture.md` §7).
7. `lib/llm/claude.ts`: Claude API client wrapping the call with:
   - the model read from `ANTHROPIC_MODEL` (default
     `claude-haiku-4-5-20251001` — `architecture.md` §1)
   - the structured-output schema as a tool definition
   - a 30s timeout per chunk
   - the retry policy from `error_handling.md` §4 (2 retries, base 5s
     backoff on timeout/5xx)
   - response validation against the Zod schema; on invalid JSON, one
     retry with a stricter prompt, then fail
   - token usage logging per call (`../CLAUDE.md` §7)
   - findings from this client are tagged `source: 'llm'`
8. `lib/diff/chunk.ts`: chunking logic — split by file, then by hunk if a
   single file is still too large; track a running token budget; mark
   over-budget files `skipped: too_large` instead of truncating
   (`architecture.md` §8).
9. Wire it into `app/api/review/route.ts`: run deterministic checks →
   chunk the remaining diff → call LLM per chunk → merge deterministic +
   LLM findings → return the structured JSON in the response (no DB yet —
   that's Phase 3).
10. Tests: mock the Claude API; verify chunking triggers correctly on an
    oversized diff; verify the deterministic checks produce findings with
    zero LLM calls when run alone; verify a simulated LLM timeout
    triggers the retry-then-fail path (`error_handling.md` §11).

**Verify**: open a real PR, confirm the workflow's logged response now
contains both deterministic findings (immediate, no LLM cost) and
LLM-produced findings for whatever the pre-checks didn't cover.

---

## Phase 3 — Persistence (matches `project_scope.md` Phase 3)

Branch: `feature/db-persistence`

1. Add Prisma; define the schema from `architecture.md` §5
   (`repos`, `pull_requests`, `reviews`, `findings` — note: no
   `installation_id` column, that was GitHub-App-specific; `findings`
   does have a `source: deterministic | llm` column, per `architecture.md`
   §5 and §7) in `prisma/schema.prisma`.
2. Generate the first migration; commit it (`../CLAUDE.md` §8 — schema
   changes only via migrations).
3. `lib/db/`: repository-style helper functions (`upsertRepo`,
   `upsertPullRequest`, `createReview`, `saveFindings`) — no raw SQL
   anywhere, Prisma client only.
4. Wire `app/api/review/route.ts` to: upsert `repos`/`pull_requests` on
   receipt, keyed on `(repo_id, github_pr_number)` to avoid duplicate
   rows on a re-run; create a `reviews` row (`status: in_progress`) at
   request start; write `findings` + update `reviews.status` in a single
   transaction before responding (`error_handling.md` §7 — no partial
   writes).
5. On LLM/schema failure, still write the `reviews` row with
   `status: failed` and a reason — never drop a failed run silently
   (`error_handling.md` §4).
6. Implement the dedupe check from `architecture.md` §10: before including
   a finding as "new" in the response, check for an equivalent finding
   already marked `posted_as_comment: true` on this PR from a prior
   review.
7. Tests: upsert dedupes correctly on a re-run against the same PR state;
   a simulated mid-write DB error rolls back the whole transaction, not
   half of it; re-review of an unchanged PR returns zero new findings.

**Verify**: run the full flow against a real PR, then query Postgres
directly to confirm `repos`/`pull_requests`/`reviews`/`findings` rows exist
and are linked correctly by FK.

---

## Phase 4 — Comment Posting (matches `project_scope.md` Phase 4)

Branch: `feature/comment-posting`

1. Write `.github/scripts/post-review-comments.js`: takes the service's
   findings response, posts inline review comments (file + line) via the
   GitHub Review API, plus one summary comment listing all findings —
   using `actions/github-script`'s built-in authenticated `github` client
   (backed by `GITHUB_TOKEN`), not a hand-rolled auth flow.
2. Wire this script in as the final step of
   `.github/workflows/pr-review.yml`, consuming the previous step's
   response.
3. If posting fails partway (some inline comments succeed, summary fails,
   or vice versa), the step must log the partial state clearly and exit
   non-zero — don't report full success when only part of it worked
   (`error_handling.md` §6).
4. If the PR is closed/locked when posting is attempted, log and stop —
   don't retry indefinitely (`error_handling.md` §6).
5. Tests: a mocked findings response with a mix of new/already-posted
   findings only posts the new ones; a simulated "PR closed mid-run"
   error is logged and the step fails clearly rather than passing
   silently.

**Verify**: open a real PR, confirm inline + summary comments appear from
the workflow's bot identity (`github-actions[bot]`); push a new commit,
confirm no duplicate comments for unchanged findings.

---

## Phase 5 — Dockerize (matches `project_scope.md` Phase 5)

Branch: `feature/dockerize`

1. Write a single `Dockerfile` (Next.js, multi-stage build, slim base
   image — `../CLAUDE.md` §9).
2. Extend `docker-compose.yml` with the `service` alongside the existing
   `postgres` (from Phase 0), wired to the same `.env` file — no
   hardcoded config in the compose file itself (`../CLAUDE.md` §9). No
   `redis`, no `worker` service — per ADR 0002, they don't exist in this
   design.
3. Add a Prisma migration-run step to the service's startup so
   `docker-compose up` alone brings the DB schema up to date with no
   manual steps (`../CLAUDE.md` §9).
4. Document any non-obvious networking/volume decisions in
   `docs/docker-notes.md` — create this file only now, when there's an
   actual decision to record (`project_scope.md` §9 principle: don't
   pre-create empty docs).
5. Update `README.md`'s "how to run" section to be the single source of
   truth: clone, copy `.env.example` to `.env`, fill in secrets,
   `docker-compose up`, then how to add the workflow file + Actions secret
   to a target repo pointed at this running service.

**Verify**: on a clean checkout, `docker-compose up` alone brings up the
full stack (service + Postgres) and a real PR flows through end to end
with zero manual steps beyond filling in `.env` and the one Actions
secret.

---

## Phase 6 — Polish (matches `project_scope.md` Phase 6)

Branch per item below (small, separately reviewable — `../CLAUDE.md` §3):

1. `feature/large-diff-hardening` — stress-test chunking against a very
   large real-world diff; confirm no silent truncation, budget tracking is
   accurate.
2. `feature/rereview-hardening` — edge cases in re-review: PR force-pushed
   (history rewritten), PR base branch changed.
3. `feature/comment-dedupe-hardening` — edge cases in duplicate-comment
   avoidance: a finding's line shifts due to unrelated changes earlier in
   the file.
4. `feature/posting-ack-callback` — close the known gap from
   `architecture.md` §10 / ADR 0002: add `POST /review/:id/ack`, called by
   the workflow's comment-posting step only after comments are
   successfully posted, so `posted_as_comment` in the DB reflects reality
   instead of being set optimistically.
5. `feature/failure-visibility` — implement the minimum-viable monitoring
   from `error_handling.md` §10: a query/report of `reviews.status =
   'failed'` grouped by category.
6. `feature/cost-visibility-reporting` — surface the `deterministic` vs
   `llm` finding-source ratio per review (`architecture.md` §7) somewhere
   visible (README example output, or a simple query) — a concrete,
   explainable number for how much of the bot's value comes from free
   checks versus paid LLM calls.

---

## Cross-cutting reminders (apply to every phase)

- Every LLM-related change: confirm prompts stay in `/prompts/`, never
  inline strings (`../CLAUDE.md` §7).
- Every schema change: goes through a Prisma migration, never a manual
  edit against a running DB (`../CLAUDE.md` §8).
- Every new error path: has at least one test simulating the failure
  (`error_handling.md` §11).
- Every PR: conventional commit messages, PR description explains what and
  why, this repo's own bot reviews its own PRs once Phase 4 is live
  (`../CLAUDE.md` §5).
- The service should never need a GitHub token, ever — if a step in the
  plan seems to require one, that's a signal something has drifted from
  ADR 0002 and is worth flagging before continuing.