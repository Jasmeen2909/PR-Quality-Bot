# ADR 0001: Next.js for webhook/API, separate Node process for the worker

## Status

~~Accepted — 2026-09-17~~ **Superseded — 2026-09-22** by
[ADR 0002](0002-github-actions-trigger-instead-of-webhook-queue.md), which
replaces the webhook receiver + queue + GitHub App with a GitHub
Actions-triggered service. The reasoning below (Next.js's request/response
model being a poor fit for a persistent worker) is kept for the historical
record, since it's still true — it's just no longer relevant, because there
is no worker process in the current design.

## Context

`../../.claude/project_scope.md` §10 left the backend framework as an open
question (Node/Express vs Python/FastAPI). The repo owner asked to use
Next.js instead.

Next.js's request/response model (API routes, and serverless deployment
targets like Vercel) is a good fit for the webhook receiver: verify the
HMAC signature, enqueue a job, return `202 Accepted` immediately (per
`../../.claude/error_handling.md` §3).

It is not a good fit for the BullMQ worker. The worker needs to be a
long-running process that stays alive polling/consuming the Redis queue,
runs the LLM call and GitHub API round-trips, and writes results to
Postgres. Next.js has no supported way to run that kind of persistent
background process inside the app itself — it can spawn code in response
to a request/route, not on its own between requests. Baking the worker into
a Next.js API route would mean triggering it via HTTP polling or piggybacking
it on webhook requests, which defeats the point of decoupling webhook receipt
from LLM processing (`../../.claude/project_scope.md` §5,
`../../.claude/error_handling.md` §3).

## Decision

Split the backend into two processes, run as separate services in
`docker-compose`:

1. **`app` (Next.js)** — hosts the webhook receiver API route and, later,
   the optional read-only dashboard UI. Verifies the GitHub HMAC signature
   and enqueues jobs onto the BullMQ queue.
2. **`worker` (plain Node.js script)** — long-running process, no framework,
   consumes the BullMQ queue: fetches the PR diff, calls the LLM, persists
   results, posts GitHub comments.

Both processes share the same codebase/package, importing common modules
(DB client, GitHub client, LLM client, job schemas) rather than duplicating
logic.

## Consequences

- Two processes to run and document instead of one — `docker-compose.yml`
  needs an explicit `worker` service alongside `app`, `postgres`, and
  `redis` (see `../../.claude/project_scope.md` §5 architecture diagram).
- `docker-compose up` must still start everything with no manual steps
  (per `../../CLAUDE.md` §9), so the worker's start command needs to be
  wired into compose from the start, not added later.
- If self-hosting is revisited post-v1, the two processes may need separate
  deployment targets (e.g. Next.js on Vercel, worker on a host that supports
  long-running processes) — noted here so it isn't a surprise later.
- Sets up the codebase to add the optional read-only dashboard
  (`../../.claude/project_scope.md` §3 non-goals) inside the same Next.js
  app later, at low incremental cost.

## Alternatives considered

- **Plain Express for everything**: simpler (one process, one framework,
  no mismatch), but rejected because the repo owner specifically wants
  Next.js experience and the project has no requirement to avoid it.
- **Worker logic inside a Next.js API route, triggered by polling or a
  cron-like external pinger**: rejected — adds an artificial polling
  mechanism, and still violates "never block the webhook response waiting
  on an LLM call" if not carefully decoupled.