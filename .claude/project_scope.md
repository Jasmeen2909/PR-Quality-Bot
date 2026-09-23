# AI Code Review & PR Quality Bot — Project Scope

## 1. Overview

A service that analyzes GitHub Pull Request diffs with an LLM and posts
structured, useful feedback directly on the PR — inline comments on
specific lines plus a summary comment — before a human reviewer looks at
it.

**Trigger model**: a GitHub Actions workflow (added to whichever repo is
being reviewed) fires on PR events, computes the diff, and calls this
project's backend service over HTTP. The service analyzes the diff and
returns structured findings; the same workflow then posts those findings
as PR comments using GitHub's built-in `GITHUB_TOKEN`. See
[ADR 0002](../docs/decisions/0002-github-actions-trigger-instead-of-webhook-queue.md)
for the full reasoning, and
[ADR 0001](../docs/decisions/0001-nextjs-plus-separate-worker.md) (now
superseded) for the original self-hosted-webhook design this replaced.

The goal is to act as a reliable "first-pass reviewer": catching the
boring-but-important issues (style, missing tests, unclear commits, obvious
security smells) so human reviewers can spend their time on logic and
design.

This project intentionally combines several skill areas into one build:
- Engineering best practices (linting, clean code, git hygiene, PR review)
- Docker-based local development
- Backend engineering fundamentals (API design, auth, DB, request handling)
- Applied use of LLM APIs (structured outputs, tool calling, prompting)
- CI/CD literacy (GitHub Actions workflows as a real orchestration layer)
- Documentation & knowledge sharing

## 2. Goals

| Goal Area | How This Project Satisfies It |
|---|---|
| Engineering Best Practices | Encodes lint/clean-code rules into the bot's logic; own PRs on this repo are reviewed by the bot itself |
| Docker Fundamentals | docker-compose for the backend service + Postgres; documented container-based dev environment |
| Backend Engineering Fundamentals | Request auth, REST API design, Postgres schema design, structured request/response handling |
| OpenAI/LLM Application | Structured JSON outputs, tool calling, prompt design for code review tasks |
| Documentation & Knowledge Sharing | README, architecture doc, ADRs recording real design decisions (including this one) |

## 3. Non-Goals (explicitly out of scope for v1)

To keep this shippable, the following are **not** part of the initial build:
- Multi-LLM provider abstraction (pick one provider, one model, ship it)
- Fine-tuning or training custom models
- Supporting non-GitHub platforms (GitLab, Bitbucket)
- A full web dashboard/UI (a minimal read-only view is optional, not required)
- Team/org billing, multi-tenant SaaS features
- Auto-merging or auto-fixing code (bot only comments, never modifies code)
- A GitHub App / webhook receiver of any kind (deliberately removed —
  see ADR 0002)
- An acknowledgement callback confirming a comment was actually posted
  before marking it `posted_as_comment` in the DB (known v1 limitation,
  see ADR 0002 Consequences; candidate for Phase 6 polish)
- Integrating the *target* repo's own linter/static-analysis output as an
  additional input to the review (would require detecting and running
  that repo's specific toolchain; v1 uses only its own lightweight,
  repo-agnostic deterministic checks — `architecture.md` §7)

These can become "v2" ideas once the core loop works end-to-end.

## 4. Core Features (v1 scope)

1. **GitHub Actions workflow** (lives in the target repo, e.g. this
   project's own repo) — triggers on `pull_request` events (`opened`,
   `synchronize`, `reopened`), checks out the PR, computes the diff.
2. **Backend service request handling** — a single HTTP endpoint that
   accepts a diff + PR metadata, authenticated by a shared secret
   (`SERVICE_AUTH_TOKEN`) rather than a GitHub-issued signature.
3. **Diff analysis** — the service chunks the diff if needed and sends it
   to the LLM with a structured-output schema.
4. **Findings** — LLM returns a JSON list of findings, each with: file, line,
   category (style / tests / security / clarity / commit-message), severity,
   and a human-readable explanation.
5. **Persistence** — every PR, review run, and finding is stored in Postgres
   for history and to avoid duplicate/redundant re-analysis. The service
   returns findings to the caller (the workflow) along with which ones are
   new since the last review.
6. **Posting feedback** — a later step in the *same* GitHub Actions
   workflow posts inline review comments on affected lines plus one summary
   comment, using the workflow's own `GITHUB_TOKEN`. The service itself
   never calls the GitHub API.
7. **Re-review on new commits** — if a PR is updated, only the new diff is
   sent for analysis (not the whole PR again), and previous bot comments
   are not duplicated.
8. **Deterministic pre-checks** — a missing-test-file check and a
   secret-pattern scan run over the diff before any LLM call, at zero
   token cost. The LLM is reserved for genuine judgment calls (clarity,
   deeper security review, commit-message quality) it's told not to
   duplicate what these checks already found. See `architecture.md` §7.

## 5. Architecture

```
Target repo's GitHub Actions workflow (on: pull_request)
   │
   ├─ 1. Checkout PR, compute diff
   │
   ├─ 2. POST diff + PR metadata to backend service
   │       Authorization: Bearer <SERVICE_AUTH_TOKEN>
   │
   ▼
Backend Service (single container)
   ├─ Verify shared secret
   ├─ Validate payload
   ├─ Chunk diff if it exceeds token budget
   ├─ Call LLM API (structured JSON output)
   ├─ Store review + findings in Postgres
   └─ Return findings JSON (marking which are new)
   │
   ▼
Postgres
   ├─ repos
   ├─ pull_requests
   ├─ reviews
   └─ findings
   │
   │ (response returns to the workflow)
   ▼
Same GitHub Actions workflow, next step
   └─ Post inline + summary PR comments via GITHUB_TOKEN
      (gh CLI / actions/github-script)
```

Full component breakdown and end-to-end request lifecycle: `architecture.md`.

## 6. Tech Stack

| Layer | Choice | Notes |
|---|---|---|
| Trigger / orchestration | GitHub Actions workflow, in the target repo | Replaces the webhook receiver + queue entirely — see ADR 0002 |
| Backend service | Next.js (API route), single container | One process — no separate worker (unlike the superseded ADR 0001 design) |
| Database | PostgreSQL via Supabase | Matches backend goal directly |
| LLM | Claude API — Haiku by default (`ANTHROPIC_MODEL`) | Structured outputs required; Haiku chosen for cost, since this runs on every PR push — see `architecture.md` §1 |
| Auth (workflow → service) | Shared secret (`SERVICE_AUTH_TOKEN`), bearer token, constant-time compare | Not HMAC — there's no third-party webhook payload to distrust the same way |
| Auth (service → GitHub) | None — the service never calls the GitHub API | Comment posting happens inside the workflow using its own `GITHUB_TOKEN` |
| Containerization | Docker + docker-compose | service + Postgres only — no Redis, no worker |
| Deployment | Local-only (docker-compose) | Demo captured via screenshots/screen recording for portfolio use, not self-hosted for v1 |

## 7. Data Model (initial draft)

```
repos
  id, github_repo_id, full_name, created_at

pull_requests
  id, repo_id (FK), github_pr_number, title, author, status, created_at, updated_at

reviews
  id, pull_request_id (FK), triggered_by (opened/synchronize), status,
  llm_model_used, tokens_used, created_at

findings
  id, review_id (FK), file_path, line_number, category, severity,
  source (deterministic | llm), message, posted_as_comment (bool)
```

Full schema with constraints and cascade rules: `architecture.md` §5. Note
`repos` no longer has an `installation_id` — that field existed only for
GitHub App auth, which no longer exists (ADR 0002). `source` distinguishes
findings the deterministic checks (§4.8) produced for free from ones an
LLM call produced — see `architecture.md` §7.

## 8. Build Phases

| Phase | Deliverable |
|---|---|
| 0 — Scaffold | Repo, tooling, folder skeleton, `.github/workflows/` skeleton |
| 1 — Service Skeleton + Workflow Trigger | GitHub Actions workflow calls the service; service verifies the shared secret and logs the request |
| 2 — Diff + LLM | Service chunks the diff, sends it to the LLM, returns structured JSON |
| 3 — Persistence | Store repos/PRs/reviews/findings in Postgres |
| 4 — Comment Posting | Workflow step posts inline + summary comments from the service's response, via `GITHUB_TOKEN` |
| 5 — Dockerize | docker-compose for service + Postgres; setup docs written alongside |
| 6 — Polish | Handle large diffs, LLM rate limits, re-review logic, dedupe hardening, ack-callback for comment-posting confirmation |

Step-by-step breakdown of each phase, including branch names and
verification steps: `implementation_plan.md`.

## 9. Success Criteria (mapped to quarterly goals)

- Bot successfully reviews PRs on at least one real repository — this
  project's own repo, via its own GitHub Actions workflow, is sufficient.
- All services run via a single `docker-compose up` with documented setup.
- README and architecture doc are complete enough that another developer
  could set this up (including adding the workflow to a new target repo)
  without asking questions.
- At least one internal presentation/write-up sharing what was learned
  (LLM structured outputs, GitHub Actions as an orchestration layer,
  request/response API design without a queue).
- Bot's own review history on this repo's PRs serves as a demonstrable
  artifact (screenshots/logs) for resume/portfolio use.

## 10. Resolved Decisions

- **Trigger/orchestration**: GitHub Actions workflow in the target repo,
  not a self-hosted webhook receiver. Rationale in
  [ADR 0002](../docs/decisions/0002-github-actions-trigger-instead-of-webhook-queue.md).
- **Backend**: a single Next.js (API route) service — no separate worker,
  no queue. This decision supersedes part of
  [ADR 0001](../docs/decisions/0001-nextjs-plus-separate-worker.md) (see
  ADR 0002 for what changed and why).
- **LLM provider**: Claude API. Chosen over OpenAI (the certification-aligned
  option) specifically to get hands-on experience with a different provider's
  structured outputs/tool calling.
- **Deployment**: Local-only via `docker-compose`, with a recorded demo
  (screen recording / screenshots) for the portfolio. Self-hosting
  (Railway/Render/Fly.io) is deferred, not required for v1.