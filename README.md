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
3. Generate a `SERVICE_AUTH_TOKEN` and put it in `.env`:
   ```bash
   openssl rand -hex 32
   ```
4. Start the dev server:
   ```bash
   npm run dev
   ```

Full setup including Postgres via `docker-compose` will be documented here
once it exists (Phase 5). For now, `docker compose up -d` starts a local
Postgres using the `POSTGRES_*` values from `.env`.

### Running checks

```bash
npm run lint          # ESLint
npm run format:check  # Prettier (use `npm run format` to fix)
npm test              # Vitest
```

## The `/api/review` endpoint

`POST /api/review` is the service's single endpoint. Right now it
authenticates the caller, validates the payload, logs the request, and
returns an empty findings list. Diff analysis arrives in Phase 2.

**Auth**: `Authorization: Bearer <SERVICE_AUTH_TOKEN>`.

**Request body** (JSON):

| Field       | Type   | Notes                                   |
| ----------- | ------ | --------------------------------------- |
| `repo`      | string | Repository full name, e.g. `owner/name` |
| `pr_number` | number | Positive integer                        |
| `diff`      | string | The PR diff text                        |
| `action`    | string | `opened`, `synchronize`, or `reopened`  |

**Responses**:

| Status | Meaning                                    |
| ------ | ------------------------------------------ |
| `200`  | `{ "findings": [] }` (stub until Phase 2)  |
| `400`  | Body is not valid JSON or fails validation |
| `401`  | Missing or incorrect token                 |
| `500`  | Server misconfigured (e.g. token not set)  |

Errors use the shape `{ "error": { "code": "...", "message": "..." } }`.

Try it locally with the dev server running:

```bash
curl -i -X POST localhost:3000/api/review \
  -H "Authorization: Bearer $(grep ^SERVICE_AUTH_TOKEN .env | cut -d= -f2)" \
  -H "Content-Type: application/json" \
  -d '{"repo":"me/test","pr_number":1,"diff":"x","action":"opened"}'
```

## Pointing a target repo at this service

The workflow in
[`.github/workflows/pr-review.yml`](.github/workflows/pr-review.yml) runs
on `opened`, `synchronize`, and `reopened` pull request events. It computes
the diff, POSTs it to this service, and logs the response.

To use it in a repository:

1. Copy `pr-review.yml` into that repo's `.github/workflows/` folder.
2. In the repo's **Settings > Secrets and variables > Actions**, add:
   - a **repository secret** `SERVICE_AUTH_TOKEN` with the same value as the
     service's `SERVICE_AUTH_TOKEN`
   - a **repository variable** `SERVICE_URL` with the service's public base
     URL, with no trailing slash (e.g. `https://example.com`)
3. Open a pull request. The workflow run's logs show the service's
   response.

The workflow runs on GitHub's servers, so it cannot reach a service on your
`localhost`. To test the full loop against a locally running service, expose
it with a tunnelling tool (for example `cloudflared` or `ngrok`) and set
`SERVICE_URL` to the tunnel's URL. Secrets and variables are not passed to
workflows triggered by pull requests from forks, so test from a branch in
the same repository.

To rotate the token, generate a new one, then update both the service's
`.env` and the repo's `SERVICE_AUTH_TOKEN` secret.
