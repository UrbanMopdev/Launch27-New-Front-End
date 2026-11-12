# Commercial workforce plan

**Commercial → Workforce plan** (`/commercial/workforce`) is the Commercial lead's planner, built
into the portal. It replaces a stand-alone tool that needed booking and cleaner files exported
from Launch27 and loaded by hand. Here the same rules run on the schedule the portal already
reads from Launch27, so there is nothing to export or import.

It never writes to Launch27. It suggests; people approve and make every change in Launch27.

## What it answers

1. **Who is on the Commercial team?** Everyone with Commercial visits in the last 8 weeks or
   coming up, with their Commercial and Residential hours. The app suggests the team (50% or
   more of a cleaner's hours are Commercial); the lead ticks Yes or No and can set a last
   working day for someone who is leaving.
2. **What should move this week?** Each Commercial visit held by someone outside the team is
   one of:
   - **Move** – a Commercial cleaner is free at that time every time the visit happens. The
     app proposes one and lists the others, best first: already serves that account, least
     extra driving, most free hours.
   - **No Commercial cover** – nobody on the team is free. The visit stays where it is, and
     the page says how many more cleaners would cover the busiest moment.
   - **Stay until the program ends** – transition-program clients (Bruyère, Queensway
     Carleton, Montfort at Home, OWCS GHP) keep their cleaner. Enter an end date and the visit
     is planned like the others from then on.
   - **On hold** – the lead parked it.

   Each move has a status: proposed, approved, done in Launch27, on hold. *Copy weekly plan*
   puts the week in plain text for an email or Slack.
3. **What does the week look like?** The week board shows each Commercial cleaner's days with
   their Commercial visits, Residential visits, proposed moves in and out, and days off.
4. **Where is there room for new clients?** The open-slots grid counts Commercial cleaners
   free at each day and time in every one of the next weeks. The slot finder takes a postal
   code and suggests times when a Commercial cleaner already has a visit nearby.
5. **What can partners see?** A page per partner (Carefor, OWCS) that they open by
   themselves, with the open slots and the same postal-code finder.

## What the portal already did

| The old tool | In the portal |
| --- | --- |
| Load the bookings export | Live from Launch27 (scheduling planner) |
| Load the cleaners export, availability, days off | Live from Launch27 |
| Commercial or Residential by location | Brands by location |
| Partner and program accounts | Organizations and hospital programs |
| Recurring visits worked out from past bookings | Launch27's own recurring schedule |
| Unassigned visits, double bookings, tight travel | Scheduling planner, shown again on this page |
| Travel between visits | Routes and travel |

## What this page added

The Commercial team list, the weekly plan of moves with statuses, the week board, the
open-slots grid and postal-code finder, the partner files, and two visit categories the
portal did not name before (EOPMG, OWCS GHP).

## What was left out, on purpose

- File uploads and downloads of bookings and cleaners. The data is live.
- Assumed default hours for cleaners with none on file. The page uses what Launch27 holds.
- Backup and restore of settings. They are in the database.
- The postal-area outline map. The finder works from area centres.
- A live login for partners. Partner files are downloaded and sent, as they were before.
  Giving partners a sign-in is a separate decision.

## Rules

- A visit is Commercial when its Launch27 location belongs to the Commercial brand.
- Times are compared visit by visit over the planning window, so "free" means free every
  time the visit happens, with the cleaner's hours and dated days off from Launch27.
- A cleaner is only proposed where they have worked before (Ottawa or Cornwall).
- Customer preferences from Launch27 tags are respected (female only, avoid, prefers).
- Driving distance is the straight line times 1.3. Slots keep a 30-minute gap around other
  visits.
- A cleaner with a last working day is not proposed for anything after it, and their visits
  after that day are listed for a new cleaner.

## Partner files and privacy

A partner file is one web page with the data inside it. It holds only what the settings
allow, so there is nothing hidden in the file to find:

- Cleaners are "Cleaner A, B…" unless names are switched on.
- A partner sees the addresses of their own clients only, unless other partners' addresses
  are switched on. Everything else is a postal area (first three characters).
- Residential jobs are never named. They only make a time unavailable.
- The postal code a partner types stays on their computer.

Only supervisors and admins can download a file, and each download is recorded.

## Where it lives

| Part | File |
| --- | --- |
| Rules (no database, no network) | `server/src/commercial/workforce-core.js` |
| Service and settings | `server/src/commercial/workforce.js` |
| Routes | `server/src/inbox/api.js` (`/api/commercial/workforce/…`) |
| Tables | `server/migrations/0017_commercial_workforce.sql` |
| Page | `web/src/commercial/Workforce.tsx` |
| Tests | `server/test/commercial-workforce.test.js` |

Tables: `commercial_cleaners` (the lead's tick and last working day), `commercial_moves`
(status, chosen cleaner and program end date for each recurring visit), `commercial_settings`
(partner accounts and what partner files show).

## Credit

Postal-area centres in `server/src/commercial/data/postal-area-centres.json` come from
[GeoNames](https://www.geonames.org/), licensed CC BY 4.0.
