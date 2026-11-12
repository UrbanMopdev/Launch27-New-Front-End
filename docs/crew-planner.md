# Crew Planner

Scheduling planner → **Crew Planner**. Grace builds the weekly schedule for the Ottawa employee
crews herself: the planner suggests, she adjusts and approves, then applies the change list in
Launch27. **It never writes to Launch27.**

Built in phases. **Part 1 (this release): the reference data the planner trusts.** Planning the
week (crews, fix-first list, generate, adjust, approve and export) comes next.

## Who sees it

- Admins, and the logins in `CREW_PLANNER_EMAILS` (Grace). Everyone else gets "not found".
- `CREW_PLANNER_ENABLED`: on in dev and QA unless set to `false`, off in production until set to `true`.
- Tier, "take from first" (low performer) and ratings only ever appear on these pages. Ratings
  are admins only. Exports and anything a cleaner sees say "from Hodan", never "low performer".

## For Grace: how it works (plain English)

The same text is on the **How it works** page inside the tab.

**What it trusts.** The preferences and cleaner settings on these pages, not Launch27's tags and
notes, which are often out of date. After each Launch27 refresh it reads the tags and notes and
lists what it finds under **Preferences to review**. Nothing counts until you confirm it.

**The preferences.**

| Preference | What the plan does |
|---|---|
| Prefers (a cleaner, optionally a second "if the first isn't available") | The visit only goes to a crew that includes them; otherwise it stays with that cleaner, or is flagged if they're away |
| Never send (a cleaner) | Never on a crew with that cleaner |
| Female cleaner only | Never on a crew with a man on it |
| No trainees | Never on a crew with a trainee |
| Same cleaner every time | Keeps them with their regular |
| Don't move the time | Keeps the original start time |
| Hold: unpaid balance | Not scheduled; flagged for you |
| Cancelling | Scheduled as tentative; not counted in hours until you confirm |

**Suggestions from visit history.** When one cleaner did at least 3 visits and more than half of
a client's visits, it suggests that cleaner as preferred. Clients whose regular has left or is on
hold are not suggested: the plan finds them a new regular.

**Cleaners.** For each cleaner: planner status (active, on hold, inactive/left), protected (never
take bookings from them), take from first (low performer), tier, gender, employment (employee,
contractor, contractor with guaranteed hours: never take from them), crew role (lead, trainer,
trainee) and the jobs they should mainly get (e.g. TJ: prepaid, one-time, move in/out). Gender
and tier come from the Launch27 name codes, `(1)(F)`, until changed here.

**Only Residential Ottawa.** Commercial Ottawa, Cornwall, Carefor, QCH, Bruyère, OWCS, homemaking
and other cities are never read or touched.

**Areas.** Postal-code areas (the first three characters, e.g. K2G) grouped into parts of town.
The plan tries to keep each crew-day inside one area.

**The day (for the next part).** Crews leave 34 Westwood Dr at 8:30, first arrival 9:00 to 9:30,
back by 5:30, 30-minute unpaid lunch. Paid hours = return − 8:30 − 30 min, so drive time counts.
Hard cap 44 h a week (Ontario overtime); aim for 30 to 35.

## Starting data

`server/src/crew/seed.json` holds the protected cleaners, who's on hold or has left, low
performers, crew members and the preferences Grace confirmed before the app existed. An admin
loads it with **Setup → Load starting data**. It runs inside the app, in each environment, so
nobody runs scripts against production.

- Cleaners are matched by **full name only** (a nickname like "Casey" could be someone else).
  Aliases (TJ, Dom, Thi Thu) are then used to read preferences.
- Clients are matched by first and last name; middle names and initials are ignored.
- Anything that matches no one, or more than one person, is listed on the Setup page instead of
  guessed. A preference whose cleaner can't be matched goes to Preferences to review.
- Loading again only fills in what's missing. It never undoes a change made in the app.
- **Needs a decision:** "Ruth (on hold)". The list also has Ruth Nelie Misse Oyono as protected,
  and Dorothy Greenberg asks for "Ruth only". If they're the same person, set Ruth to On hold on
  the Cleaners page.

Dev uses made-up names, so almost nothing matches there. QA's copy of production keeps real names
(it masks only phone numbers and emails), so QA is where to check the seed.

## How it fits together

| Piece | Where |
|---|---|
| Tables | `server/migrations/0017_crew_planner.sql`: `cp_cleaner_profile`, `cp_client_pref`, `cp_fsa_cluster`, `cp_seed_runs` |
| Preference reading, name matching, postal-code areas | `server/src/crew/prefs.js` (pure functions) |
| Service | `server/src/crew/service.js` |
| API | `/api/crew/*` in `server/src/inbox/api.js` |
| Screens | `web/src/crew/` |
| Tests | `server/test/crew.test.js` |

- **Source data:** the Scheduling planner's saved copy of Launch27 (`schedule.crewSource()`). It
  now also keeps each visit's postal code, location name, Launch27 tags, staff and customer notes,
  and amount owed.
- **Finding preferences:** the background worker checks after each Launch27 refresh. **Check
  Launch27 for new ones** runs it on demand. A suggestion is made once: a rejected one is never
  suggested again, and one that's already confirmed isn't asked about.
- **Audit:** every change (cleaner settings, confirm, reject, turn off, area edits, seed load) is in
  `audit_log` as `crew.*`, with who and what changed.
- **Drive times:** estimated from map distance for now (the same model as the Scheduling planner).
  Google drive times are optional and come later, with `GOOGLE_MAPS_API_KEY`.

## API

All under `/api/crew`, signed in, admins and `CREW_PLANNER_EMAILS` only (404 otherwise).

| Method | Path | |
|---|---|---|
| GET | `/status` | counts, last seed load, last scan |
| GET | `/cleaners` | Launch27 cleaners with their planner settings (`rating_pct` for admins only) |
| PATCH | `/cleaners/:id` | change settings (`rating_pct`: admins only) |
| GET | `/prefs?status=&source=&q=` | preferences |
| POST | `/prefs` | add one (confirmed) |
| POST | `/prefs/:id/confirm` \| `reject` \| `deactivate` \| `reactivate` | body may set `cleaner_ids`, `note` |
| POST | `/prefs/bulk` | `{ ids, action: confirm \| reject }` |
| POST | `/prefs-scan` | read Launch27 for new preferences now |
| GET / PUT | `/areas`, `/areas/:fsa` | postal-code areas (`{ cluster: null }` removes one) |
| POST | `/seed` | load the starting data (admins) |
