# Security

## Secrets

- No secret is committed. `.env` is gitignored; `.env.example` and `deploy/*.env.template`
  hold placeholders only.
- Hosted secrets are Railway variables, set per environment. Each environment has its own
  `SESSION_SECRET`, database and (later) provider keys. Never reuse a production value in
  dev or QA.
- Use Railway reference variables (`${{Postgres.DATABASE_URL}}`) rather than pasting
  connection strings.
- GitHub Actions needs no deploy secrets: Railway deploys from GitHub itself.
- Rotation: changing `SESSION_SECRET` signs everyone out (the encrypted Launch27 tokens
  can no longer be decrypted). Rotate on staff departures with access to Railway, or any
  suspected leak.
- Turn on GitHub secret scanning and push protection (Settings → Code security).

## Authentication and sessions

- People sign in with their own Launch27 login; Launch27 enforces their permissions. The
  app never stores passwords.
- The Launch27 bearer token stays on the server, encrypted with AES-256-GCM in Postgres.
  The session id in the database is a SHA-256 hash of the cookie value.
- Cookie: httpOnly, signed, `SameSite=Lax`, `Secure` in production, 12 hours.
- Support workspace admin/supervisor roles come from `ADMIN_EMAILS` / `SUPERVISOR_EMAILS`.

## Least privilege

| Who / what | Access |
| --- | --- |
| Developers | Railway: development + staging. GitHub: write to `feature/*`, PRs to `develop` |
| QA | Staging URL; approve `staging → main` PRs |
| Production deployers (1–2 people) | Railway production; GitHub maintainers |
| CI | Read-only repository token (`permissions: contents: read`); its own throwaway Postgres |
| Dev/QA services | No variables pointing at production; no live Launch27; no live messaging |

Railway: invite developers as members of the project and use environment-level
restrictions where the plan supports them; keep production variables visible to
production deployers only.

## No live side effects outside production

See docs/environments.md → "Guarantees enforced in code". Summary: on Railway, dev and QA
are forced to synthetic Launch27 data, Launch27 writes go to an in-memory fake, every
SMS/email connector is swapped for a sandbox stand-in, and RingCentral works only against
its sandbox. Tests in `server/test/platform.test.js` cover each guard, and the smoke test
checks them on every deploy.

## Real data in QA

QA can show an anonymized copy of production data (docs/environments.md → "Data in dev
and QA"). Personal fields are replaced before the copy leaves production, it is checked
on both sides, and QA never receives Launch27 credentials. The shared
`QA_SNAPSHOT_TOKEN` only lets production write a copy into QA; it reads nothing.

## Customer segments

The segment sync (`server/src/segments/`) stores, in each environment's own Postgres, every
customer's id, name, email, phone, city, segment, 12-month spend and segment history, plus
staff call outcomes. It is the first production table holding customer details beyond the
inbox, so **database backups must be on before relying on it**. It only reads from Launch27.
In production the nightly run logs in as `L27_SYNC_EMAIL` / `L27_SYNC_PASSWORD`: use a
dedicated Launch27 staff user with the least access Launch27 allows (it needs to list
bookings and count customers). Dev and QA never use these (they sync from their own
synthetic Launch27 or the anonymized copy).

## Logging without personal data

`server/src/log.js` writes JSON lines and redacts before writing:

- keys that look like secrets (`password`, `token`, `authorization`, `cookie`, `session`…)
  → `[secret]`
- personal fields (`email`, `phone`, `name`, `address`, `body`, `comment`, `notes`, `to`,
  `from`) → `[redacted]`
- email addresses and phone numbers anywhere in strings → `[email]` / `[phone]`

Request logs record the method, the path with numeric ids replaced by `:id`, status and
time. Query strings (which can contain search text) are never logged.

## HTTP hardening

`X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`,
`X-Frame-Options: SAMEORIGIN`, `x-powered-by` off, request bodies capped, Railway
terminates TLS.

## Known gaps / follow-ups

- **This repository is public.** It contains no customer data or secrets, but it does
  describe our systems. Make it private before it holds anything sensitive.
- Content-Security-Policy isn't set yet (the RingCentral widget and map tiles need a
  tuned allow-list).
- No rate limiting on `/auth/login` yet; Launch27 itself throttles failed logins. Add a
  per-IP limit when we run more than one replica (needs Redis or Postgres).
- Webhook routes for real channels (phase 2) must verify provider signatures.
