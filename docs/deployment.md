# Deployment

## Branch flow

```
feature/<name> ──PR──▶ develop ──PR──▶ staging ──PR (after QA sign-off)──▶ main
                         │               │                                    │
                         ▼               ▼                                    ▼
                  deploys to dev   deploys to QA                     deploys to production
```

- Work happens on `feature/*` branches, merged to `develop` by pull request.
- To release, open a PR `develop → staging`. When it merges, QA tests on the QA site.
- After QA approves, open a PR `staging → main`. Merging it deploys to production.
- Urgent fixes: `hotfix/*` from `main`, PR into `main`, then merge `main` back into
  `staging` and `develop`.
- The CI job **Branch promotion rules** rejects PRs into `main` from anything but
  `staging`/`hotfix/*`, and into `staging` from anything but `develop`/`hotfix/*`.

## What runs on each change

| Event | GitHub Actions | Railway |
| --- | --- | --- |
| PR opened/updated | CI: lint, typecheck, tests, build, migrations on Postgres 16, promotion rules | PR environment, if enabled |
| Merge to `develop` | CI | Deploys `development` once CI is green |
| Merge to `staging` | CI | Deploys `staging` once CI is green |
| Merge to `main` | CI | Deploys `production` once CI is green |
| Successful Railway deploy | Smoke test against the deployed URL | — |

Each Railway deploy (`railway.json`):

1. **Build:** `npm run build`
2. **Pre-deploy:** `npm run migrate -w server`, which applies pending migrations to that
   environment's database. If it fails, the deploy stops and the old version keeps running.
3. **Start:** `npm start`
4. **Health check:** Railway waits for `GET /readyz` to return 200 (database reachable,
   migrations applied, worker healthy) before switching traffic. If it never does, the
   new deployment is discarded and the old one stays live.

## Why an unapproved push can't reach production

1. `main` is protected: no direct pushes, changes only by PR with an approving review and
   green CI (configure in GitHub, see below).
2. PRs into `main` may only come from `staging`; anything on `staging` came through a
   reviewed PR from `develop` and was deployed to QA first.
3. Railway's production service tracks `main` only, with **Wait for CI** on.
4. Production refuses to boot without its required configuration.

### GitHub settings to apply (repo admin)

Settings → Rules → Rulesets → New branch ruleset:

- **Target:** `main`
  - Restrict deletions; block force pushes
  - Require a pull request: 1 approval; dismiss stale approvals; require approval of the
    most recent push
  - Require status checks: `Lint, typecheck, test, build`, `Migrations on Postgres 16`,
    `Branch promotion rules`; require branches to be up to date
  - Bypass list: empty
- **Target:** `staging`: same, with approvals set by the team's QA owner.
- **Target:** `develop`: require PR + the status checks (approval optional).

Settings → Environments: create `production` with **Required reviewers** if you want an
additional manual gate on the GitHub side (used by deployment statuses).

### Railway settings to apply

For each environment, on the `web` service → Settings:

- **Source:** this repo; branch `develop` / `staging` / `main` respectively.
- **Wait for CI:** on.
- **Healthcheck path:** `/readyz` (also set by `railway.json`).
- Production only: restrict who can deploy in Project Settings → Members (viewers can't
  deploy or edit variables).

## QA approval

QA approval is the review on the `staging → main` pull request. The QA checklist lives in
the PR template. Nothing reaches `main` without that approving review.

## Smoke tests

```bash
node scripts/smoke.mjs https://qa.example.com
EXPECT_ENV=production node scripts/smoke.mjs https://app.example.com
```

They run automatically after each successful Railway deployment (GitHub
`deployment_status` event, `.github/workflows/smoke.yml`) and can be started by hand from
the Actions tab.

## Rollback

- **App:** Railway → service → Deployments → pick the last good deployment → **Redeploy**
  (or **Rollback**). Takes about a minute. Then revert the bad commit on `main` by PR so the
  next deploy doesn't bring it back.
- **Database:** migrations are forward-only. Because every migration must stay compatible
  with the previous release (docs/database.md), rolling the app back doesn't require
  rolling the schema back. If a migration itself was wrong, ship a new migration that
  fixes it. Restoring a backup is the last resort (docs/database.md → Restore).

## Domains

The domains in this repo are placeholders. Once the real domain is chosen:

1. Railway → environment → `web` → Settings → Networking → **Custom Domain**, e.g.
   `app.<domain>`, `qa.<domain>`, `dev.<domain>`.
2. Add the CNAME (and TXT verification) records Railway shows at your DNS provider.
3. Wait for the certificate to be issued, then run the smoke test against the new URL.
