// Who is this number or email in Launch27? Used when a message arrives from someone the
// workspace hasn't seen before, and when an agent opens a Launch27 customer or cleaner.
import { normalizeEmail, normalizePhone } from './normalize.js';

const TEAM_TTL = 10 * 60_000;

export function createL27Client({ baseUrl, fetchImpl = fetch }) {
  let teamCache = null;
  const get = async (bearer, path, params = {}) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== '')).toString();
    const res = await fetchImpl(`${baseUrl}${path}${qs ? `?${qs}` : ''}`, {
      headers: { authorization: `Bearer ${bearer}`, accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Launch27 ${path} returned ${res.status}`);
    return res.json();
  };

  async function teams(bearer) {
    if (teamCache && teamCache.at > Date.now() - TEAM_TTL) return teamCache.list;
    const list = [];
    for (let offset = 0; offset < 5000; offset += 100) {
      const page = await get(bearer, '/v1/staff/teams', { limit: 100, offset });
      list.push(...page);
      if (page.length < 100) break;
    }
    teamCache = { at: Date.now(), list };
    return list;
  }

  const customerToContact = (c, phones = []) => ({
    name: [c.first_name, c.last_name].filter(Boolean).join(' ') || c.company_name || c.email,
    roles: ['customer'],
    l27_customer_id: c.id,
    identities: [
      c.email && { kind: 'email', value: c.email },
      c.phone && { kind: 'phone', value: c.phone },
      ...phones.map((p) => ({ kind: 'phone', value: p.phone, label: p.label })),
    ].filter(Boolean),
  });

  const teamToContact = (t) => ({
    name: [t.first_name, t.last_name].filter(Boolean).join(' ') || t.title,
    roles: ['cleaner'],
    l27_team_id: t.id,
    identities: [t.email && { kind: 'email', value: t.email }, t.phone && { kind: 'phone', value: t.phone }].filter(Boolean),
  });

  return {
    // Find the Launch27 cleaner or customer behind an email or phone. Cleaners win:
    // a cleaner who once booked a clean is still a cleaner when they text the ops line.
    async identify(bearer, kind, value) {
      if (!bearer) return null;
      const norm = kind === 'email' ? normalizeEmail : normalizePhone;
      const target = norm(value);
      if (!target) return null;
      try {
        const team = (await teams(bearer)).find((t) => norm(kind === 'email' ? t.email : t.phone) === target);
        if (team) return teamToContact(team);
        const query = kind === 'email' ? target : target.slice(-10);
        const found = await get(bearer, '/v1/staff/customers', { query, limit: 10 });
        const exact = (found || []).filter((c) => norm(kind === 'email' ? c.email : c.phone) === target);
        if (exact.length === 1) return customerToContact(exact[0]);
      } catch {
        // Launch27 being slow or down never blocks a message from landing.
      }
      return null;
    },
    async customer(bearer, id) {
      const [c, phones] = await Promise.all([get(bearer, `/v1/staff/customers/${id}`), get(bearer, `/v1/staff/customers/${id}/phones`).catch(() => [])]);
      return customerToContact(c, phones || []);
    },
    async team(bearer, id) {
      return teamToContact(await get(bearer, `/v1/staff/teams/${id}`));
    },
  };
}
