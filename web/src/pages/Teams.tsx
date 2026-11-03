import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { l27All } from '../api';
import { inbox } from '../inbox/api';
import { useBrand } from '../brands/useBrand';
import { BrandPill, brandLabel } from '../brands/ui';
import type { Team } from '../types';

// GET /v1/staff/teams?filter=active (or omitted = all)  ·  GET /v1/staff/teams/deleted
// Loads the whole list (a few hundred cleaners at most) so it can follow the brand switcher:
// a cleaner belongs to the brands of their Launch27 locations.
const TABS = [
  { label: 'Active', path: '/v1/staff/teams', params: { filter: 'active' } },
  { label: 'All', path: '/v1/staff/teams', params: {} },
  { label: 'Deleted', path: '/v1/staff/teams/deleted', params: {} },
];

export function TeamsPage() {
  const navigate = useNavigate();
  const brand = useBrand();
  const [tab, setTab] = useState(0);
  const [q, setQ] = useState('');
  const t = TABS[tab];
  const list = useQuery({ queryKey: ['teams-page', t.path, t.params], queryFn: () => l27All<Team>(t.path, t.params), staleTime: 5 * 60_000 });
  // Clicking a cleaner opens their 360 (creating the support contact on first use).
  const open = (row: Team) => inbox.fromL27({ team_id: row.id }).then((c) => navigate(`/contacts/${c.id}`)).catch((err) => alert(err.message));
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (list.data || []).filter((row) => brand.showCleaner(row.locations?.map((l) => l.id)) && (!needle || [row.title, row.first_name, row.last_name, row.email, row.phone].join(' ').toLowerCase().includes(needle)));
  }, [list.data, brand, q]);
  return (
    <>
      <header className="page-header">
        <h1>
          Teams
          {list.data && <span className="muted count"> ({rows.length.toLocaleString()}{brand.view !== 'both' ? ` · ${brandLabel(brand.view)}` : ''})</span>}
        </h1>
        <div className="filters">
          <input placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </header>
      <div className="tabs">
        {TABS.map((x, i) => (
          <button key={x.label} className={i === tab ? 'tab active' : 'tab'} onClick={() => setTab(i)}>{x.label}</button>
        ))}
      </div>
      {list.error && <div className="error">{(list.error as Error).message}</div>}
      <div className="table-wrap cards-on-mobile">
        <table>
          <thead>
            <tr><th>Team</th><th>Brand</th><th>Contact</th><th>Phone</th><th>Email</th><th>Locations</th><th>Rating</th><th>Tags</th></tr>
          </thead>
          <tbody>
            {list.isLoading && <tr><td colSpan={8} className="muted">Loading…</td></tr>}
            {list.data && rows.length === 0 && <tr><td colSpan={8} className="muted">Nothing here.</td></tr>}
            {rows.map((row) => {
              const b = brand.cleanerBrands(row.locations?.map((l) => l.id));
              return (
                <tr key={row.id} onClick={() => open(row)}>
                  <td data-label="Team"><span className="dot" style={{ background: row.bg_color || '#ccc' }} />{row.title}</td>
                  <td data-label="Brand"><BrandPill brand={b[0] ?? null} shared={b.length > 1} always /></td>
                  <td data-label="Contact">{[row.first_name, row.last_name].filter(Boolean).join(' ') || '—'}</td>
                  <td data-label="Phone">{row.phone || '—'}</td>
                  <td data-label="Email">{row.email || '—'}</td>
                  <td data-label="Locations">{row.locations?.map((l) => <span key={l.id} className="pill">{l.name}</span>)}</td>
                  <td data-label="Rating">{row.ratings_count ? `${row.stars ?? row.rating}★ (${row.ratings_count})` : '—'}</td>
                  <td data-label="Tags">{row.tags_info?.map((tag) => <span key={tag.id} className="pill">{tag.name}</span>)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
