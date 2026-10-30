# Launch27 write API (verified)

Tested on 2026-10-30 against the live tenant with a throwaway customer
(`zz-test-claude-api@example.com`, customer #53951) and booking #129993 (since cancelled).
Request bodies mirror what the admin app sends (`SerializeBookingService` in
`/admin/js/app-*.min.js`). Validation errors come back as `422` with a field-keyed
body, e.g. `{"custom_field":[{"type":"invalid","message":"value required: id 267"}]}`.

All calls: `Authorization: Bearer <token>`, `content-type: application/json`.

## Create a booking: `POST /v1/staff/bookings` ✅

```json
{
  "user": { "first_name": "ZZ Test", "last_name": "Claude API", "email": "zz-test-claude-api@example.com" },
  "address": "100 Test Street", "city": "Ottawa", "state": "ON", "zip": "K1N 1H7", "phone": "613-555-0100",
  "location_id": 1,
  "frequency_id": 171,
  "service_date": "2026-12-28T08:00:00",
  "arrival_window": 60,
  "services": [
    { "id": 1180, "pricing_parameters": [{ "id": 137, "quantity": 1 }, { "id": 138, "quantity": 0 }] }
  ],
  "discount_code": null, "tip": null, "tip_recurring": false,
  "payment_method": "check",
  "customer_notes": null,
  "staff_notes": "…",
  "custom_fields": [
    { "id": 256, "value": "true" },
    { "id": 267, "values": [{ "id": 16, "other": null }] },
    { "id": 269, "values": [{ "id": 24, "other": null }] },
    { "id": 270, "values": [{ "id": 36, "other": null }] },
    { "id": 271, "value": "true" }
  ],
  "teams": [],
  "sms_notifications": false
}
```

Response: `{"id": 129993, "ga_transaction": {...}, "ga_item": {...}}`.

Rules learned from the validator:

- `user`: new customer = `{first_name, last_name, email}` (created on the fly);
  existing customer = `{id}`.
- `service_date` is **local time with no zone** (`2026-12-28T08:00:00`); reads return UTC
  (`2026-12-28T13:00:00Z`).
- Every pricing parameter of a service must be sent, including zero quantities.
- Required custom fields (`GET /v1/staff/booking_form/custom_fields`, `value_required: true`)
  must be present. Drop-downs/radios/checkbox lists use `values: [{id, other}]`; a single
  checkbox uses `value: "true"` / `"false"` (**strings**); text fields use `value`.
- `payment_method`: `check`, `stripe` (+ `stripe_payment_method_id`) or `fspay`.
- `teams`: list of team ids to assign; empty = unassigned.
- Pricing is computed by Launch27 from services/frequency/discount; you don't send a price
  (unless overriding with `price_adjustment` / `final_price`).

## Edit a booking: `PUT /v1/staff/bookings/:id` ✅

Same body as create, plus `"id": <booking id>`, `"user": {"id": <customer id>}` and
`"is_mass_update": false` (only this booking; `true` also updates the recurring series).
Send the full booking, not just changed fields. Launch27 re-prices it: adding a half
bathroom took the test booking from $186.45 to $207.16. Returns the full booking.

## Cancel a booking: `POST /v1/staff/bookings/:id/cancel` ✅

```json
{ "confirmed_recurring": { "cancel_future": false }, "reason": "…" }
```

Returns `{}`; the booking then reads `active: false`. `cancel_future: true` cancels the rest
of a recurring series. `POST /v1/staff/bookings/:id/restore` undoes it (not yet tested).

## Edit a customer: `PUT /v1/staff/customers/:id` ✅

```json
{
  "first_name": "ZZ Test", "last_name": "Claude API", "email": "zz-test-claude-api@example.com",
  "phone": "613-555-0100", "address": "100 Test Street", "city": "Ottawa", "state": "ON",
  "zip": "K1N 1H7", "company_name": null, "notes": "…"
}
```

Returns the full customer.

## Not yet tested

Defined in the admin app, same pattern (see `docs/API.md` for the read side):

| Purpose | Call |
| --- | --- |
| Assign cleaners | `POST /v1/staff/bookings/assign/teams` |
| Complete, restore | `POST /v1/staff/bookings/:id/complete`, `/restore` |
| Charge, tip, late-cancel fee | `POST /v1/staff/bookings/:id/charges`, `PUT …/tip`, `PUT …/cancellation_fee` |
| Edit this and future bookings in a series | `POST /v1/staff/bookings/:id/future` |
| Cleaner availability | `POST /v1/staff/teams/:id/availability` |
| Cleaner time-off notes | `POST/PUT/DELETE /v1/staff/teams/:team_id/availability/notes/:id` |
| Cleaner profile, tags | `PUT /v1/staff/teams/:id`, `POST /v1/staff/teams/:id/tags` |
| Customer phones, addresses, tags | `/v1/staff/customers/:id/phones`, `/addresses/:id`, `/tags` |
| Slot setup per location | `PUT /v1/staff/locations/setup`, `PUT /v1/staff/locations/:id` |
| Settings | `PUT /v1/staff/{services,frequencies,discounts,sales_taxes,tags,checklists,wage_methods,tasks,staff}/:id` |
