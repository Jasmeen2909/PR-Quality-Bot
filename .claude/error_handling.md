# ERROR_HANDLING.md — Error Handling Strategy

This document defines how errors must be handled across every layer of the
AI Code Review & PR Quality Bot. The goal: failures are visible, logged,
recoverable where possible, and never silently swallowed. It assumes the
architecture in `architecture.md` and
[ADR 0002](../docs/decisions/0002-github-actions-trigger-instead-of-webhook-queue.md)
— a GitHub Actions workflow calling a single backend service, no queue.

## 1. Guiding Principles

- **Fail loud in logs, fail gracefully to the caller.** Internal logs
  should have full detail; responses to the GitHub Actions workflow should
  be clean and not leak internals (stack traces, secrets, raw DB errors).
- **No empty catch blocks.** Every `catch` must either handle, log, re-throw,
  or explicitly comment why it's intentionally ignored.
- **Fail fast on unrecoverable errors** (bad config, missing required env
  vars) — crash on startup rather than running in a broken state.
- **Fail soft on partial/recoverable errors** (one file in a diff fails to
  analyze) — don't let one failure kill the whole PR review.

## 2. Error Categories

| Category | Examples | Handling Strategy |
|---|---|---|
| **Input/Validation errors** | Malformed request payload, missing required field | Reject with `400`, log the payload shape (not full contents if sensitive), do not process further |
| **Auth errors** | Missing/incorrect `SERVICE_AUTH_TOKEN` | Reject with `401`, log the attempt (not the token itself), alert on repeated failures (possible misconfiguration or probing) |
| **External API errors** | LLM API timeout/5xx | Retry with backoff (see Section 4), fall back gracefully, never crash the service process |
| **Database errors** | Connection lost, constraint violation | Retry transient errors (connection loss); constraint violations are logged and surfaced, not retried blindly |
| **LLM output errors** | Invalid JSON, schema mismatch, empty response | Reject the malformed output, retry once with a stricter prompt, then mark review as `failed` with reason logged |
| **Deterministic pre-check errors** | A check (`lib/checks/`) throws on an unexpected diff shape | Log it and skip that specific check for that file — never fail the whole review; fall through to the LLM call so the review still produces whatever it can (`architecture.md` §7) |
| **Internal/unexpected errors** | Null references, unhandled exceptions | Caught at the top-level handler, logged with full stack trace, generic error surfaced externally |
| **Comment-posting errors (in the workflow, not the service)** | GitHub API rate limit/5xx when posting comments, PR closed mid-run | Handled inside the GitHub Actions step — see Section 6 |

## 3. Service Request Handling Rules

- Auth failure (bad/missing `SERVICE_AUTH_TOKEN`) → respond `401`
  immediately, no processing, nothing persisted.
- Malformed payload → respond `400`, log the event type and repo (not full
  diff contents if the request logging policy calls for redaction).
- The request is handled **synchronously** — there is no queue to hand off
  to (ADR 0002). The service processes the diff fully (chunking, LLM
  calls, persistence) and returns `200` with the findings JSON, or an
  error status, as its actual HTTP response. The calling workflow step
  simply waits; GitHub Actions jobs can run far longer than a typical
  webhook delivery timeout, so this is an acceptable and simpler tradeoff
  than webhook-style "acknowledge immediately, process later."
- If the database is unreachable at request time, respond `503` so the
  workflow step fails clearly and can be manually re-run — there's no
  automatic redelivery mechanism the way GitHub's own webhook
  infrastructure provides, so a clear failure (visible in the Actions run)
  matters more here than it would behind a queue.

## 4. Retry Policy

| Failure Type | Retry Strategy |
|---|---|
| LLM API timeout or 5xx | Exponential backoff: 2 retries, base 5s |
| LLM output fails schema validation | 1 retry with a stricter/clarified prompt, then fail the review |
| Database connection error | 3 retries with 1s fixed delay, then fail the request and return `503` |
| Any 4xx from the LLM API (except rate limit) | No retry — this is a client-side/config error, fix the request instead |
| GitHub API errors when posting comments | Not handled by the service at all — see Section 6; this happens inside the GitHub Actions workflow |

All retries must be logged with attempt number and final outcome.
Requests that exhaust retries result in a `reviews` row with
`status: 'failed'`, and the service still returns a clear error response —
never a silent `200` with partial/wrong data.

## 5. LLM-Specific Error Handling

- Every LLM call must be wrapped with a timeout (recommended: 30s per
  chunk). Since the whole request is synchronous (Section 3), the overall
  request timeout should account for the largest realistic diff — set the
  workflow step's own timeout generously (e.g. several minutes) rather
  than tightly, since there's no background worker to fall back on.
- Responses must be validated against the expected JSON schema before use.
  Invalid JSON → treat as failure, do not attempt to "fix" it via further
  string manipulation.
- If a diff is too large for the token budget even after chunking, mark that
  file as `skipped: too_large` in findings rather than truncating content
  silently and reviewing incomplete context.
- Track and log token usage per call. If usage spikes unexpectedly
  (indicates a prompt bug or runaway loop), this should be visible in logs
  immediately, not discovered later via a bill.

## 6. Comment Posting Rules (in the GitHub Actions workflow)

This logic lives in `.github/scripts/post-review-comments.js`, run as a
step in the same workflow — not in the backend service (ADR 0002). It
still needs the same discipline as any other error-handling code:

- If posting a comment fails (e.g., permissions revoked, PR closed
  mid-run), the step must fail loudly — non-zero exit, clear log output —
  not swallow the error and report success.
- The service already excludes findings it considers already-posted
  (`architecture.md` §10), so this step should trust that list rather than
  re-implementing dedupe logic itself.
- If the summary comment fails but some inline comments succeeded (or vice
  versa), log the partial state clearly in the workflow output — don't let
  the step exit `0` when only part of it worked.
- **Known gap (v1, documented in ADR 0002)**: because the service marks
  findings `posted_as_comment: true` before this step runs, a failure here
  leaves the DB out of sync with GitHub's actual state. Phase 6 adds an
  acknowledgement callback to close this gap; until then, a failed
  comment-posting step should be treated as a signal to check the DB
  manually if it matters for that run.

## 7. Database Error Handling

- Use transactions for any multi-table write (e.g., creating a review +
  its findings together) — partial writes on failure are not acceptable.
- Constraint violations (e.g., duplicate PR record) should be handled
  explicitly (upsert logic), not treated as unexpected errors.
- Connection pool exhaustion or timeouts should trigger a clear log entry
  distinguishing "DB is down" from "query is malformed."

## 8. Logging Standards

- Structured logging (JSON logs), not free-text `console.log`.
- Every log entry for a request includes: timestamp, correlation ID
  (repo + PR number + review ID), severity, and message.
- Never log secrets (`SERVICE_AUTH_TOKEN`, `ANTHROPIC_API_KEY`) or full LLM
  prompts containing proprietary code beyond what's needed for debugging —
  redact where possible.
- Log levels used consistently:
  - `ERROR` — something failed and needs attention
  - `WARN` — recovered automatically but worth noting (e.g., retry succeeded)
  - `INFO` — normal lifecycle events (review started/completed)
  - `DEBUG` — verbose detail, off by default in production

## 9. Caller-Facing Error Responses

- API responses never expose stack traces, internal file paths, or raw
  database error messages to the calling workflow.
- Standard error response shape:

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Invalid or missing service auth token."
  }
}
```

- Internal errors return a generic message (`"Something went wrong,
  please try again later."`) with the real detail only in logs.

## 10. Monitoring & Alerting (minimum viable)

Even without a full observability stack, at minimum:
- Failed reviews (`status = failed`) should be queryable/reportable, not
  buried.
- A simple daily/weekly check (manual or scripted) of failure counts by
  category, to catch systemic issues (e.g., LLM schema drifting, prompt
  regressions).
- Since there's no queue to inspect, the GitHub Actions run history for
  the target repo's workflow doubles as a basic monitoring view — a
  failed step there is visible immediately without extra tooling.

## 11. Testing Error Paths

- Every error category above should have at least one test simulating the
  failure (e.g., mock a 500 from the LLM API, verify retry + eventual
  `failed` state, not a crash).
- Do not only test the happy path — a PR that only tests successful review
  generation is incomplete per `../CLAUDE.md`'s Definition of Done.
- The comment-posting script (Section 6) should be tested separately from
  the service — e.g. with a mocked findings response — since it runs in a
  different environment (the GitHub Actions runner) with different
  failure modes than the service itself.