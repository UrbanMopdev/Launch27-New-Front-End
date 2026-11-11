# Placement API (for the Sales Hub)

The Sales Hub owns leads for every brand. When a rep is ready to book a lead, the Hub asks
this app to quote, find a slot, hold it and book it, so **UrbanMop's own scheduling rules**
(cleaner hours, travel, the 4-week cycle, cleaner tags, recurring series) and Launch27's
pricing apply. Every brand's front end exposes the same API, the placement contract:

- Spec: [`contracts/placement/openapi.yaml`](../contracts/placement/openapi.yaml) (v1.1.0)
- Rules every app follows, and the conformance checker: the contract's home in the
  MaidCentral front end repo, `docs/placement.md`. The copy in `contracts/placement/`
  here is vendored until the contract moves to its own repo; don't edit it here.

```
Sales Hub ── Bearer <service token> ──> /api/placement/v1 ──> planner (findSlots / checkSlot)
                                                         └──> Launch27 (placement login)
```

## Endpoints, as implemented here

| Call | What this app does |
| --- | --- |
| `GET /health` | Signs in to Launch27 and checks the planner. `degraded` when writes are off or the schedule is missing or older than 30 minutes; `down` when Launch27 can't be reached |
| `GET /catalog?brand=` | Services of the brand's default Launch27 location, **priced above $0** and whose rooms map to home details (so Commercial and Reclean are quoted by people). Hourly services carry `hourly`. Frequencies are Launch27's, minus prepaid and every-3-weeks. Required booking questions come from Launch27's booking-form custom fields |
| `POST /quote` | Picks the Launch27 location from the postal code (longest postcode prefix within the brand, then the default location), prices it with the same rules as the booking form (`mock/pricing.js`, checked to the cent against real bookings) and the location's sales tax. Valid 60 minutes |
| `GET /availability` | The planner's `findSlots` limited to cleaners of that location, with held slots treated as busy. Recurring quotes only return slots free **every** repeat in the planner's 8-week window. Each slot names its cleaner and why it ranked there |
| `POST /holds` | Re-checks the slot with `checkSlot`, then holds it 10 minutes in this app's database (`holds: "local"`: Launch27 can't reserve a time) |
| `POST /bookings` | Checks the Idempotency-Key, the required answers and the hold; re-checks the slot; finds the customer by email, then phone (or creates them); then `POST /v1/staff/bookings` with the cleaner assigned, the answers as custom fields, and staff notes saying who booked it, for which lead and from which channel. Recorded in the Launch27 write log (source `placement`) |

Brand keys to the Hub are `urbanmop-<brand slug>`: `urbanmop-residential`,
`urbanmop-commercial`. Only brands in `PLACEMENT_BRANDS` (default `residential`) are served.

## Setup

| Variable | Where | What |
| --- | --- | --- |
| `PLACEMENT_TOKENS` | every environment that serves the Hub | The callers' tokens, stored as hashes: `sales-hub:sha256:<64 hex>`, or JSON with a scope: `[{"name":"sales-hub","sha256":"…","actions":["read","hold","book"],"brands":["urbanmop-residential"]}]`. Make one with `npm run placement-token -- sales-hub`: the token goes to the Hub, only the hash comes here. Plain `name:token` (32+ characters) works in dev and QA only. In production every token must be a hash with an explicit scope (the JSON form), and its brands must be served brands; otherwise the app refuses to start. The name is recorded with every request and booking. Without it the API is not served at all |
| `PLACEMENT_BOOKING_ENABLED` | production | `true` lets the Hub book. Off by default, and independent of `L27_ALLOW_WRITES` (which governs the staff screens). Quotes, availability and holds work either way |
| `PLACEMENT_ALLOWED_IPS` | optional | Only these caller addresses (IPv4, IPv4/CIDR or exact IPv6), e.g. the Hub's static outbound IPs |
| `L27_PLACEMENT_EMAIL`, `L27_PLACEMENT_PASSWORD` | production | A Launch27 staff login that may create bookings and customers. Bookings appear in Launch27 as made by this user. Dev and QA sign in to the synthetic Launch27 by themselves |
| `PLACEMENT_BRANDS` | optional | Brand slugs to serve. Default `residential` |
| `PLACEMENT_PAYMENT_METHOD` | optional | Launch27 payment method for new bookings. Default `check` (no card on file; the office collects payment the usual way) |

Bookings are written against the synthetic Launch27 in dev and QA, and in production only with
`PLACEMENT_BOOKING_ENABLED=true`. Otherwise `POST /bookings` answers `403 forbidden` and the
attempt is logged as `blocked`.

## Security

Every request passes these, in order (`src/placement/api.js`):

| Layer | What it does |
| --- | --- |
| Headers | `Cache-Control: no-store`, `nosniff`, `X-Frame-Options: DENY`, `Content-Security-Policy: default-src 'none'`, no referrer; HSTS in production. Railway terminates TLS: plain HTTP never reaches the app |
| Address allowlist | With `PLACEMENT_ALLOWED_IPS`, any other address gets `403` before its token is looked at. The address is the one Railway's proxy saw (one trusted hop), so a forged `X-Forwarded-For` doesn't help |
| Lockout | 10 missing or wrong tokens from one address in 15 minutes: that address's bad tokens get `429` (with `Retry-After`) for the rest of the window. A valid token is never refused by the lockout, so someone sharing the Hub's address can't lock the Hub out. Memory for this is capped; past the cap new addresses are treated as locked out |
| Token | `Authorization: Bearer <token>`. Its SHA-256 is compared with every stored hash in constant time; production stores hashes only, each with an explicit scope. The token can't sign in, read the inbox or reach `/l27` |
| Rate limits | Per caller: 300 requests a minute in all, 60 holds, 20 bookings. Over the limit: `429` with `Retry-After` and a retryable `platform_unavailable` (the contract has no rate-limit code yet; proposed for v1.2) |
| Scope | Each token's actions (`read`: health, catalog, quote, availability; `hold`; `book`) and brands. Outside them: `403 forbidden` |
| Request | Checked against the contract; bodies JSON only (`415` otherwise), 64 kB at most; ids and real calendar dates checked before use. Slot tokens are signed with `SESSION_SECRET` (required wherever placement is served), so a forged slot is refused |
| Ownership | A quote, its slots and its holds can only be used by the caller that made the quote. Anyone else gets `404`, as if it didn't exist |
| Bookings | A hold is claimed atomically before Launch27 is called, so one hold books at most once, whatever keys are used. An Idempotency-Key, once its request has gone to Launch27, is never forgotten: a 4xx from Launch27 (it made nothing) frees the key and the hold; anything else (no answer, 5xx, no booking id) leaves both blocked as `unknown`, so a retry can't book twice. An existing customer is matched by email, or by phone *and* last name (never phone alone); Launch27's error bodies aren't passed through, only its status and a short message. The placement Launch27 client refuses any write other than creating a booking, and that only while booking is on |
| Audit | Every request: time, caller, address, what, result, how long, the quote/hold/booking id. No bodies, so no customer details. Kept 180 days; admins read it in Support settings → Sales Hub API. Refused requests from unknown callers are capped (5 a minute per address, 60 in all; beyond that only a count is logged). Bookings also go to the Launch27 write log |

Rotating a token: add the new entry next to the old one, switch the Hub over, remove the old one.

**Trust boundary.** Caller addresses come from Railway's edge proxy (one trusted hop). Another
service inside the same Railway project could reach the app directly and set that header itself,
so the address allowlist and lockout assume nothing else in the project is hostile (today the
project holds only this app and its database). The token, scopes and ownership checks don't
depend on addresses. The first placement request after each start logs the socket address the
edge connects from; once confirmed it isn't a private-network address, `trust proxy` can be
narrowed to refuse forwarded addresses from private-network neighbours.

**Unfinished attempts.** A booking attempt still running answers `409` (retryable) for up to two
minutes; one stuck longer (a crash, a failed final write) answers `502` "check Launch27 first",
never retryable with the same key. Launch27 answering 401, 403 or 429 means it made nothing: the
key and hold are freed and the answer is a retryable `503`.

Check a running environment (read-only, then with a hold):

```bash
PLACEMENT_TOKEN=... npm run conformance -- --base-url https://qa.<domain> --brand urbanmop-residential --quote quote.json
PLACEMENT_TOKEN=... npm run conformance -- --base-url https://qa.<domain> --brand urbanmop-residential --quote quote.json --holds
```

`--book book.json` writes a booking: QA only.

## Data kept

`placement_quotes` (with the address), `placement_holds` and `placement_bookings` (one row per
Idempotency-Key, so a retry returns the first answer). Quotes and booking attempts are deleted
after 30 days; Launch27 keeps the booking itself.

If Launch27 doesn't answer while booking, the booking may or may not exist. That key then keeps
answering `502 platform_unavailable` and the Hub must check Launch27 before trying again with
a new key. Any other failure before Launch27 accepts the booking frees the key.

## Known limits (follow-ups)

- **New addresses aren't on the map.** There's no geocoding yet, so travel to a new customer's
  address is estimated (20 minutes) and the slot says so. Adding geocoding to `/quote` would let
  the planner rank by real distance.
- **Holds only protect against bookings made through this app.** Someone booking the same time
  directly in Launch27's admin isn't stopped by a hold; the re-check at booking time catches it.
- **Every-3-weeks** frequencies aren't offered to the Hub (no contract value yet).
- **Commercial** isn't served: its services are priced by people. Turn it on with
  `PLACEMENT_BRANDS=residential,commercial` once there's something to quote.
