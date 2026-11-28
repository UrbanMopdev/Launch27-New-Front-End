# Complaint Resolution Engine — Phase 1 plan (draft for Derek's sign-off)

Status: **Phase 1 built** (history miner + playbook), Nov 16 2026. Postgres and redaction
approved by Derek. Phase 2 (the recommendation card, credit ledger, scoreboard) starts only
after Derek signs off on the pilot playbook and the taxonomy.

## Setup (production, Railway variables)

| Variable | What | Needed for |
| --- | --- | --- |
| `KUSTOMER_API_KEY` | The dedicated read-only "Complaint Engine" key | Kustomer complaint objects + conversations |
| `KUSTOMER_COMPLAINT_KLASS` | Optional. The complaint object's API name | Only if auto-detection (name contains "complaint") misses |
| `SLACK_BOT_TOKEN` | Slack app bot token: `channels:history`, `groups:history`, `users:read`; invite the bot to #finance-refunds, #finance-operations-collaboration, #finance-charges | Refund decisions and amounts |
| `ANTHROPIC_API_KEY` | Optional | Claude classification of **redacted** complaint text; rules-only without it |
| (existing) `GMAIL_*`, `L27_SYNC_*` | Already set | info@ history; Launch27 12-month visit snapshot |

Then: Support → **Complaint playbook** → *Run the pilot* (admins). Before the first run,
an admin can call `GET /api/complaints/kustomer/discover` to see the complaint object's
field names (names and types only, no values) and confirm the mapping.

## How a run works (`server/src/complaints/`)

| Step | File | Notes |
| --- | --- | --- |
| Launch27 visits (Residential locations, partners excluded) | `service.js` → reports snapshot | 12 months, nightly |
| Kustomer complaint objects, customer, conversations ±14/30 days | `sources/kustomer.js` | GET only; 429/5xx retried; fields mapped by name pattern, raw kept |
| Unhappy Launch27 ratings with a comment | `service.js` | Become cases; deduped against Kustomer (same client, ≤10 days) |
| info@ threads that read as complaints | `service.js` + Gmail `search` | Read-only; Claude/rules keep only complaints |
| Refund posts in the finance channels | `sources/slack.js`, `slackRefunds.js` | Linked to the client's case 45 days before → 7 after the post |
| Classify | `taxonomy.js`, `redact.js`, `classify.js` | Rules always; Claude on redacted text; hard routes from either side stick |
| Refunds on the booking | `service.js` | Launch27 booking `charges.refunded` wins over the Slack amount |
| Recleans | `service.js` | A $0 visit within 14 days, or Kustomer "Reclean Scheduled" / our reply; cost = actual cleaner pay + travel + lost-slot margin |
| Journey, outcomes 30/60/90 | `journey.js` | Outcome rules exactly as briefed |
| Playbook | `playbook.js` | Every figure carries n; < 10 = thin |

Settings (ladder presets *today* / *target*, roles, budget target, cost assumptions) are in
`settings.js` and editable on the page's **Rules & budget** tab (admins). Nobody but the
`owner` role can approve above 50%, whatever the settings say.

Scope: **Residential only** (`brand = 'residential'`). Read-only on every source system.

---

## Phase 1.5: validation release

Phase 2 waits until the taxonomy and playbook are signed off. Phase 1.5 makes the numbers
checkable. It ships in slices; this section is updated as each one lands.

### Release 1: numbers you can trace (live in this version)

- **Who can see it.** Everyone with a staff login can read the playbook, cases and clients and
  check cases. Starting an update and changing rules stay admin-only.
- **Drill-down.** Every case count on the Playbook tab opens the exact list of cases behind it
  (client, booking, cleaner, category, what we did, cost, outcome, source link), with a CSV
  download. `buildPlaybook` returns the case ids next to each figure (`ids`, `decided_ids`,
  `saved_ids`, ...), and the page looks them up in the case list for the same dates.
  Visit counts in "Pain points upstream" and monthly revenue come from Launch27 bookings, not
  cases, so they are shown as plain numbers.
- **Rates.** Saved, Partial and Lost are always shares of **decided** cases: recurring clients
  matched in Launch27 whose complaint is at least 60 days old. Each rate shows "x of y decided".
  Every other case is listed under **Not counted** with one reason:
  one-time client, not matched to a Launch27 client, not yet 60 days old, or no outcome recorded.
  Decided + not counted always equals the number of cases.
- **Average cost** is shown twice: over every case, and over the decided cases the rates use.
- **One-time clients** have their own table (booked again within 90 / 120 days).
- **Cheapest that works** always answers. With 3+ known outcomes per response it is the
  lowest-cost response within 10 points of the best save rate; with fewer it is the best seen
  so far; with none it is only what we usually did. Each answer carries a grade by number of
  known outcomes (30+ High, 10-29 Medium, under 10 Low) and the reason. The full confidence
  grade (data quality as well as sample size) arrives in Release 6.
- **Labels.** "Hard routed" is shown as "Escalated (damage / theft / safety / legal)";
  "Share" is "% of all complaints".

### Release 3: root causes (why it happened), done ahead of release 2

Derek, Nov 27: most complaints come down to cleaner consistency and communication, and the
next layer down is what matters (a regular cleaner who left, a change nobody told the client
about, a French-speaking cleaner who couldn't follow English instructions). He checks cases by
hand, and the ranked responses per cause that come later are only as good as these labels. So
the root-cause layer went first.

- **Two layers.** The category stays "what the client complained about". Each case also gets
  one **root cause** ("why it happened") plus up to two **contributing causes**, from a fixed
  codebook of 14 in three groups: cleaner consistency, communication, quality
  (`CAUSES` in `taxonomy.js`; signed off by Derek, Nov 27). Every entry has a definition, two
  example quotes and a "not this when" line. Cleaner language is not recorded: everyone must
  speak English (Derek's call), and "language barrier" flags where that slipped.
- **Who sets it.** Keyword rules (`causeRules`), then Claude with the codebook in its
  prompt, which must quote the client's words as evidence. When the text names no cause,
  Launch27 facts fill it in for cleaner-change and quality complaints: the client's regular
  cleaner had stopped working with us (no visits with anyone for 21+ days), or 3+ cleaners
  in 90 days (`cause_by = 'facts'`). A person's cause is never overwritten.
- **Older cases.** Cases read before this release have no cause. Updating their dates again
  (admins, Run bar) asks Claude once per case for the cause only; category and everything
  else already decided stay.
- **Playbook.** "Why it happened" shows each cause like a category: cases, what it showed up
  as, saved/lost, cost and cheapest that works, with every number opening its cases. The case
  list, the drill-downs and the CSV carry the root cause.
- **Check accuracy.** Each check now confirms the category and the root cause (plus optional
  contributing causes), next to the engine's evidence quote and the Launch27 facts. Root-cause
  accuracy is measured separately, by cause and by who set it (rules, Claude, facts), with
  the common mix-ups. The codebook is on the same tab.

### Customer success brain, step 1: mining what we offered (`solutions.js`)

Derek, Nov 27: the full Kustomer history is migrated into our own conversations and messages
tables, so the engine should learn from it: what we proposed on each complaint, how the client
took it, and what kept them. Ranked options for agents come next (step 2), drafted replies
only after Derek has trusted the rankings for a few weeks (his call: ranked options first).

- **What's read.** For every complaint case, whatever its source, the client's conversations
  (matched by email, phone or Launch27 client) from 3 days before to 45 days after: their
  messages, our replies and internal notes. Each message is redacted on its own (the case's
  name, every name on the matched contacts, staff names) before it's labelled CLIENT / US /
  NOTE and sent to Claude.
- **What comes out** (`complaint_solutions`, one row per case): what the client asked for,
  every offer in order with the client's response (took it, turned it down, asked for
  something else, no reply), the final answer, how the client sounded at the end, whether they
  said they'd leave or stay, and one line on how we handled it. Offer kinds are a fixed list
  (`OFFER_KINDS`).
- **Pace.** Each update reads up to 300 cases: never-read cases first, newest first, so the
  daily update works back through the whole history on its own. Recent cases (45 days) are
  read again when their thread grows. Cases with no conversation on file are marked and skipped.
- **Feeds the ladder.** Offers the client took and the final answer become "what we did" on
  the case (`complaint_resolutions`, source `conversation`), so cases with no refund post or
  $0 visit behind them still count under the right response. Money moved stays as recorded
  by Launch27 and Slack.
- **Playbook.** "What we offered, and how clients took it": per offer, how often it was asked
  for, offered, taken or turned down, the final answer, happy at the end, and saved / lost and
  cost for the cases where it was the final answer. Each case shows its conversation summary.

### Customer success brain, step 2: ranked options for agents (`rank.js`)

On every complaint in Complaint tracking, "What's worked before" lists up to five responses,
best first, from every past complaint (all history, refreshed hourly; escalated cases left
out, they go to the Office Manager).

- **A past case's response** is the final answer read from its conversation, or the highest
  ladder step recorded (refund, credit, $0 reclean) when its conversation hasn't been read.
- **Kept** is still booking 60 days later for recurring clients (partial save counts half);
  for one-time clients it is booking again within 120 days, and they're ranked only on other
  one-time clients.
- **Similar cases** narrow as far as the data allows: same root cause and complaint, then same
  root cause, then same complaint, then everything. Each response is measured in the closest
  group where it has at least 5 known outcomes.
- **Order.** Responses with 5+ known outcomes always come first. Within each, the kept rate
  pulled toward the group's overall rate by 10 pseudo-cases (three lucky cases can't beat forty
  solid ones), then happier endings, then lower cost. The cheapest response within 5 points of
  the top one is flagged "best value".
- **Shown per option:** clients kept (x of y), happy at the end, taken when offered, average
  cost, confidence (High 30+, Medium 10+, else Low), and a warning when it is often turned
  down as a first offer.

Agents still decide; Derek can step in on any complaint. Drafted replies come later, once the
rankings have earned trust (Derek's call, Nov 27).

### Customer success brain, step 3: threats to leave or to post a review

Derek, Nov 27: a refund that loses the client anyway may still have been right if it stopped a
bad review; the engine has to look at it end to end. First part, from data we already hold:

- **Threat level** per case (`threatOf` in `rank.js`): threatened a public review (the
  complaint's tone), threatened to leave (tone, or said so in the mined conversation), or none.
- **Rankings.** A complaint whose notes carry a threat is ranked first on past clients who made
  the same threat (same threat and complaint, then same threat), before the usual groups. The
  tracker card says so.
- **Playbook.** "When clients threaten to leave or post a review": every response's saved /
  lost and cost under each threat level, next to no threat.

Not yet: Google reviews aren't connected (needs Google Business Profile access), so we can't
see which threats became reviews; and options aren't weighed by the client's value.

### Customer success brain, step 4: client value

Derek, Nov 28: client value is LTV. Two numbers are already held: "LTV of Client" on each
tracker complaint (from Kustomer) and each client's Launch27 spend in the 12 months before a
complaint (`complaint_journeys.spend_12m`).

- **Tracker.** Each ranked option shows its net for this client: the smoothed kept rate times
  LTV of Client, less the option's average cost. The highest net among options with 5+ known
  outcomes is tagged "best for this client". The order by clients kept does not change.
- **Playbook.** "By client value": responses split by 12-month spend (under $1,500, $1,500 to
  $4,999, $5,000+; `VALUE_TIERS` in `rank.js`).

Google reviews: Derek's export (Nov 28) held only the Business Profile account files, no
reviews; waiting on the review files to cross-reference threats with reviews actually posted.

### Customer success brain, step 5: Google reviews (`reviews.js`)

Derek exports reviews from Google Business Profile (Takeout: files named `reviews-….json`).
An admin imports them on the Complaint playbook, Google reviews card (never commit them: this
repo is public and they carry reviewers' names).

- **Stored** in `google_reviews` (migration 0046); importing a file again updates, never doubles.
- **Matched** to the complaint the review followed: same full name (accents, case and
  punctuation ignored) and a complaint opened from 60 days before the review to 14 days after;
  the closest wins. A first name alone, initials or a business name never matches.
- **Outcomes.** A matched 1-2 star review makes the complaint LOST at the next update,
  whatever the bookings say (`outcomeAt`'s `negativeReview`).
- **Playbook.** Complaints followed by a 1-2 star review, how many gave no warning, how many
  review threats were carried out, what we had done first, complaints followed by 4-5 stars,
  and the list of reviews at 3 stars or under with what each was matched to.

Not yet: reviews don't feed the rankings as their own column (they count through LOST), and
there is no live connection to Google, so new reviews need a fresh export.

### The numbers fix (Derek's rules, Nov 28 2026)

Phase 2 is blocked until the cost and retention numbers can be trusted. Rules, confirmed by Derek:

1. **Reclean cost** = the reclean's hours x the wage of the cleaner who did it. Hours: those
   booked on the reclean visit, else 2. Wage: that cleaner's real rate from Launch27 pay (the
   median of pay / hours over their visits), else $22. No travel, no lost-slot margin
   (`settings.costs.include_travel` / `include_lost_slot` switch them back on).
2. **Recleans are always paid.** A $0 or missing "earned" on a reclean visit means the pay was
   recorded elsewhere: hours x wage, marked estimated. Actual only when the pay is on the visit.
3. **A client who left is LOST**, review or no review. There is no "partial save" and no half
   credit in the rankings. Whether a lost client also posted a 1-2 star review is kept beside
   the outcome.
4. **SAVED** = a recurring client still booking 60+ days after the complaint, not gone within
   90 days (rule 3 wins over the day-60 check), and no 1-2 star review.
5. **Never suggest a refund in exchange for removing a review.**

What changed in the code:

- `journey.js`: `outcomeAt` (rules 3 and 4, `LEFT_WITHIN_DAYS` = 90), `recleanVisitCost`,
  `cleanerRateIndex`, `recleanCost` without travel or lost slot.
- Every reclean gets a cost line, including ones found only in the conversation, the Kustomer
  status or our reply (2 hours at the original cleaner's rate, estimated).
- **History holes.** A run counted as having read its dates even when its Kustomer listing or a
  month of email failed (status `partial`). May 17 to Aug 15 2026 was never read from Kustomer
  or info@ because of this. Only runs where both came through count now (`RUN_READ`), so the
  automatic update reads the hole.
- **Budget baseline** counts every month's cases whatever dates the page shows (it used the
  page's cases only, so months outside them read $0 / 0 cases), and averages only months fully
  read; the rest are shown as incomplete.
- **Impossible pairings.** `CAUSE_FITS` in `taxonomy.js` lists which categories each root cause
  can explain; anything else is dropped at classification and cleared from stored cases.
  "Too many marketing emails" had matched the word "unsubscribe" in system email footers.
- **"Cheapest that works"** names a response only when it has 5+ cases with a known outcome of
  its own; otherwise "Not enough data: use the standard ladder".
- **A rules change recomputes everything once** (`RULES_VERSION`): the first automatic update
  after a deploy is a rules-only pass over all history that reads no source.

Step 0 (counts in the log before any change, Nov 28): 684 cases; by month Nov 2025 to Nov 2026
22, 48, 71, 41, 55, 62, 33, 10, 26, 92, 88, 61, 75; 244 unmatched, of which 134 came from
launch27mail.com and 61 from ringcentral.com (system senders, where the client is named in the
message, not the sender); 157 cases with a reclean, 20 costed at $0; travel and lost slot were
$6,208 of $13,589 reclean cost.

Still open in this fix: system senders (find the client inside the message), the data-quality
funnel, the severity split on the page, and the before/after table.

### Still to come

2. Cost lines per case (actual vs estimated) and the escalation audit.
3. (Remaining from the old plan) billing tag.
4. New Check accuracy: Measure and Fix queues, field-level verdicts, evidence panel, Wilson ranges.
5. Second reviewer and agreement.
6. Confidence grades and sign-off.
7. Re-classify unchecked cases and accuracy over time.

## Design (as proposed)

## 1. Where it lives

A new module in this app, following the existing patterns:

| Part | Where |
| --- | --- |
| Source connectors (Kustomer, Gmail, Slack, Launch27, later Ops inbox) | `server/src/complaints/sources/*.js`, one file each, same interface (`listSince(cursor)`, `toCase(raw)`) |
| Case builder, journey features, outcome classifier, cost model | `server/src/complaints/*.js` |
| Tables | New migration(s) in `server/migrations/` (Postgres, same DB as the inbox) |
| Pages | Support → **Complaints** (case list + playbook report); Settings → **Complaint rules** (ladder, approval limits, budget slider) |
| Backfill job | Runs **on Railway production** (where Launch27 and Kustomer data already are), not on a laptop or in a dev sandbox |

**Postgres, not SQLite.** The brief asks for a local SQLite case DB *and* for cases to live
in the Ops database ready for the Kustomer migration. Those pull in opposite directions;
the Ops Postgres does both jobs, keeps personal data inside Railway, and is what the
eventual Kustomer migration will land in anyway. Dev/QA keep using synthetic data.

---

## 2. Proposed schema

Design rules: every imported row keeps `source` + `source_id` (unique together) so the
later full Kustomer migration can't duplicate anything; nothing depends on Kustomer
existing long-term; raw Kustomer statuses are kept next to our own status.

```
complaint_cases                         one row per complaint
  id, brand ('residential')
  source            kustomer | ops_inbox | gmail | slack | launch27_rating | manual
  source_id         e.g. Kustomer kobject id          UNIQUE (source, source_id)
  conversation_id   -> conversations (Ops inbox thread, incl. migrated Kustomer threads)
  contact_id        -> contacts
  l27_customer_id, l27_booking_id, l27_team_ids[]
  opened_at, first_response_at, resolved_at
  channel           email | sms | voice | chat | review
  status            open | awaiting_client | reclean_scheduled | resolved | closed
  source_status     raw Kustomer value: For Review / Awaiting Response / Damaged Item / Reclean Scheduled
  category, subcategory, severity (1–4)
  tone              mild | frustrated | angry | threat_leave | threat_review
  areas_cited       jsonb  (kitchen, bathrooms, floors, baseboards…)
  hard_route        null | damage_over_100 | theft_missing | safety | misconduct | legal_chargeback
  handled_by, decided_by  -> users
  exchanges         number of back-and-forths
  classifier_confidence   0–1 (low = flagged for human review)

complaint_journeys                      snapshot of the client AS OF the complaint date
  case_id, tenure_days, frequency, cleans_total, lifetime_spend
  price_change_90d, distinct_cleaners_90d, cleaner_changed_last_visit
  prior_complaints, our_reschedules_90d, our_cancellations_90d, days_since_last_clean
  cleaner_id, cleaner_tenure_days, cleaner_is_trainee, cleaner_complaint_rate_90d

complaint_resolutions                   what was offered, in order (supports "L1, then L3")
  case_id, step, rung (L0–L7), action  apology | credit | reclean_spot | reclean_full | refund | damage_reimbursement
  pct, amount, offered_at, accepted (yes/no/unknown)
  decided_by, approved_by, approval_ref (Slack message link)

complaint_costs                         every dollar, by type
  case_id, kind     refund | credit | reclean_labour | reclean_travel | reclean_lost_slot | damage | cleaner_recovery (negative)
  amount, source, source_ref

complaint_outcomes                      checked at 30 / 60 / 90 days
  case_id, day, still_booking, next_booking_at, churned_at
  public_review_stars, public_review_platform, repeat_case_id
  outcome           saved | partial_save | lost | pending

conversations  (existing table)  + external_source, external_id   ← Kustomer threads land here
source_sync_state                connector, cursor, last_run_at, last_error
complaint_settings               ladder rungs, role limits, budget target %, credit expiry days
```

Phase 2 adds `customer_credits` (the credit ledger) and `complaint_recommendations`
(options shown, option chosen, by whom).

The existing **Complaint** panel on inbox conversations (`conversations.complaint`, with
outcome and "cost to us") becomes a thin view onto `complaint_cases`, so frontline only
has one place to log.

**Outcome rules** (as briefed): SAVED = still booking 60+ days later and no negative
public review; PARTIAL SAVE = left, no negative review; LOST = churned within 60 days
and/or 1–2★ public review. Repeat complaint within 90 days is flagged separately.

**Reclean cost** = cleaner pay for the reclean (Launch27 team payments) + travel (our
existing route model) + lost slot = the average residential booking margin that slot would
have earned that week (from Job profitability). Shown as one number with the breakdown.

---

## 3. Draft taxonomy (hypothesis — to be replaced by what the data says)

Seeded from the existing Customer feedback themes (`web/src/lib/feedbackModel.ts`) and a
first read of #finance-refunds. Final categories come out of the 6-month pilot.

| Category | Examples | Hard route? |
| --- | --- | --- |
| Quality — missed areas | Kitchen, baseboards, bathrooms not done | |
| Quality — rushed / short time | Left early, fewer hours than booked | |
| Quality — first clean | Deep/initial clean below expectations | |
| Punctuality / no-show | Late, didn't show, cancelled by us | |
| Cleaner change / consistency | "Not my usual cleaner" | |
| Scope / booking error | Wrong service, extras missed, wrong date | |
| Communication | No update, slow reply | |
| Pricing / billing | Overcharge, Affirm/payment mix-up, price increase | |
| Property condition | Cleaner couldn't continue the job | |
| Damage — under $100 | | |
| Damage — over $100 | Broken TV, sculpture | **Yes** |
| Missing item / theft | | **Yes** |
| Cleaner conduct / safety | | **Yes** |
| Legal threat / chargeback | | **Yes** |
| Review threat | "I'll post a review" — a *tone* flag, not a category | |

---

## 4. First signals from #finance-refunds (read-only sample, Nov 2024 – Aug 2026)

- **Volume is low**: ~25 refund messages over ~21 months. The 6-month pilot will hold
  fewer than 10 refunds. Refund-level conclusions need the full backfill.
- **Real refund rungs used**: 20%, 30%, 40%, 50% and full — not 15% / 25%.
- **Damage is split with the cleaner**: TV $250 and sculpture $197.75, 50% deducted from
  the cleaner's pay. The cost model needs a "cleaner recovery" line.
- **Non-complaint refunds are mixed in** (cancelled bookings, Affirm overpayment) and
  must be filtered out.
- **Refunds tied to Google reviews**: at least one full refund was given "for the removal
  of [a] negative review". Google's review policy prohibits offering incentives to change
  or remove reviews, so the engine should never suggest this.
- **Approval in practice ≠ approval on paper**: most refunds are posted by Jose as
  "FYI, processed", not requested and approved by Derek. We'll log both who decided
  and who approved.
- No new posts since Aug 25, 2026. Have refunds moved somewhere else?

---

## 5. Guardrails built in

- Every connector is read-only; no write calls to Kustomer, Gmail, Slack or Launch27.
- Mining runs on Railway production; personal data stays in our Postgres.
- If complaint text is classified with an LLM, names, emails, phones and addresses are
  stripped first (reusing `server/src/qa/anonymize.js`), and only the text needed is sent.
- The engine recommends; a person approves and sends.
- Every conclusion in the playbook states how many cases it rests on.

### System senders, the funnel and cost per response (Nov 28 2026, part 2)

What the production log showed about the unmatched cases (subject templates only, no names):

- `launch27mail.com`, 155 cases: 47 are the "Ratings … with comments" digest (every rating in it
  is already its own case from the Launch27 ratings source), 23 "New booking by staff", 25
  "Booking cancellation", 8 "Upcoming schedule". Those are notices to us, not client messages.
  About 36 are a client's reply to a reminder, relayed by Launch27 ("From <address> Re: …").
- `ringcentral.com`, 61 cases, none matched: voicemail and call-note notices. The caller's number
  is inside the message.
- `e.read.ai`, 5: our own meeting notes. `stripe.com`, 4.

What changed (`hints.js`, `relinkSystemSenders` in `service.js`, migration 0050):

- Notices are left out at ingest, and stored ones are excluded with the reason in
  `complaint_cases.excluded_why`.
- For a relayed client message the client is looked for inside it: Reply-To, an email address or
  phone number in the subject or text, a Launch27 booking number. Stored cases are checked from
  the stored subject first, then by reading the message again (read-only, up to 200 a run).
  Matched cases get `client_match = 'message'`.
- The playbook opens with a data-quality funnel (`buildFunnel`): all cases, matched, recurring,
  old enough, outcome known, with the cases that drop out at each step and why cases are unmatched.
- "What each response cost and kept" (`by_response`): cost and Saved rate per response over that
  response's own cases only, split by threat level and by severity. Correlation, not cause.

### The method in three names (shown on the playbook page)

- **The 90-day rule.** A recurring client who leaves within 90 days of the complaint is LOST,
  with or without a bad review. Leaving after day 90 is not put down to the complaint.
- **Two missed cycles.** A client has left once two of their own cycles pass with no visit done
  or booked after their last one, and never sooner than 3 weeks: weekly 21 days, biweekly 28,
  every 3 weeks 42, monthly 56 (`leftAfterDays` in `journey.js`). A plan we can't read counts as
  biweekly. This replaced a flat 21 days (35 for monthly), which read one skipped biweekly
  clean as leaving.
- **Saved at 60 days.** Still booking 60+ days after the complaint and no 1-2 star review. A
  1-2 star review is always LOST. One-time clients: booked again within 90 / 120 days.
