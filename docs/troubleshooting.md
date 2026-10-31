# Troubleshooting

## Deploy failed

| Symptom (Railway) | Likely cause | Fix |
| --- | --- | --- |
| Build fails at `npm run build` | TypeScript error | Run `npm run check` locally; CI shows the same error |
| Pre-deploy fails | Migration error | Read the pre-deploy log. Old release is still live. Fix with a new migration (docs/database.md) |
| Crashes at start with `config: …` errors | Missing/unsafe config | Each `config:` log line names the variable, e.g. `SESSION_SECRET` or `DATABASE_URL`. Set it in that environment's variables and redeploy |
| Health check times out | `/readyz` returns 503 | `curl https://<host>/readyz`: `checks` says which part failed (database, migrations, worker) |
| Deploy didn't start after a merge | Waiting for CI, or wrong branch | Check the GitHub Actions run; check the service's source branch |

## `/readyz` says…

- `"database": "unreachable"`: wrong `DATABASE_URL`, Postgres down, or out of connections
  (lower `DATABASE_POOL_MAX`). Check the Postgres service in the same environment.
- `"migrations": "pending: 0003_…"`: the pre-deploy step didn't run. Run
  `railway run npm run migrate -w server` in that environment, or redeploy.
- `"migrations": "pending: …"` that won't go away, and `npm run migrate:status -w server`
  shows `changed`: an applied migration file was edited. Restore the original file from
  git and put the change in a new migration.
- `"worker": "failing (N in a row)"`: the background tick keeps throwing. Search the logs
  for `worker tick failed`.

## Sign-in problems

- **Dev/QA:** use any email and that environment's `MOCK_PASSWORD`.
- **"Not logged in" after a deploy:** `SESSION_SECRET` changed, or the database was reset.
  Sign in again.
- **Production login fails for everyone:** check Launch27 itself is up; check
  `L27_BASE_URL`.

## "Writes to the live Launch27 are blocked in development"

Expected. Real Launch27 data can only be edited from production. Use `L27_MODE=mock`
locally to try edits on synthetic data.

## A message shows "sandbox: not sent to customer"

Expected outside production, and in production while `NOTIFICATIONS_MODE=sandbox`.

## Logs

Railway → service → Logs. Lines are JSON; filter with `@level:error` or
`"worker tick failed"`. Emails and phone numbers appear as `[email]` / `[phone]` on
purpose.

## Local

- `npm run dev` fails with `MOCK_PASSWORD must be set`: copy `.env.example` to `.env`.
- Values with `#` in `.env` must be single-quoted.
- Embedded database got into a bad state: stop the server and delete `.data/pglite`.
- Behind a proxy: start with `NODE_USE_ENV_PROXY=1`.
