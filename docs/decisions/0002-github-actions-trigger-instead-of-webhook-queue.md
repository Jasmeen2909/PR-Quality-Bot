# ADR 0002: GitHub Actions as trigger/orchestrator instead of a self-hosted webhook receiver + queue + GitHub App

## Status

Accepted — 2026-09-22. Supersedes [ADR 0001](0001-nextjs-plus-separate-worker.md).

## Context

The original design (ADR 0001) had this project's own service receive GitHub
webhooks directly: verify an HMAC signature, enqueue a job on a self-hosted
BullMQ + Redis queue, run a separate always-on worker process that
authenticates as a GitHub App (JWT → installation token) to fetch the diff
and post comments.

On review, most of that infrastructure exists to solve problems GitHub
Actions already solves for free, for any repo where you're willing to add a
workflow file instead of installing a GitHub App:

- **Triggering** — `on: pull_request` in a workflow file replaces a
  publicly-reachable webhook endpoint entirely.
- **Authenticating the trigger** — GitHub Actions' own execution model
  replaces HMAC signature verification; there's no arbitrary third party
  sending you a payload to distrust in the same way.
- **Queueing / decoupling** — GitHub Actions already queues and retries
  workflow runs; a self-hosted BullMQ + Redis queue duplicates this.
- **GitHub API write access** — the `GITHUB_TOKEN` GitHub Actions injects
  automatically, scoped to that repo, replaces GitHub App JWT/installation
  token management entirely.

None of the above teaches anything specific to *this* project once
understood once — they're generic webhook/infra patterns. What's left after
removing them (diff chunking, structured LLM calls, schema design,
persistence, Docker, request/response API design) is exactly the part that
maps to this project's actual learning goals
(`../../.claude/project_scope.md` §2).

## Decision

1. **A GitHub Actions workflow, added to whichever repo is being reviewed**
   (this project's own repo, to start), triggers on `pull_request`
   (`opened`, `synchronize`, `reopened`). It computes the diff locally
   (already checked out by the workflow) and does **not** need a webhook
   receiver on our side at all.
2. The workflow sends the diff + PR metadata as an HTTP request to **our
   backend service** — a single containerized app, no separate worker,
   no queue. Auth between the workflow and the service is a **shared
   secret** (`SERVICE_AUTH_TOKEN`, stored as a GitHub Actions secret in the
   target repo and as an env var on the service), sent as a bearer token
   and compared with a constant-time check.
3. The service **never calls the GitHub API and never holds a GitHub
   token of any kind.** It receives a diff, chunks it if needed, calls
   Claude with the structured-output schema, persists the review and its
   findings to Postgres, and returns the findings as its HTTP response.
   This is a meaningful security improvement over ADR 0001's design too: a
   compromised service can leak your Claude usage and your own DB, but it
   has no path to write to (or even read from) any GitHub repo.
4. A step later in the **same workflow** takes the service's response and
   posts the inline + summary PR comments, authenticated with the
   automatically-provided `GITHUB_TOKEN` — via `gh` CLI or
   `actions/github-script`. This logic lives in
   `.github/scripts/post-review-comments.js` (or similar), version
   controlled like any other code.

## Consequences

- **Removed entirely**: the webhook receiver route, HMAC verification,
  BullMQ, Redis, the separate `worker` process, GitHub App registration,
  JWT signing, installation-token caching. `docker-compose.yml` drops from
  four services (`app`, `worker`, `postgres`, `redis`) to two
  (`service`, `postgres`).
- **Still built, still teaches real backend skills**: the service's HTTP
  API design (request validation, auth, timeouts, error responses), diff
  chunking under a token budget, structured LLM calls with retries, a
  proper Postgres schema with migrations, and Docker packaging.
- **New tradeoff to accept for v1**: the service marks a finding as
  "will be posted" in Postgres at the moment it returns the response to
  the workflow, before the workflow's comment-posting step has actually
  run. If that later step fails (e.g. the PR was closed in the gap, or a
  transient GitHub API error), the DB will say `posted_as_comment: true`
  for a finding no comment actually exists for. A proper fix (an
  acknowledgement callback from the workflow back to the service after
  posting succeeds) is deferred to Phase 6 polish
  (`../../.claude/error_handling.md` §6) rather than blocking v1 — flagged
  here so it's a known, deliberate gap, not an oversight.
- **New constraint**: the service call from the workflow is synchronous —
  the workflow step waits for the HTTP response, which includes the full
  LLM analysis time. This is fine (GitHub Actions jobs can run for hours
  by default), but means a very large diff now makes the *workflow run*
  slow rather than a background worker, which is a fair tradeoff given
  there's no external caller waiting on a webhook response the way there
  would be for GitHub's own webhook delivery timeout.
- **Portability note**: since the workflow file lives in the *target*
  repo (not this project's repo), reviewing a second repo means adding the
  same workflow file there too, pointed at the same running service. This
  is arguably a feature — it mirrors how real GitHub Actions/Apps get
  adopted repo-by-repo — but is worth naming explicitly since ADR 0001's
  GitHub App model would have made "install on repo B" a UI action instead
  of a file to add.

## Alternatives considered

- **Keep ADR 0001's design as-is**: rejected — the queue, webhook auth,
  and GitHub App auth are the least project-specific parts of the build
  and the most generic "infrastructure plumbing," while adding the most
  moving parts to operate and debug.
- **GitHub Actions calls Claude directly, no separate service at all**:
  simplest possible option, but removes the backend-fundamentals goal
  (no API design, no Docker, no Postgres) almost entirely — rejected as
  under-shooting the learning goals in `../../.claude/project_scope.md` §2.
- **Service posts comments itself, using a token passed through from the
  workflow**: considered, but keeping the service fully GitHub-API-free
  is a cleaner security boundary and a clearer teaching split (the
  service is "diff in, findings out"; GitHub interaction is entirely the
  workflow's job) — rejected in favor of the chosen design.
