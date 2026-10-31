# Environments

| | Development | Staging (QA) | Production |
| --- | --- | --- | --- |
| Git branch | `develop` | `staging` | `main` |
| Domain (placeholder) | `dev.app.example.com` | `qa.app.example.com` | `app.example.com` |
| Railway environment | `development` | `staging` | `production` |
| Database | own Postgres | own Postgres | own Postgres |
| Launch27 | synthetic (`L27_MODE=mock`) | synthetic (`L27_MODE=mock`) | live |
| Launch27 writes | to the in-memory fake only | to the in-memory fake only | only if `L27_ALLOW_WRITES=true` |
| SMS / email / notifications | sandbox (never sent) | sandbox (never sent) | `NOTIFICATIONS_MODE` |
| RingCentral | sandbox server only | sandbox server only | production server |
| Channel simulator | on | on | off |
| Deploys | every push to `develop` after CI | every merge to `staging` after CI | merge to `main` after CI + QA approval |
| Banner | blue "DEVELOPMENT" | yellow "QA / STAGING" | none |

The domains are placeholders; real ones are configured only once chosen (docs/deployment.md).

## How the server knows where it is

`APP_ENV` if set, otherwise Railway's `RAILWAY_ENVIRONMENT_NAME`, otherwise `NODE_ENV`.
`qa` and `stage` mean staging, `dev` development, `prod` production. Anything unknown (for example a PR environment) is treated as
development (the safe direction).

`GET /healthz` reports it: `{"status":"ok","env":"staging","version":"<git sha>"}`.

## Guarantees enforced in code (not just configuration)

These hold even if someone sets the wrong variable in Railway:

- **Hosted dev/QA never talk to the real Launch27.** On Railway outside production,
  `L27_MODE=live` is overridden to `mock` with a warning in the logs.
- **No live Launch27 writes outside production.** Running locally against the real
  Launch27 is read-only; `L27_ALLOW_WRITES` is ignored.
- **No real messages outside production.** `NOTIFICATIONS_MODE=live` is overridden to
  `sandbox`; every channel connector is replaced by a stand-in that records the message
  as "sandbox: not sent to customer". RingCentral is disabled unless it points at the
  RingCentral sandbox.
- **Production won't start half-configured.** Missing `DATABASE_URL`, a short
  `SESSION_SECRET`, mock Launch27 or the simulator switched on all stop the process at
  boot; Railway keeps the previous deployment running.
- The post-deploy smoke test (`scripts/smoke.mjs`) fails if a non-production deployment
  reports anything other than mock data and sandbox notifications.

Tests for all of the above: `server/test/platform.test.js`.

## Data in dev and QA

Dev and QA never contain real customer data:

- Launch27 data comes from the built-in synthetic generator: invented names, `@example.com`
  emails, `555` phone numbers, plausible Ottawa addresses, deterministic per date so QA
  can reproduce issues. Edits made in the app apply to an in-memory copy and reset when
  the service restarts.
- Each environment's Postgres starts empty and is filled by the app and the Channel
  simulator.
- **Never** restore a production backup into dev or staging. There is no approved
  anonymization process; if one is needed later, it must be designed, reviewed and
  documented here first.
- Dev/QA services have no variable that references the production database, and Railway
  private networking doesn't cross environments.

Sign in to dev/QA with any email and the environment's `MOCK_PASSWORD`.

## Variables per environment

Templates without secrets: `deploy/development.env.template`,
`deploy/staging.env.template`, `deploy/production.env.template`. Every environment gets
its own `SESSION_SECRET`; never copy one between environments.

| Variable | Dev | Staging | Production |
| --- | --- | --- | --- |
| `APP_ENV` | development | staging | production |
| `L27_MODE` | mock | mock | live |
| `MOCK_PASSWORD` | set | set | — |
| `NOTIFICATIONS_MODE` | sandbox | sandbox | sandbox → live when connectors ship |
| `INBOX_SIMULATOR` | true | true | false |
| `SESSION_SECRET` | unique | unique | unique |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | `${{Postgres.DATABASE_URL}}` | `${{Postgres.DATABASE_URL}}` |
| `L27_ALLOW_WRITES` | — | — | true when ready |
| `LOG_LEVEL` | debug | info | info |

## Local development

```bash
npm install
cp .env.example .env   # defaults to synthetic data; password "demo"
npm run dev            # http://localhost:5173
```

Set `L27_MODE=live` locally to read real Launch27 data with your own login (read-only).
Without `DATABASE_URL` it uses an embedded Postgres in `.data/pglite`.

## Pull request environments (optional)

Railway can create a temporary environment for each PR (Project Settings → Environments →
"Enable PR Environments", based on `development`). Each gets its own Postgres and is
deleted when the PR closes. Worth turning on once more than one person builds features in
parallel; each one is billed while it exists.
