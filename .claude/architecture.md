# ARCHITECTURE.md — System Architecture

This document describes how the AI Code Review & PR Quality Bot fits
together in detail. See `project_scope.md` for the product-level scope and
phase plan, `error_handling.md` for failure handling, and
`../docs/decisions/` (ADRs) for why specific choices were made — in
particular [ADR 0002](../docs/decisions/0002-github-actions-trigger-instead-of-webhook-queue.md),
which this document assumes throughout.

## 1. Assumptions made explicit

A few implementation details aren't pinned down in `project_scope.md` and
are assumed here per `../CLAUDE.md` §11 ("state the assumption and
proceed"). Flag any of these if wrong before Phase 0:

- **Language**: TypeScript, for the backend service. Reason: the LLM
  structured-output contract (Section 9) and the Postgres schema
  (Section 5) are much safer with compile-time types, and the service's
  request/response contract with the GitHub Actions workflow benefits from
  a typed schema too (Zod, validated on the way in).
- **Default LLM model**: Claude Haiku 4.5, via a configurable
  `ANTHROPIC_MODEL` env var (Section 12). Reason: the findings this
  service produces are close to structured classification/extraction, a
  task Haiku handles well, and this call runs on every PR push — cost per
  run matters more here than it would for an occasional task. Sonnet
  remains available as an explicit override for anyone who wants deeper
  judgment at a higher per-run cost, without a code change.
- **ORM**: Prisma. Reason: satisfies `../CLAUDE.md` §8's "ORM's query
  builder only, no raw SQL" rule, and its migration workflow satisfies
  "all schema changes go through migrations."
- **Comment-posting mechanism**: `actions/github-script` (or the `gh` CLI)
  inside the workflow, not a separate compiled tool. Reason: it's a small
  amount of logic, runs once per workflow trigger, and keeping it as a
  workflow-local script avoids building and versioning a whole separate
  CLI just to post a few comments.

## 2. Component Diagram

```
                     ┌───────────────────────────────┐
                     │  Target repo (e.g. this repo)  │
                     │  .github/workflows/pr-review.yml│
                     │  on: pull_request                │
                     └───────────────┬─────────────────┘
                                     │
                     Step 1: checkout + compute diff
                                     │
                                     ▼
                     Step 2: POST diff + PR metadata
                       Authorization: Bearer SERVICE_AUTH_TOKEN
                                     │
                                     ▼
                     ┌───────────────────────────────┐
                     │  Backend Service (1 container)  │
                     │  POST /review                    │
                     │  - verify shared secret           │
                     │  - validate payload (Zod)         │
                     │  - run deterministic pre-checks   │
                     │    (missing-test, secret-scan —   │
                     │    free, no LLM call)             │
                     │  - chunk remaining diff if needed │
                     │  - call Claude API (structured)   │
                     │    for judgment-based findings    │
                     │  - persist review + findings      │
                     │    (tagged deterministic | llm)   │
                     │  - return findings JSON            │
                     └──────┬────────────────────────────┘
                            │
                            ▼
                     ┌───────────────┐
                     │   PostgreSQL   │
                     │ repos / PRs /  │
                     │ reviews /      │
                     │ findings       │
                     └───────────────┘
                            │
              (HTTP response returns to the workflow)
                            │
                            ▼
                     Step 3 (same workflow): post comments
                       via GITHUB_TOKEN (gh CLI / github-script)
```

One process (the service) does diff analysis and persistence. GitHub
Actions does triggering, orchestration, and GitHub API writes. Why this
split instead of a self-hosted webhook + queue + worker:
[ADR 0002](../docs/decisions/0002-github-actions-trigger-instead-of-webhook-queue.md).

## 3. Component Responsibilities

| Component | Responsibility | Must NOT do |
|---|---|---|
| GitHub Actions workflow (target repo) | Trigger on PR events, compute the diff, call the service, post comments from its response | Never embed the Anthropic API key or DB credentials — those belong to the service only |
| Backend Service | Verify the shared secret, validate the request, run deterministic pre-checks, chunk the remaining diff, call Claude, persist to Postgres, return findings | Never call the GitHub API; never hold or need a GitHub token of any kind |
| Deterministic pre-checks (`lib/checks/`) | Catch missing-test-file and obvious-secret findings directly from the diff, at zero LLM cost | Must not attempt to replace the LLM for judgment-based categories (clarity, deeper security review, commit-message quality) — those genuinely need it |
| Postgres | Durable state: repos, PRs, reviews, findings | — |
| Claude API | Turn a diff into structured findings | Never receive full repo contents — diff + minimal context only (`../CLAUDE.md` §7) |

## 4. End-to-End Request Lifecycle (happy path)

1. Contributor opens/updates a PR on a repo that has the workflow
   installed (`.github/workflows/pr-review.yml`).
2. GitHub Actions runs the workflow on `pull_request`
   (`opened` / `synchronize` / `reopened`).
3. The workflow checks out the PR and computes the diff. For
   `synchronize` events, it diffs only the new commits (using the base/head
   SHAs GitHub provides in the event context), not the whole PR again.
4. The workflow sends `POST /review` to the backend service with the diff,
   PR metadata (`repo full_name`, `github_repo_id`, `pr_number`, `title`,
   `author`, `action`), and `Authorization: Bearer <SERVICE_AUTH_TOKEN>`.
5. The service verifies the bearer token with a constant-time comparison.
   Mismatch → `401`, nothing processed or persisted
   (`error_handling.md` §3).
6. The service validates the payload shape (Zod). Malformed → `400`.
7. The service upserts `repos` and `pull_requests` rows (by
   `github_repo_id` / `github_pr_number`) and creates a `reviews` row with
   `status: 'in_progress'`.
8. The service runs the deterministic pre-checks (Section 7) over the raw
   diff — missing-test-file and secret-pattern findings are produced here,
   tagged `source: 'deterministic'`, with no LLM call involved.
9. If the diff exceeds the token budget, it's chunked per file/hunk
   (Section 8); any file too large even after chunking is marked `skipped:
   too_large` in that file's finding, not truncated silently
   (`error_handling.md` §5).
10. The service calls Claude with the structured-output schema
    (Section 9), including a summary of what the deterministic checks
    already found so the LLM focuses on judgment calls rather than
    duplicating them, wrapped in a timeout with the retry policy from
    `error_handling.md` §4. LLM-produced findings are tagged
    `source: 'llm'`.
11. The response is validated against the JSON schema. Invalid → one retry
    with a stricter prompt, then the review is marked `failed` with a
    reason (`error_handling.md` §5); the service returns an error response
    and the workflow's comment-posting step is skipped for this run.
12. Findings (both deterministic and LLM-sourced) are written to Postgres
    in the same transaction as the `reviews` row update
    (`error_handling.md` §7).
13. Before responding, the service checks each finding's
    `posted_as_comment` state against prior reviews for the same PR
    (`project_scope.md` §4.7) to avoid re-surfacing findings already
    posted. Only new findings are marked `posted_as_comment: true` and
    included as "new" in the response — see the known limitation on this
    in Section 10 below.
14. `reviews.status` → `completed`. The service responds `200` with the
    findings JSON (new findings + any explicitly skipped files) and
    token usage for the run is logged (`../CLAUDE.md` §7).
14. Back in the workflow: a step reads the response and posts inline
    comments (one per finding with a `file`/`line`) plus one summary
    comment, via the GitHub Review API (through `gh` CLI or
    `actions/github-script`), using the workflow's own `GITHUB_TOKEN`.
15. If comment posting fails partway, the workflow step should fail
    loudly (non-zero exit / clear log), not silently succeed
    (`error_handling.md` §6).

## 5. Data Model

```
repos
  id                 pk
  github_repo_id     unique, not null
  full_name          not null
  created_at         not null, default now()

pull_requests
  id                 pk
  repo_id            fk -> repos.id, not null, on delete cascade
  github_pr_number   not null
  title              not null
  author             not null
  status             enum(open, closed, merged), not null
  created_at         not null, default now()
  updated_at         not null, default now()
  unique(repo_id, github_pr_number)

reviews
  id                 pk
  pull_request_id    fk -> pull_requests.id, not null, on delete cascade
  triggered_by       enum(opened, synchronize, reopened), not null
  status             enum(in_progress, completed, failed), not null
  llm_model_used     not null
  tokens_used        not null, default 0
  created_at         not null, default now()

findings
  id                 pk
  review_id          fk -> reviews.id, not null, on delete cascade
  file_path          not null
  line_number        nullable (some findings are file-level, not line-level)
  category           enum(style, tests, security, clarity, commit_message)
  severity           enum(info, warning, critical)
  source             enum(deterministic, llm), not null
  message            not null
  posted_as_comment  boolean, not null, default false
  created_at         not null, default now()
```

All foreign keys enforced at the DB level with `ON DELETE CASCADE`
(`../CLAUDE.md` §8) — deleting a PR cleans up its reviews and findings.
`unique(repo_id, github_pr_number)` and a similar uniqueness constraint on
`(pull_request_id, file_path, line_number, category)` — checked across
*all* of a PR's reviews, not just the latest one — back the dedupe logic
in Section 4 step 13. `source` distinguishes findings the deterministic
checks produced for free from ones that cost an LLM call (Section 7) —
useful both for the prompt (Section 9 excludes re-deriving what's already
`deterministic`) and for reporting how much of a review's value came from
free logic versus paid tokens. Note: `repos` no longer has
`installation_id` — that field only made sense under the GitHub App model
(ADR 0001, superseded).

## 6. Service Authentication

The service is called only by a GitHub Actions workflow the repo owner
controls, not by an arbitrary third party the way GitHub's own webhook
delivery would be — so the auth model is simpler than HMAC-over-payload:

1. Generate a random secret; store it as a GitHub Actions secret
   (`SERVICE_AUTH_TOKEN`) in the target repo, and as an env var on the
   service.
2. The workflow sends it as `Authorization: Bearer <token>` on every
   request.
3. The service compares the received token against its configured value
   using a constant-time comparison (avoids leaking timing information
   about the secret, even though the threat model here is narrower than
   a public webhook endpoint).
4. No JWTs, no token exchange, no expiry/refresh — the secret is static
   and rotated manually if needed (documented in the README).

This intentionally has a smaller surface area than ADR 0001's GitHub App
JWT → installation-token flow, because the problem it's solving is
smaller: authenticating one known caller (your own workflow), not
verifying an inbound payload from GitHub's infrastructure.

## 7. Deterministic Pre-Checks (Before the LLM Call)

Not every finding needs an LLM to produce. Some are answerable outright by
a rule, and running them as plain diff/pattern checks is both free (no
token cost) and more reliable than asking an LLM to re-derive a rule it
might phrase inconsistently across runs. This section exists because of a
deliberate cost/quality tradeoff, not as an afterthought — see the
discussion that led here for the full reasoning; the short version is:
**use a free deterministic check wherever a rule can decide the answer
outright, and spend LLM tokens only on genuine judgment calls.**

v1 ships exactly two checks, both implemented in `lib/checks/`, run over
the raw diff before any chunking or LLM call:

1. **Missing-test-file check** (`lib/checks/missingTests.ts`) — for each
   changed file that looks like source code (not a test file, config file,
   or doc file), check whether a corresponding test file path also
   appears in the same diff. If not, emit a finding directly: category
   `tests`, severity `warning`. No LLM involvement.
2. **Secret-pattern scan** (`lib/checks/secretScan.ts`) — a regex scan of
   added lines (`+` lines) in the diff for common secret shapes (AWS-style
   access keys, generic `api_key = "..."` assignments, private-key PEM
   headers, etc.). Any match emits a finding directly: category
   `security`, severity `critical`. No LLM involvement.

Both are intentionally simple, repo-agnostic pattern/diff logic — not a
full linter or static-analysis integration. Running the *target* repo's
own linter (ESLint, etc.) as an additional input is a reasonable v2 idea
but out of scope for v1, since it would require detecting and running
that repo's specific toolchain (`project_scope.md` §3 non-goals).

**How this feeds into the LLM call**: findings from these checks are
tagged `source: 'deterministic'` in the data model (Section 5 — updated
schema), distinct from `source: 'llm'` for anything Claude produces. The
prompt sent to Claude (Section 9) includes a short summary of what the
deterministic checks already found for this diff, so the LLM is
instructed to focus on what only it can judge — clarity, security smells
beyond simple patterns, commit-message/PR-description quality, whether
existing test coverage actually looks adequate — rather than re-flagging
(possibly with different wording) something already caught for free.

**A check failing should never fail the whole review**: if a check throws
(e.g. on an unexpected diff shape), log it and skip that specific check
for that file — fall through to the LLM call rather than aborting the
request (`error_handling.md` §2).

This split also gives you a genuinely useful metric almost for free: the
ratio of `deterministic` to `llm` findings per review is a direct measure
of how much of the bot's value is coming from token spend versus free
logic — worth surfacing in the README as a real design decision you can
explain, not just an implementation detail.

## 8. Diff Chunking & Token Budget

- Diff is split per-file first; a single file's diff that's still too large
  is split per-hunk.
- Each chunk is sent as its own LLM call with the surrounding context
  lines the diff already includes (a few lines before/after each hunk) —
  never the full file or repository (`../CLAUDE.md` §7). The service does
  not fetch anything from GitHub itself; it only ever sees what the
  workflow includes in the request body.
- A running token budget for the whole review is tracked; if the budget
  would be exceeded, remaining files are marked `skipped: too_large` rather
  than truncated (`error_handling.md` §5).

## 9. LLM Structured Output Contract

Claude is called with tool-use / a JSON schema forcing this shape (never
regex-parsed free text — `../CLAUDE.md` §7):

```json
{
  "findings": [
    {
      "file_path": "string",
      "line_number": "number | null",
      "category": "style | tests | security | clarity | commit_message",
      "severity": "info | warning | critical",
      "message": "string"
    }
  ]
}
```

The schema is defined once in `lib/schemas/` (e.g. as a Zod schema, reused
for both the Claude tool definition and response validation) and the
prompt text lives in `/prompts/` as reviewable, diffable files
(`../CLAUDE.md` §7) — never inline strings. Note that `source` (Section 5)
is not part of what Claude returns — the service assigns
`source: 'llm'` to every finding merged from this schema, and
`source: 'deterministic'` to everything `lib/checks/` (Section 7)
produces directly. Keeping this outside Claude's own output avoids asking
the model to self-report something it has no reason to get right.

## 10. Re-review & Duplicate-Comment Avoidance

- `synchronize` events diff only the new commits (via the base/head SHA
  range GitHub provides in the Actions event context), not the full PR
  diff again.
- The service checks `findings.posted_as_comment` for an equivalent
  existing finding on the same PR before including a new finding as "to
  post" in its response.
- **Known limitation (v1)**: the service marks a finding
  `posted_as_comment: true` at the moment it returns the response — before
  the workflow's next step has actually posted the comment. If that step
  fails, the DB will disagree with GitHub's actual state (a finding marked
  posted with no comment behind it). A proper fix is an acknowledgement
  callback (`POST /review/:id/ack`) the workflow calls after successfully
  posting, deferred to Phase 6 (`implementation_plan.md`) rather than
  blocking v1 — this is a deliberate, documented tradeoff
  ([ADR 0002](../docs/decisions/0002-github-actions-trigger-instead-of-webhook-queue.md)),
  not an oversight.
- If a finding from a prior review no longer applies (line changed/removed),
  it's left as historical record in `findings` — not deleted, not
  re-posted.

## 11. Proposed Folder Structure

```
/
├── CLAUDE.md                    # repo root — Claude Code auto-loads this
├── .claude/                     # reference docs CLAUDE.md points to
│   ├── project_scope.md
│   ├── architecture.md          # this file
│   ├── error_handling.md
│   └── implementation_plan.md
├── docs/
│   ├── decisions/                # ADRs
│   │   ├── 0001-nextjs-plus-separate-worker.md   # superseded, kept for history
│   │   └── 0002-github-actions-trigger-instead-of-webhook-queue.md
│   └── docker-notes.md           # created if/when needed (Phase 5)
├── .github/
│   ├── workflows/
│   │   └── pr-review.yml         # triggers on pull_request, calls the service
│   └── scripts/
│       └── post-review-comments.js  # posts inline + summary comments via GITHUB_TOKEN
├── app/                        # Next.js App Router — the backend service
│   └── api/
│       └── review/route.ts     # POST /review — the one endpoint
├── lib/
│   ├── db/                     # Prisma client + repository helpers
│   ├── checks/                 # deterministic pre-checks (missing-test, secret-scan)
│   ├── llm/                    # Claude client, retry/timeout wrapper
│   ├── diff/                   # chunking logic
│   └── schemas/                # Zod schemas (findings, request payload)
├── prompts/                    # version-controlled LLM prompts
├── prisma/
│   ├── schema.prisma
│   └── migrations/
├── docker-compose.yml           # service + postgres only
├── Dockerfile
├── .env.example
└── README.md
```

Note what's gone compared to the superseded design: no `worker/` directory,
no `lib/queue/`, no `lib/github/` (the service never talks to GitHub), no
`Dockerfile.app` / `Dockerfile.worker` split — just one `Dockerfile`.

## 12. Environment Variables

| Variable | Used by | Purpose |
|---|---|---|
| `SERVICE_AUTH_TOKEN` | service (env var) + target repo (Actions secret) | Shared secret authenticating workflow → service requests |
| `ANTHROPIC_API_KEY` | service | Claude API auth |
| `ANTHROPIC_MODEL` | service | Which model to call — defaults to `claude-haiku-4-5-20251001` for cost (Section 1); override to a Sonnet model ID for higher-judgment reviews at higher per-run cost |
| `DATABASE_URL` | service | Postgres connection string |

`GITHUB_TOKEN` needs no setup — GitHub Actions provides it automatically
to every workflow run, scoped to that repo, and it's used only inside the
workflow (comment-posting step), never passed to or stored by the service.

## 13. Security Notes

- The service holding no GitHub token of any kind is the headline security
  property of this design (`../CLAUDE.md` §5, and see ADR 0002's
  Consequences) — a compromised service cannot write to, or read from, any
  GitHub repo.
- `SERVICE_AUTH_TOKEN` is still a secret: never logged, never in
  code/comments/commits, compared with a constant-time check
  (`../CLAUDE.md` §2).
- LLM prompts must never include secrets that might be present in a diff
  (e.g. if a PR accidentally adds a `.env` file) — treat diff content as
  untrusted input the same way any user input is treated (`../CLAUDE.md` §5).
- The workflow's `GITHUB_TOKEN` should be scoped to the minimum
  permissions needed to read the PR and write comments (`permissions:` block
  in the workflow YAML), not left at default broad access.