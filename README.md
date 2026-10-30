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

## Setup

Requires Node 20+.

```bash
npm install
cp .env.example .env        # fill in values; .env is gitignored
```

## 1. Capture the admin portal's API

```bash
npx playwright install chromium   # once
npm run capture                   # headless, logs in with L27_EMAIL / L27_PASSWORD
npm run capture -- --headed       # watch it, or log in by hand if no credentials are set
```

Options: `--start /admin` (where to start; also `L27_ADMIN_START`), `--max-pages 200`,
`--per-template 2` (how many `/bookings/:id`-style pages to visit), `--fresh` (ignore the
saved login), `--allow-writes`. `CHROMIUM_PATH` points it at an already installed browser.

**It is read-only by default.** It never follows logout/delete/cancel/export links, and any
XHR that isn't a GET (other than login) is blocked and logged, so the catalog still lists
write endpoints without calling them.

Output:

| Path | Contents | Commit? |
| --- | --- | --- |
| `docs/API.md`, `docs/api-catalog.json` | For each page: the endpoints it calls. For each endpoint: query params, request body and response *shapes* (types only; emails/phones redacted) | Yes |
| `capture/output/` | Raw requests with full response bodies, plus a screenshot of every page | **No.** Contains customer data; gitignored |

`npm run catalog` rebuilds the docs from `capture/output/` without crawling again.

## 2. Run the app

```bash
npm run dev      # server on :8787, web on :5173 (proxied)
```

Production: `npm run build && NODE_ENV=production npm start`. The server then also serves
`web/dist`.

The proxy only forwards **GET** requests until `L27_ALLOW_WRITES=true` is set.

### Pages

| Page | Launch27 calls |
| --- | --- |
| Bookings: date range, search, booking details panel, time-tracking status | `GET /v1/staff/bookings?from&to&limit=100&offset` |
| API catalog: browse `docs/api-catalog.json` | none |

### Adding a page

1. Find the admin page in `docs/API.md` and note the endpoints it calls.
2. Add types to `web/src/types.ts` from the response shapes.
3. Create `web/src/pages/<Name>.tsx` using `l27()` / `l27All()` from `web/src/api.ts`
   (paths are Launch27's own, e.g. `l27('/v1/staff/bookings')`).
4. Register it in `web/src/App.tsx` and the `NAV` list in `web/src/components/Layout.tsx`.

## Tests

```bash
npm test
```
