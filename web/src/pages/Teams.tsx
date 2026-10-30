import { ResourceList } from '../components/ResourceList';
import type { Team } from '../types';

// GET /v1/staff/teams?filter=active (or omitted = all)&limit&offset  (+ /count)
// GET /v1/staff/teams/deleted
export function TeamsPage() {
  return (
    <ResourceList<Team>
      title="Teams"
      path="/v1/staff/teams"
      searchParam="query"
      tabs={[
        { label: 'Active', params: { filter: 'active' } },
        { label: 'All' },
        { label: 'Deleted', path: '/v1/staff/teams/deleted' },
      ]}
      columns={[
        { header: 'Team', render: (t) => (
          <>
            <span className="dot" style={{ background: t.bg_color || '#ccc' }} />
            {t.title}
          </>
        ) },
        { header: 'Contact', render: (t) => [t.first_name, t.last_name].filter(Boolean).join(' ') || '—' },
        { header: 'Phone', render: (t) => t.phone || '—' },
        { header: 'Email', render: (t) => t.email || '—' },
        { header: 'Locations', render: (t) => t.locations?.map((l) => <span key={l.id} className="pill">{l.name}</span>) },
        { header: 'Rating', render: (t) => (t.ratings_count ? `${t.stars ?? t.rating}★ (${t.ratings_count})` : '—') },
        { header: 'Tags', render: (t) => t.tags_info?.map((tag) => <span key={tag.id} className="pill">{tag.name}</span>) },
      ]}
    />
  );
}
