# Architecture

## What runs where

One Node service serves both the API and the built React app. Each Railway environment has
its own copy of that service and its own Postgres.

```
                  ┌──────────────────────── Railway project "UrbanMop Platform" ─────────────────────────┐
                  │                                                                                       │
 develop ──CI──▶  │  development:  web (Node)  ──▶  Postgres (dev)       Launch27 = synthetic (mock)      │
 staging ──CI──▶  │  staging:      web (Node)  ──▶  Postgres (staging)   Launch27 = synthetic (mock)      │
 main ─CI+QA─▶    │  production:   web (Node)  ──▶  Postgres (prod)      Launch27 = urbanmop.launch27.com │
                  └───────────────────────────────────────────────────────────────────────────────────────┘
```

Inside the `web` service:

| Part | Code | Notes |
| --- | --- | --- |
| HTTP server | `server/src/app.js` | Express. `/auth/*` login, `/l27/*` Launch27 proxy, `/api/*` support workspace, `/healthz`, `/readyz`, static `web/dist` |
| Config + guards | `server/src/config.js` | Works out the environment and refuses unsafe combinations (see docs/security.md) |
| Synthetic Launch27 | `server/src/mock/launch27.js` | In-process fake of the Launch27 endpoints the app uses. Used in dev and QA |
| Database | `server/src/db/` + `server/migrations/` | Postgres (`pg`) or embedded PGlite locally. Versioned SQL migrations |
| Sessions | `server/src/sessions.js` | Postgres-backed, so sign-ins survive deploys. The Launch27 token is encrypted at rest |
| Background work | `server/src/index.js` | Interval worker in the same process: SLA/routing tick and expired-session cleanup |
| Logs | `server/src/log.js` | JSON lines to stdout (Railway collects them), personal data redacted |
| Web app | `web/` | React 18 + Vite + TypeScript + React Query |

Launch27 is still the system of record for bookings, customers, cleaners and money. Our
Postgres holds only what Launch27 can't: conversations, routing, SLAs, audit log, sessions.

## Services: what we have and what we deliberately don't

| Service | Decision | Why |
| --- | --- | --- |
| Frontend + API | **One service** | The API is a thin proxy plus the support workspace. Splitting them adds a second deploy, CORS and cookie-domain work with no benefit at this size |
| Postgres | **Yes, one per environment** | Conversations, audit log, sessions. Separate databases are what keeps production data out of dev/QA |
| Redis | **Not yet** | Nothing needs it: sessions are in Postgres, there's one instance, and the worker uses Postgres. Add it when we run more than one replica and need shared rate limiting or a job queue |
| Worker / cron | **In-process for now** | The SLA tick is light and uses `pg_advisory_lock`-safe claims. When jobs grow (e.g. nightly reports, sending reminders) move them to a separate Railway service using the same repo with a different start command, or a Railway cron service |
| Object storage | **Not yet** | Nothing stores files today. When attachments arrive (photos, PDFs), use a Railway Bucket per environment |
| Kubernetes, microservices, other clouds | **No** | No technical reason; Railway covers builds, environments, databases, domains and rollbacks |

## Request flow

1. The browser signs in with a Launch27 email and password (`POST /auth/login`).
2. The server logs into Launch27 (real or synthetic), keeps the bearer token server-side
   (encrypted in Postgres) and sets an httpOnly signed session cookie.
3. Pages call `/l27/<launch27 path>`; the server attaches the user's token and forwards.
   Launch27's own permissions still apply because each person uses their own login.
4. Support workspace pages call `/api/*`, which reads and writes our Postgres.
