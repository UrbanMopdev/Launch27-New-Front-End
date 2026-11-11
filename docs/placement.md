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
| `PLACEMENT_TOKENS` | every environment that serves the Hub | `name:token` pairs, comma-separated, e.g. `sales-hub:<48 random chars>`. The name is recorded with every booking. Without it the API is not served at all |
| `L27_PLACEMENT_EMAIL`, `L27_PLACEMENT_PASSWORD` | production | A Launch27 staff login that may create bookings and customers. Bookings appear in Launch27 as made by this user. Dev and QA sign in to the synthetic Launch27 by themselves |
| `PLACEMENT_BRANDS` | optional | Brand slugs to serve. Default `residential` |
| `PLACEMENT_PAYMENT_METHOD` | optional | Launch27 payment method for new bookings. Default `check` (no card on file; the office collects payment the usual way) |

Bookings are only written where Launch27 writes are allowed: always against the synthetic
Launch27 (dev, QA), and in production only with `L27_ALLOW_WRITES=true`. Otherwise
`POST /bookings` answers `403 forbidden` and the attempt is logged as `blocked`.

Generate a token: `node -e "console.log(require('crypto').randomBytes(36).toString('base64url'))"`.

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
