// Crew Planner, part 1: reference data the planner trusts (docs/crew-planner.md).
// Cleaner profiles, client preferences with a review queue, postal-code areas, the starting
// seed, and finding new preferences in Launch27 after each sync. Read-only to Launch27: it
// reads the Scheduling planner's saved copy and never writes to Launch27.
import { readFile } from 'node:fs/promises';
import { suggestBrand } from '../placement/mapping.js';
import { json as toJson } from '../db/index.js';
import { NAMES_CLEANERS, PREF_SOURCES, PREF_TYPES, clusterOf, continuitySuggestion, fsaOf, matchClient, matchCleaner, parsePrefText, tierFromTitle } from './prefs.js';

const SEED_URL = new URL('./seed.json', import.meta.url);
export const EMPLOYMENT = ['employee', 'contractor', 'contractor_guaranteed'];
export const PLANNER_STATUS = ['active', 'on_hold', 'inactive'];
export const CREW_ROLES = ['none', 'lead', 'trainer', 'trainee'];
export const JOB_TYPES = ['prepaid', 'one_time', 'move_in_out', 'recurring', 'deep_clean'];
const PREF_ACTIONS = ['confirm', 'reject', 'deactivate', 'reactivate'];

export class CrewError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// A visit the Crew Planner may plan: Residential, in Ottawa, not a partner (Carefor, QCH, Bruyère,
// OWCS, homemaking). brandOf: location id → brand chosen by an admin (brand_locations), if any.
export function isResidentialOttawa(v, brandOf = new Map()) {
  if (!v || v.partner || v.partner_kind) return false;
  const name = String(v.location_name || '');
  if (!name) return false;
  const brand = brandOf.has(Number(v.location_id)) ? brandOf.get(Number(v.location_id)) : suggestBrand(name);
  return brand === 'residential' && /ottawa/i.test(name) && !/commercial|cornwall/i.test(name);
}

// The planner's status for a cleaner with no profile yet, from Launch27's title codes.
const statusFromL27 = (s) => (s === 'on_hold' ? 'on_hold' : s === 'off_schedule' ? 'inactive' : 'active');

export function createCrew({ db, config, schedule, log = { info() {}, warn() {}, error() {} }, seedUrl = SEED_URL }) {
  let lastIngest = null; // { taken_at, at, created }
  let ingesting = null;

  const many = async (sql, p) => (await db.query(sql, p)).rows;
  const one = async (sql, p) => (await db.query(sql, p)).rows[0] || null;
  const audit = (actorId, action, objectType, objectId, detail = {}) =>
    db.query('INSERT INTO audit_log (actor_id, action, object_type, object_id, detail) VALUES ($1,$2,$3,$4,$5::jsonb)', [actorId || null, action, objectType, objectId == null ? null : String(objectId), toJson(detail)]);

  const source = async () => {
    try {
      return await schedule.crewSource();
    } catch (err) {
      if (err.status === 409) throw new CrewError(409, err.message);
      throw err;
    }
  };
  const brandOverrides = async () => new Map((await many('SELECT location_id, brand FROM brand_locations')).map((r) => [Number(r.location_id), r.brand]));
  const profiles = async () => new Map((await many('SELECT * FROM cp_cleaner_profile')).map((r) => [Number(r.cleaner_id), r]));

  // ---------- cleaners ----------
  function cleanerView(c, p, { admin }) {
    const parsedTier = tierFromTitle(c?.title);
    const out = {
      id: Number(c?.id ?? p.cleaner_id),
      name: p?.display_name || c?.name || `Cleaner ${p?.cleaner_id}`,
      l27_name: c?.name || null,
      in_launch27: !!c,
      l27_status: c?.status || null,
      l27_status_label: c?.status_label || null,
      location_ids: c?.location_ids || [],
      weekly_hours: c?.weekly_hours ?? null,
      gender: p?.gender || c?.gender || null,
      gender_from: p?.gender ? 'app' : c?.gender ? 'launch27' : null,
      tier: p?.tier ?? parsedTier,
      tier_from: p?.tier != null ? 'app' : parsedTier != null ? 'launch27' : null,
      status: p ? p.status : statusFromL27(c?.status),
      protected: !!p?.protected,
      low_performer: !!p?.low_performer,
      employment: p?.employment || 'contractor',
      crew_role: p?.crew_role || 'none',
      prefers_job_types: p?.prefers_job_types || [],
      aliases: p?.aliases || [],
      note: p?.note || null,
      has_profile: !!p,
      updated_at: p?.updated_at || null,
    };
    if (admin) out.rating_pct = p?.rating_pct == null ? null : Number(p.rating_pct);
    return out;
  }

  async function cleaners({ admin = false } = {}) {
    const src = await source();
    const prof = await profiles();
    const seen = new Set();
    const list = src.cleaners.map((c) => {
      seen.add(Number(c.id));
      return cleanerView(c, prof.get(Number(c.id)), { admin });
    });
    for (const [id, p] of prof) if (!seen.has(id)) list.push(cleanerView(null, p, { admin }));
    return { cleaners: list.sort((a, b) => Number(b.in_launch27) - Number(a.in_launch27) || a.name.localeCompare(b.name)) };
  }

  const PROFILE_FIELDS = {
    display_name: (v) => (v == null || v === '' ? null : String(v).trim().slice(0, 80)),
    aliases: (v) => (Array.isArray(v) ? [...new Set(v.map((x) => String(x).trim().slice(0, 40)).filter(Boolean))].slice(0, 10) : bad('aliases must be a list')),
    gender: (v) => (v == null || v === '' ? null : ['F', 'M'].includes(v) ? v : bad('gender is F or M')),
    tier: (v) => (v == null || v === '' ? null : [1, 2, 3].includes(Number(v)) ? Number(v) : bad('tier is 1, 2 or 3')),
    rating_pct: (v) => (v == null || v === '' ? null : Number(v) >= 0 && Number(v) <= 100 ? Number(v) : bad('rating is 0 to 100')),
    protected: (v) => !!v,
    low_performer: (v) => !!v,
    employment: (v) => (EMPLOYMENT.includes(v) ? v : bad(`employment is one of ${EMPLOYMENT.join(', ')}`)),
    status: (v) => (PLANNER_STATUS.includes(v) ? v : bad(`status is one of ${PLANNER_STATUS.join(', ')}`)),
    crew_role: (v) => (CREW_ROLES.includes(v) ? v : bad(`crew role is one of ${CREW_ROLES.join(', ')}`)),
    prefers_job_types: (v) => (Array.isArray(v) && v.every((x) => JOB_TYPES.includes(x)) ? [...new Set(v)] : bad(`job types are ${JOB_TYPES.join(', ')}`)),
    note: (v) => (v == null || v === '' ? null : String(v).slice(0, 500)),
  };
  function bad(msg) {
    throw new CrewError(400, msg);
  }

  // patch: any PROFILE_FIELDS. rating_pct only for admins. Creates the profile on first save,
  // starting from what Launch27 says (so saving one field doesn't reset the rest).
  async function saveCleaner(id, patch, user) {
    const cleanerId = Number(id);
    if (!Number.isInteger(cleanerId) || cleanerId <= 0) bad('Unknown cleaner');
    if ('rating_pct' in (patch || {}) && user.role !== 'admin') throw new CrewError(403, 'Only admins can change ratings');
    const clean = {};
    for (const [k, v] of Object.entries(patch || {})) if (PROFILE_FIELDS[k]) clean[k] = PROFILE_FIELDS[k](v);
    if (!Object.keys(clean).length) bad('Nothing to change');
    const before = await one('SELECT * FROM cp_cleaner_profile WHERE cleaner_id = $1', [cleanerId]);
    if (!before) {
      const c = (await source()).cleaners.find((x) => Number(x.id) === cleanerId);
      if (!c) throw new CrewError(404, 'That cleaner is not in Launch27');
      await db.query('INSERT INTO cp_cleaner_profile (cleaner_id, status) VALUES ($1, $2) ON CONFLICT (cleaner_id) DO NOTHING', [cleanerId, statusFromL27(c.status)]);
    }
    const cols = Object.keys(clean);
    const jsonCols = new Set(['aliases', 'prefers_job_types']);
    const sets = cols.map((k, i) => `${k} = $${i + 2}${jsonCols.has(k) ? '::jsonb' : ''}`);
    const vals = cols.map((k) => (jsonCols.has(k) ? toJson(clean[k]) : clean[k]));
    const row = await one(`UPDATE cp_cleaner_profile SET ${sets.join(', ')}, updated_by = $${cols.length + 2}, updated_at = now() WHERE cleaner_id = $1 RETURNING *`, [cleanerId, ...vals, user.id]);
    const changed = Object.fromEntries(cols.filter((k) => JSON.stringify(before?.[k] ?? null) !== JSON.stringify(row[k] ?? null)).map((k) => [k, { from: before ? before[k] ?? null : null, to: row[k] ?? null }]));
    await audit(user.id, 'crew.cleaner.updated', 'cleaner', cleanerId, { changed });
    return row;
  }

  // ---------- client preferences ----------
  async function prefs({ status = null, source: src = null, q = null, client_id = null } = {}) {
    const where = [];
    const p = [];
    if (status) {
      p.push(status);
      where.push(`p.status = $${p.length}`);
    }
    if (status && !['pending', 'confirmed', 'rejected'].includes(status)) bad('status is pending, confirmed or rejected');
    if (src && !PREF_SOURCES.includes(src)) bad(`source is one of ${PREF_SOURCES.join(', ')}`);
    if (src) {
      p.push(src);
      where.push(`p.source = $${p.length}`);
    }
    if (client_id != null) {
      p.push(String(client_id));
      where.push(`p.client_id = $${p.length}`);
    }
    if (q) {
      p.push(`%${String(q).toLowerCase()}%`);
      where.push(`(lower(coalesce(p.client_name, '')) LIKE $${p.length} OR lower(coalesce(p.note, '')) LIKE $${p.length} OR lower(coalesce(p.source_text, '')) LIKE $${p.length})`);
    }
    const rows = await many(`SELECT p.*, u.name AS confirmed_by_name FROM cp_client_pref p LEFT JOIN users u ON u.id = p.confirmed_by ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY (p.status = 'pending') DESC, p.active DESC, lower(coalesce(p.client_name, '')), p.type, p.id LIMIT 2000`, p);
    let names = new Map();
    try {
      const src2 = await source();
      const prof = await profiles();
      names = new Map(src2.cleaners.map((c) => [Number(c.id), prof.get(Number(c.id))?.display_name || c.name]));
    } catch {
      // Planner not loaded yet: show ids.
    }
    const counts = Object.fromEntries((await many("SELECT status, count(*)::int AS n FROM cp_client_pref WHERE active GROUP BY status")).map((r) => [r.status, r.n]));
    return {
      counts: { pending: counts.pending || 0, confirmed: counts.confirmed || 0, rejected: counts.rejected || 0 },
      prefs: rows.map((r) => ({
        id: Number(r.id), client_id: r.client_id, client_name: r.client_name, type: r.type,
        cleaners: (r.cleaner_ids || []).map((id) => ({ id: Number(id), name: names.get(Number(id)) || `Cleaner ${id}` })),
        note: r.note, source: r.source, source_text: r.source_text, status: r.status, active: r.active,
        confirmed_by: r.confirmed_by_name || null, confirmed_at: r.confirmed_at, created_at: r.created_at,
      })),
    };
  }

  const checkPref = ({ type, cleaner_ids = [] }) => {
    if (!PREF_TYPES.includes(type)) bad(`type is one of ${PREF_TYPES.join(', ')}`);
    const ids = (Array.isArray(cleaner_ids) ? cleaner_ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (NAMES_CLEANERS.has(type) && !ids.length) bad('Pick at least one cleaner');
    return NAMES_CLEANERS.has(type) ? [...new Set(ids)] : [];
  };

  // Grace adds one herself: confirmed right away.
  async function addPref(body, user) {
    const ids = checkPref(body || {});
    if (body?.client_id == null || body.client_id === '') bad('Pick a client');
    const row = await one(
      "INSERT INTO cp_client_pref (client_id, client_name, type, cleaner_ids, note, source, status, confirmed_by, confirmed_at, created_by) VALUES ($1,$2,$3,$4::jsonb,$5,'grace_manual','confirmed',$6,now(),$6) RETURNING id",
      [String(body.client_id), body.client_name ? String(body.client_name).slice(0, 120) : null, body.type, toJson(ids), body.note ? String(body.note).slice(0, 500) : null, user.id],
    );
    await audit(user.id, 'crew.pref.added', 'client_pref', row.id, { client_id: String(body.client_id), type: body.type, cleaner_ids: ids });
    return { id: Number(row.id) };
  }

  // confirm / reject / deactivate / reactivate. A confirm can also fix the cleaners or note
  // (e.g. when a name in the notes matched no one).
  async function prefAction(id, action, user, edits = {}) {
    if (!PREF_ACTIONS.includes(action)) bad(`action is one of ${PREF_ACTIONS.join(', ')}`);
    const before = await one('SELECT * FROM cp_client_pref WHERE id = $1', [Number(id)]);
    if (!before) throw new CrewError(404, 'Preference not found');
    let ids = before.cleaner_ids || [];
    if (edits.cleaner_ids !== undefined) ids = checkPref({ type: edits.type || before.type, cleaner_ids: edits.cleaner_ids });
    const type = edits.type && PREF_TYPES.includes(edits.type) ? edits.type : before.type;
    if (action === 'confirm' && NAMES_CLEANERS.has(type) && !ids.length) bad('Pick the cleaner before confirming');
    const note = edits.note !== undefined ? (edits.note ? String(edits.note).slice(0, 500) : null) : before.note;
    const set = {
      confirm: ["status = 'confirmed', active = true, confirmed_by = $2, confirmed_at = now()"],
      reject: ["status = 'rejected', confirmed_by = $2, confirmed_at = now()"],
      deactivate: ['active = false'],
      reactivate: ['active = true'],
    }[action];
    await db.query(`UPDATE cp_client_pref SET ${set[0]}, type = $3, cleaner_ids = $4::jsonb, note = $5, updated_at = now() WHERE id = $1`, [before.id, user.id, type, toJson(ids), note]);
    await audit(user.id, `crew.pref.${action}`, 'client_pref', before.id, { client_id: before.client_id, type, cleaner_ids: ids, was: { status: before.status, active: before.active, type: before.type, cleaner_ids: before.cleaner_ids } });
    return { id: Number(before.id) };
  }

  async function bulkPrefs(ids, action, user) {
    if (!Array.isArray(ids) || !ids.length) bad('Pick some preferences');
    if (!['confirm', 'reject'].includes(action)) bad('Bulk action is confirm or reject');
    const done = [];
    const skipped = [];
    for (const id of ids.slice(0, 500)) {
      try {
        await prefAction(id, action, user);
        done.push(Number(id));
      } catch (err) {
        if (!(err instanceof CrewError)) throw err;
        skipped.push({ id: Number(id), why: err.message });
      }
    }
    return { done: done.length, skipped };
  }

  // ---------- postal-code areas ----------
  async function clusters() {
    const rows = await many('SELECT fsa, cluster FROM cp_fsa_cluster ORDER BY cluster, fsa');
    return { clusters: rows, names: [...new Set(rows.map((r) => r.cluster))] };
  }
  async function saveCluster(fsa, cluster, user) {
    const f = fsaOf(fsa);
    if (!f || f.length !== 3) bad('A postal-code area is the first three characters, e.g. K2G');
    if (cluster == null || cluster === '') {
      await db.query('DELETE FROM cp_fsa_cluster WHERE fsa = $1', [f]);
      await audit(user.id, 'crew.area.removed', 'fsa', f, {});
      return { fsa: f, cluster: null };
    }
    const name = String(cluster).trim().slice(0, 60);
    await db.query('INSERT INTO cp_fsa_cluster (fsa, cluster, updated_by) VALUES ($1,$2,$3) ON CONFLICT (fsa) DO UPDATE SET cluster = EXCLUDED.cluster, updated_by = EXCLUDED.updated_by, updated_at = now()', [f, name, user.id]);
    await audit(user.id, 'crew.area.saved', 'fsa', f, { cluster: name });
    return { fsa: f, cluster: name };
  }
  async function clusterMap() {
    return new Map((await many('SELECT fsa, cluster FROM cp_fsa_cluster')).map((r) => [r.fsa, r.cluster]));
  }

  // ---------- name lists for matching ----------
  async function matchLists() {
    const src = await source();
    const prof = await profiles();
    const brandOf = await brandOverrides();
    const cleanersList = src.cleaners.map((c) => {
      const p = prof.get(Number(c.id));
      return { id: Number(c.id), name: c.name, aliases: [...(p?.aliases || []), ...(p?.display_name ? [p.display_name] : [])] };
    });
    const resVisits = new Map(); // customer id -> residential Ottawa visits
    for (const v of src.visits) {
      if (v.customer_id == null || !isResidentialOttawa(v, brandOf)) continue;
      if (!resVisits.has(v.customer_id)) resVisits.set(v.customer_id, []);
      resVisits.get(v.customer_id).push(v);
    }
    const customers = src.customers.filter((c) => resVisits.has(c.id));
    return { src, prof, cleanersList, customers, resVisits };
  }

  // ---------- the starting seed ----------
  async function loadSeed(user) {
    const seed = JSON.parse(await readFile(seedUrl, 'utf8'));
    const { src, prof, cleanersList, customers } = await matchLists();
    const report = { cleaners: { set: [], already: [], unmatched: [], ambiguous: [] }, prefs: { added: [], already: [], needs_cleaner: [], unmatched_clients: [], ambiguous_clients: [] }, needs_decision: seed.needs_decision || [] };
    const byId = new Map(src.cleaners.map((c) => [Number(c.id), c]));
    const nameOf = (id) => byId.get(Number(id))?.name || `Cleaner ${id}`;

    // Cleaners: match the seed names first (their aliases help the preferences below).
    const seedAliases = new Map();
    for (const s of seed.cleaners || []) {
      // Full name only: a nickname ("Casey") could be someone else. Aliases help preferences below.
      const m = matchCleaner(s.name, cleanersList.map((c) => ({ ...c, aliases: [] })));
      if (!m) {
        report.cleaners.unmatched.push(s.name);
        continue;
      }
      if (m.ambiguous) {
        report.cleaners.ambiguous.push({ name: s.name, matches: m.ambiguous.map(nameOf) });
        continue;
      }
      seedAliases.set(m.id, s.aliases || []);
      if (prof.has(m.id)) {
        report.cleaners.already.push(nameOf(m.id));
        continue;
      }
      const c = byId.get(m.id);
      await db.query(
        'INSERT INTO cp_cleaner_profile (cleaner_id, aliases, protected, low_performer, employment, status, crew_role, prefers_job_types, note, updated_by) VALUES ($1,$2::jsonb,$3,$4,$5,$6,$7,$8::jsonb,$9,$10) ON CONFLICT (cleaner_id) DO NOTHING',
        [m.id, toJson(s.aliases || []), !!s.protected, !!s.low_performer, s.employment || 'contractor', s.status || statusFromL27(c?.status), s.crew_role || 'none', toJson(s.prefers_job_types || []), s.note || null, user.id],
      );
      report.cleaners.set.push(`${s.name} → ${nameOf(m.id)}`);
    }
    for (const c of cleanersList) c.aliases = [...c.aliases, ...(seedAliases.get(c.id) || [])];

    // Preferences Grace has already confirmed.
    for (const s of seed.prefs || []) {
      const cm = matchClient(s.client, customers);
      if (!cm) {
        report.prefs.unmatched_clients.push(s.client);
        continue;
      }
      if (cm.ambiguous) {
        report.prefs.ambiguous_clients.push({ client: s.client, matches: cm.ambiguous.length });
        continue;
      }
      const client = customers.find((c) => c.id === cm.id);
      const ids = [];
      const missing = [];
      for (const n of s.cleaners || []) {
        const m = matchCleaner(n, cleanersList);
        if (m?.id) ids.push(m.id);
        else missing.push(m?.ambiguous ? `${n} (could be ${m.ambiguous.map(nameOf).join(' or ')})` : n);
      }
      const complete = !missing.length;
      const key = `seed|${client.id}|${s.type}|${(s.cleaners || []).map((x) => x.toLowerCase()).join(',')}`;
      const note = [s.note, complete ? null : `Couldn't match ${missing.join(', ')} to a cleaner: pick the cleaner and confirm.`].filter(Boolean).join(' · ') || null;
      const row = await one(
        "INSERT INTO cp_client_pref (client_id, client_name, type, cleaner_ids, note, source, source_text, status, confirmed_by, confirmed_at, dedupe_key, created_by) VALUES ($1,$2,$3,$4::jsonb,$5,'grace_manual',$6,$7,$8,$9,$10,$11) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id",
        [String(client.id), client.name, s.type, toJson(ids), note, `Seed: ${s.client}: ${s.type}${s.cleaners?.length ? ` ${s.cleaners.join(' / ')}` : ''}`, complete ? 'confirmed' : 'pending', complete ? user.id : null, complete ? new Date().toISOString() : null, key, user.id],
      );
      const label = `${client.name}: ${s.type}${ids.length ? ` ${ids.map(nameOf).join(' / ')}` : ''}`;
      if (!row) report.prefs.already.push(label);
      else if (complete) report.prefs.added.push(label);
      else report.prefs.needs_cleaner.push(`${client.name}: ${missing.join(', ')}`);
    }
    await db.query('INSERT INTO cp_seed_runs (report, run_by) VALUES ($1::jsonb, $2)', [toJson(report), user.id]);
    await audit(user.id, 'crew.seed.loaded', 'workspace', 'crew_planner', { cleaners: report.cleaners.set.length, prefs: report.prefs.added.length, unmatched: report.cleaners.unmatched.length + report.prefs.unmatched_clients.length });
    return report;
  }

  // ---------- finding new preferences ----------
  // After each sync: parse every Residential Ottawa client's Launch27 tags and notes, and their
  // visit history, into pending preferences. Never suggests the same thing twice (a rejected one
  // stays rejected) and never touches confirmed ones.
  async function ingest({ force = false } = {}) {
    if (ingesting) return ingesting;
    ingesting = (async () => {
      const { src, prof, cleanersList, customers, resVisits } = await matchLists();
      if (!force && lastIngest?.taken_at === src.taken_at) return { ...lastIngest, skipped: true };
      const confirmedRows = await many("SELECT client_id, type, cleaner_ids FROM cp_client_pref WHERE status = 'confirmed' AND active");
      const confirmedPref = new Set(confirmedRows.filter((r) => r.type === 'PREF_CLEANER').map((r) => r.client_id));
      // Already confirmed (same client, type and cleaners): don't ask again.
      const sameKey = (clientId, type, ids) => `${clientId}|${type}|${[...ids].map(Number).sort((a, b) => a - b).join(',')}`;
      const confirmed = new Set(confirmedRows.map((r) => sameKey(r.client_id, r.type, r.cleaner_ids || [])));
      const today = src.today;
      let created = 0;
      const insert = async (client, type, ids, source, sourceText, key, note = null) => {
        if (confirmed.has(sameKey(String(client.id), type, ids))) return;
        const r = await one(
          'INSERT INTO cp_client_pref (client_id, client_name, type, cleaner_ids, note, source, source_text, dedupe_key) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id',
          [String(client.id), client.name, type, toJson(ids), note, source, sourceText ? String(sourceText).slice(0, 500) : null, key],
        );
        if (r) created++;
      };
      for (const client of customers) {
        const visits = resVisits.get(client.id) || [];
        if (!visits.some((v) => v.date >= today)) continue; // only clients still booked
        const texts = new Map(); // text -> source
        for (const v of visits) {
          for (const t of v.ctags || []) texts.set(t, 'launch27_tag');
          for (const t of [v.staff_notes, v.customer_notes]) if (t) texts.set(t, 'launch27_note');
        }
        for (const [text, src2] of texts) {
          for (const p of parsePrefText(text)) {
            const ids = [];
            const missing = [];
            for (const n of p.names) {
              const m = matchCleaner(n, cleanersList);
              if (m?.id) ids.push(m.id);
              else missing.push(n);
            }
            const key = `${src2}|${client.id}|${p.type}|${p.names.map((x) => x.toLowerCase()).join(',')}`;
            await insert(client, p.type, ids, src2, p.text, key, missing.length ? `Couldn't match ${missing.join(', ')} to a cleaner` : null);
          }
        }
        // A regular cleaner in the history (3+ visits and more than half).
        if (!client.recurring || confirmedPref.has(String(client.id))) continue;
        const s = continuitySuggestion(client.history);
        if (!s) continue;
        const p = prof.get(s.cleaner_id);
        if (p && p.status !== 'active') continue; // their regular has left or is on hold: the planner handles that
        if (!src.cleaners.some((c) => Number(c.id) === s.cleaner_id)) continue;
        await insert(client, 'PREF_CLEANER', [s.cleaner_id], 'continuity_history', `${s.visits} of their last ${s.of} visits`, `hist|${client.id}|${s.cleaner_id}`);
      }
      lastIngest = { taken_at: src.taken_at, at: new Date().toISOString(), created };
      if (created) log.info('crew planner: new preferences to review', { created });
      return lastIngest;
    })().finally(() => {
      ingesting = null;
    });
    return ingesting;
  }
  // Worker: after the planner's copy changes. Quiet when the planner hasn't loaded yet.
  async function maybeIngest() {
    if (!config.crewPlannerEnabled) return null;
    try {
      return await ingest();
    } catch (err) {
      if (err.status === 409) return null;
      throw err;
    }
  }

  async function status() {
    const counts = await one("SELECT (SELECT count(*)::int FROM cp_client_pref WHERE status = 'pending' AND active) AS pending, (SELECT count(*)::int FROM cp_client_pref WHERE status = 'confirmed' AND active) AS confirmed, (SELECT count(*)::int FROM cp_cleaner_profile) AS profiles, (SELECT count(*)::int FROM cp_fsa_cluster) AS areas");
    const seedRun = await one('SELECT s.run_at, s.report, u.name AS run_by FROM cp_seed_runs s LEFT JOIN users u ON u.id = s.run_by ORDER BY s.id DESC LIMIT 1');
    let snapshotAt = null;
    try {
      snapshotAt = (await schedule.crewSource()).taken_at;
    } catch {
      // not loaded yet
    }
    return { counts, seed: seedRun ? { run_at: seedRun.run_at, run_by: seedRun.run_by, report: seedRun.report } : null, last_ingest: lastIngest, snapshot_at: snapshotAt, drive_times: 'estimated' };
  }

  // For tests and the next phase: postal code → area name.
  async function areaOf(zip) {
    return clusterOf(zip, await clusterMap());
  }

  return { status, cleaners, saveCleaner, prefs, addPref, prefAction, bulkPrefs, clusters, saveCluster, loadSeed, ingest, maybeIngest, areaOf };
}
