// Brand switcher (sidebar) and the small brand label used across screens.
import { useBrand } from './useBrand';
import type { BrandSlug } from './rules';

const SHORT: Record<BrandSlug, string> = { residential: 'Residential', commercial: 'Commercial' };

export function BrandSwitcher() {
  const { view, setView, ready } = useBrand();
  if (!ready) return null;
  const opt = (v: typeof view, label: string, dot?: BrandSlug) => (
    <button type="button" className={view === v ? 'brand-seg on' : 'brand-seg'} aria-pressed={view === v} onClick={() => setView(v)} title={label}>
      {dot && <span className={`brand-dot ${dot}`} aria-hidden="true" />}
      <span className="label">{label}</span>
    </button>
  );
  return (
    <div className="brand-switch" role="group" aria-label="Brand">
      {opt('residential', 'Residential', 'residential')}
      {opt('commercial', 'Commercial', 'commercial')}
      {opt('both', 'Both')}
    </div>
  );
}

// A label for one record's brand. "shared" for cleaners working in both.
export function BrandPill({ brand, shared = false, always = false }: { brand: BrandSlug | null | undefined; shared?: boolean; always?: boolean }) {
  const { view } = useBrand();
  if (shared) return <span className="brand-pill shared">Shared · both brands</span>;
  if (!brand) return always ? <span className="brand-pill none">No brand</span> : null;
  // On a single-brand view everything is that brand: the label only adds noise.
  if (!always && view !== 'both') return null;
  return <span className={`brand-pill ${brand}`}>{SHORT[brand]}</span>;
}

export function brandLabel(view: 'residential' | 'commercial' | 'both') {
  return view === 'both' ? 'Both brands' : `UrbanMop ${SHORT[view]}`;
}

// On one brand's view: flags a customer who also books the other brand now.
export function AlsoOtherBrand({ locationIds }: { locationIds?: number[] }) {
  const { view, brandOf } = useBrand();
  if (view === 'both' || !locationIds?.length) return null;
  const other = locationIds.map((id) => brandOf(id)).find((b) => b && b !== view);
  return other ? <span className={`brand-pill ${other}`} title="Has current bookings in the other brand too">Also {SHORT[other]}</span> : null;
}
