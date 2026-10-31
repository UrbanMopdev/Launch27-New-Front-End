# Launch27 New Front End

A replacement front end for UrbanMop's Launch27 admin portal, so we can add our own
features on top of Launch27's data. It works in two steps:

1. **Capture** (`capture/`): a Playwright crawler logs into the Launch27 admin portal,
   visits every page it can reach and records the API calls each page makes. The result
   is a redacted catalog: `docs/API.md` and `docs/api-catalog.json`.
2. **Rebuild** (`server/` + `web/`): a small Express server handles login and proxies
   Launch27's API; a React app rebuilds each admin page from the catalog.

```
browser ── /auth/*, /l27/* ──> server (Express) ── Bearer token ──> https://urbanmop.launch27.com
```

The server reuses the auth flow from
[Check-In-Tracker-L27](https://github.com/UrbanMopdev/Check-In-Tracker-L27):
`POST /latest/login` with `{email, password}` returns `{bearer}`, which is sent as
`Authorization: Bearer …`. Each user signs in with their own Launch27 account, so
Launch27 still enforces their permissions, and the token stays on the server (the
browser gets an httpOnly session cookie).

## Environments and docs

The app runs in three isolated environments (development, staging/QA, production), each
with its own database. Dev and QA use built-in **synthetic** Launch27 data and can't send
real messages; only production touches the real Launch27.

| Doc | What's in it |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | What runs where, and which services we chose not to add |
| [docs/environments.md](docs/environments.md) | Dev / QA / production differences, variables, data rules |
| [docs/deployment.md](docs/deployment.md) | Branch flow, CI/CD, QA approval, GitHub + Railway settings, rollback, domains |
| [docs/database.md](docs/database.md) | Migrations, failed-migration plan, indexing, backups, restore |
| [docs/security.md](docs/security.md) | Secrets, sessions, least privilege, log redaction |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Failed deploys, health checks, sign-in problems |

## Setup

Requires Node 22+.

```bash
npm install
cp .env.example .env        # defaults to synthetic data, password "demo"; .env is gitignored
npm run dev                 # http://localhost:5173
npm run check               # lint, typecheck, tests, build (same as CI)
```

Wrap values containing `#` in single quotes (`L27_PASSWORD='abc#123'`); otherwise
Node treats the rest of the line as a comment.

Behind an HTTP proxy (e.g. a locked-down cloud sandbox), start the server with
`NODE_USE_ENV_PROXY=1` so Node's `fetch` uses `HTTPS_PROXY`.

## 1. Capture the admin portal's API

```bash
npx playwright install chromium   # once
npm run capture                   # headless, logs in with L27_EMAIL / L27_PASSWORD
npm run capture -- --headed       # watch it, or log in by hand if no credentials are set
```

It starts at `/admin/`, visits every link it finds plus the routes in `capture/seeds.txt`
(menus that only open on click, taken from the admin app's route definitions), and
covers both the classic admin and the newer `/app-v2/admin/`. If a CDN the admin app
needs is unreachable, it serves local copies of jQuery/jQuery UI/Font Awesome and
stubs out analytics/chat widgets.

Options: `--start /admin/` (where to start; also `L27_ADMIN_START`), `--scope` (allowed
path prefixes), `--max-pages 200`,
`--per-template 2` (how many `/bookings/:id`-style pages to visit), `--fresh` (ignore the
saved login), `--allow-writes`. `CHROMIUM_PATH` points it at an already installed browser.

**It is read-only by default.** It never follows logout/delete/cancel/export links, and any
XHR that isn't a GET (other than login) is blocked and logged, so the catalog still lists
write endpoints without calling them.

Output:

| Path | Contents | Commit? |
| --- | --- | --- |
| `docs/API.md`, `docs/api-catalog.json` | For each page: the endpoints it calls. For each endpoint: query params, request body and response *shapes* (types only). No names, emails, phones or search text: this repo is public | Yes |
| `capture/output/` | Raw requests with full response bodies, plus a screenshot of every page | **No.** Contains customer data; gitignored |

`npm run catalog` rebuilds the docs from `capture/output/` without crawling again.

## 2. Run the app

```bash
npm run dev      # server on :8787, web on :5173 (proxied)
```

Production: `npm run build && npm start` with `APP_ENV=production`. The server then also
serves `web/dist`. See docs/deployment.md for how hosted environments are deployed.

Against the real Launch27, the proxy only forwards **GET** requests unless
`L27_ALLOW_WRITES=true` is set, and only in production. With `L27_MODE=mock`, edits go to
the synthetic data.

## Support workspace (phase 1)

A one-stop place to handle customer and cleaner conversations next to their bookings,
replacing Kustomer for UrbanMop. It adds conversations to this app rather than being a
separate inbox: the same login, the same Launch27 data, and booking changes made from
inside a conversation.

| Part | What it does |
| --- | --- |
| Inbox (`/inbox`) | Three panes: work list (mine, unassigned, mentions, late, "who is this?", each queue), the conversation with every channel in one thread, and the customer or cleaner 360 |
| Customer 360 | Health strip (frequency, lifetime spend, cleans, cancellations, last rating, risk flag), next or pinned booking with live en-route/check-in status and lateness, booking tabs, ratings and cleaners they liked or didn't, card on file, home notes, all conversations |
| Cleaner 360 | Today's bookings with time tracking, availability, rating and happy %, late check-ins in 30 days, unhappy comments, quick texts (ask for ETA, confirm arrival) |
| Booking actions | From the pinned booking: edit/reschedule (booking form), cancel, restore, new booking, text the assigned cleaner. Each change is logged on the conversation |
| Composer | Reply by text or email from any UrbanMop identity, "/" for saved replies with `{{first_name}}`, internal notes with @mentions, SMS segment count, drafts kept per conversation, STOP-blocked numbers refused |
| Work handling | Push routing to available agents, claim (race-safe), assign, move queue, snooze, done with who/reason/outcome, complaint record with cost to us |
| Routing | 15 ordered rules rebuilt from the Kustomer audit (Kustomer had 14 queues and 72 rules), editable in Support settings with warnings for rules that can never match and a live preview |
| Reply targets | Business-hours SLAs (Toronto hours, Ontario holidays, DST-safe), warnings and breach alerts, paused while snoozed, stopped only by human replies |
| Supervisor (`/supervisor`) | Live queue depth, unassigned, late, oldest waiting, per-agent load, median first reply |
| Phone | RingCentral Embeddable widget (loads when `RINGCENTRAL_CLIENT_ID` is set): calls ring in the browser, the caller's profile pops, finished calls are logged; click-to-call from a profile |
| Search | Ctrl+K: people by name, phone or email; message text; jump to a booking number |

**Phase 1 boundary: no channels are connected.** Replies are saved and shown as "not
sent: channel not connected". Inbound traffic comes from the Channel simulator
(`/inbox-simulator`), which runs the same matching, threading, routing and SLA code a
real webhook will. Phase 2 adds connectors in `server/src/inbox/channels.js` (Gmail for
email, Twilio for SMS) and webhook routes that call `ingestInbound()`.

Data: Launch27 stays the record for bookings, customers, cleaners and money. The workspace
stores only people's channel identities, conversations, notes, routing, SLAs and an audit
log (migrations in `server/migrations/`). Each agent's own Launch27 login is used for lookups, so
Launch27 permissions still apply.

Setup: set `DATABASE_URL` (Railway Postgres) and `ADMIN_EMAILS`; see `.env.example`.
Without `DATABASE_URL` it runs on an embedded Postgres, which is handy locally.

### Pages

Every page makes the same Launch27 calls as the admin page it replaces (see
`docs/API.md`). All are read-only for now.

| Section | Pages |
| --- | --- |
| Support | Inbox, Contact profile (360), Supervisor, Channel simulator, Support settings (routing rules, reply targets, saved replies, team and queues) |
| Operations | Dashboard, Dispatch board (drag-and-drop cleaner assignment, travel per cleaner), Routes & travel (map, legs, tight connections, closer cleaners), Bookings (filters: all / unassigned / recurring / new customer / cancelled), Booking detail, Time tracking, Quotes, Customers, Customer detail (upcoming / past / cancelled / feedback), Teams |
| Money | Job profitability (gross margin per job, flags, cost assumptions), Charge customers, Declined charges, Team payments, Hourly wages, Discount codes, Gift cards |
| Reports | Customer feedback |
| Settings | Services, Extras, Pricing parameters, Frequencies, Sales taxes, Closed dates, Tags & service categories, Office staff, Automated tasks, Undeliverable emails |
| Developer | API catalog (browse `docs/api-catalog.json`) |

Simple list pages live in `web/src/pages/Lists.tsx` and use the shared
`ResourceList` component (tabs, search, date filters, paging via Launch27's `/count`
endpoints).

### What Launch27's API looks like

- Base: `https://urbanmop.launch27.com/v1/`, `Authorization: Bearer <token>` from
  `POST /latest/login` (the admin app itself uses `POST /v1/login`).
- Lists: `GET /v1/staff/<resource>?limit&offset` return a bare array; `GET
  /v1/staff/<resource>/count` (same filters) returns `{count}`. Common filters:
  `filter=active` (omit for all), `query=` (search), `from`/`to` (YYYY-MM-DD).
- Details: `GET /v1/staff/<resource>/:id`, plus sub-resources such as
  `/v1/staff/customers/:id/phones|addresses|tags` and `/v1/staff/bookings/:id/comments`.
- Some read-only calculations are POSTs (`/v1/booking/estimate_price`, `/v1/booking/spots`,
  `/v1/booking/teams`, `/v1/staff/bookings/available_teams`). They're needed for a
  booking form and are blocked by the capture tool and proxy until writes are enabled.

### Adding a page

1. Find the admin page in `docs/API.md` and note the endpoints it calls.
2. Add types to `web/src/types.ts` from the response shapes.
3. Create `web/src/pages/<Name>.tsx` using `l27()` / `l27All()` from `web/src/api.ts`
   (paths are Launch27's own, e.g. `l27('/v1/staff/bookings')`).
4. Register it in `web/src/App.tsx` and the `NAV` list in `web/src/components/Layout.tsx`.

## Tests

```bash
npm test             # server (node:test), capture, web (vitest)
npm run lint
npm run typecheck
```
