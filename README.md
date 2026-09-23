# AI Code Review & PR Quality Bot

A service that analyzes GitHub Pull Request diffs with an LLM and posts
structured, useful feedback directly on the PR — inline comments on
specific lines plus a summary comment — before a human reviewer looks at
it. A GitHub Actions workflow in the target repo triggers on PR events,
computes the diff, and calls this service over HTTP; the service analyzes
the diff and returns structured findings, which the same workflow then
posts as PR comments. See [`.claude/project_scope.md`](.claude/project_scope.md)
for full project scope and [`.claude/architecture.md`](.claude/architecture.md)
for system design.

## Prerequisites

- Node.js 20+
- npm
- Docker (for running Postgres locally — full `docker-compose` setup lands
  in Phase 5)
- An Anthropic API key

## Running locally (dev)

1. Copy `.env.example` to `.env` and fill in real values:
   ```bash
   cp .env.example .env
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Start the dev server:
   ```bash
   npm run dev
   ```

Full setup including Postgres via `docker-compose` will be documented here
once it exists (Phase 5).

## Pointing a target repo at this service

TBD — this section is filled in during Phase 1, once the `/review`
endpoint and the calling GitHub Actions workflow exist.
