// Support settings → Brands: which Launch27 locations belong to which brand, who works on
// each, and which cleaners are shared. Admins change it; everyone else can read it.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useActiveTeams, useLocations } from '../hooks';
import { brandsApi } from './api';
import { brandForLocation, brandsForLocations, type BrandSlug } from './rules';
import { useBrandsData } from './useBrand';

export function BrandsSettings({ canEdit }: { canEdit: boolean }) {
  const data = useBrandsData();
  const locations = useLocations();
  const teams = useActiveTeams();
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ['brands'] });
  const setLoc = useMutation({ mutationFn: (v: { id: number; name: string; brand: BrandSlug | null }) => brandsApi.setLocation(v.id, v.name, v.brand), onSuccess: refresh });
  const setPerson = useMutation({ mutationFn: (v: { id: number; brand: BrandSlug | null }) => brandsApi.setPerson(v.id, v.brand), onSuccess: refresh });
  if (data.isLoading || locations.isLoading) return <div className="muted">Loading…</div>;
  if (!data.data) return <div className="muted">Couldn't load brands.</div>;
  const { brands, overrides, people } = data.data;
  const locs = locations.data || [];
  const brandOf = (id: number) => brandForLocation(id, locs.find((l) => l.id === id)?.name, overrides);
  const unbranded = locs.filter((l) => !brandOf(l.id));
  const shared = (teams.data || []).filter((t) => brandsForLocations((t.locations || []).map((l) => l.id), brandOf).length > 1);
  const value = (b: BrandSlug | null) => b || '';
  const pick = (v: string) => (v ? (v as BrandSlug) : null);

  return (
    <>
      <div className="ws-intro">
        <p className="muted small">Each Launch27 location belongs to one brand. Bookings, cleaners and customers take their brand from it, and the switcher at the top of the menu filters every screen. {canEdit ? '' : 'Only admins can change this.'}</p>
      </div>
      {unbranded.length > 0 && (
        <div className="brands-warn" role="status">
          <b>{unbranded.length === 1 ? '1 location has no brand yet' : `${unbranded.length} locations have no brand yet`}:</b> {unbranded.map((l) => l.name).join(', ')}. Their bookings and cleaners only show under "Both" until you pick one.
        </div>
      )}

      <h3>Launch27 locations</h3>
      {locs.map((l) => {
        const set = Object.prototype.hasOwnProperty.call(overrides, String(l.id));
        const b = brandOf(l.id);
        return (
          <div key={l.id} className="brands-loc">
            <span className="name">{l.name}</span>
            {!set && b && <span className="muted small">default for this name</span>}
            <label className="small">
              Brand{' '}
              <select value={value(b)} disabled={!canEdit || setLoc.isPending} onChange={(e) => setLoc.mutate({ id: l.id, name: l.name, brand: pick(e.target.value) })}>
                {brands.map((x) => <option key={x.slug} value={x.slug}>{x.name}</option>)}
                <option value="">No brand</option>
              </select>
            </label>
          </div>
        );
      })}
      {setLoc.isError && <div className="error">{(setLoc.error as Error).message}</div>}

      <h3 style={{ marginTop: 28 }}>Shared cleaners <span className="muted">· {shared.length}</span></h3>
      <p className="muted small">Set up in Launch27 for locations in both brands. Both teams see and can book them, with a "Shared" label. Remove the other brand's locations from a cleaner in Launch27 to end the overlap; this list empties on its own.</p>
      {shared.length > 0 && <p className="small">{shared.map((t) => t.title?.replace(/^\s*(on\s*hold\s*)?(\s*\([^)]*\))*\s*/i, '') || `Cleaner ${t.id}`).join(', ')}</p>}

      <h3 style={{ marginTop: 28 }}>Who works on which brand</h3>
      <p className="muted small">Each person opens the app on their brand and can still switch. "Both" suits owners and people covering both teams.</p>
      {people.map((p) => (
        <div key={p.id} className="brands-loc">
          <span className="name">{p.name || p.email}<span className="muted small"> · {p.email}</span></span>
          <label className="small">
            Brand{' '}
            <select value={value(p.brand)} disabled={!canEdit || setPerson.isPending} onChange={(e) => setPerson.mutate({ id: p.id, brand: pick(e.target.value) })}>
              {brands.map((x) => <option key={x.slug} value={x.slug}>{x.name}</option>)}
              <option value="">Both brands</option>
            </select>
          </label>
        </div>
      ))}
      {setPerson.isError && <div className="error">{(setPerson.error as Error).message}</div>}

      <h3 style={{ marginTop: 28 }}>What customers see</h3>
      {brands.map((b) => (
        <p key={b.slug} className="small"><span className={`brand-pill ${b.slug}`}>{b.name}</span> Phone and email: set up when texting and email are connected. Signature: {b.signature || '—'}.</p>
      ))}
    </>
  );
}
