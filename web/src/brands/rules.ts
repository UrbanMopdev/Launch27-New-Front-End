// Which brand a Launch27 location belongs to. Admin choices (Support settings → Brands) win;
// otherwise known location names get a default, and anything else has no brand yet.
export type BrandSlug = 'residential' | 'commercial';
export type BrandView = BrandSlug | 'both';

export function suggestBrand(name: string | null | undefined): BrandSlug | null {
  const n = String(name || '').toLowerCase();
  if (/commercial|cornwall/.test(n)) return 'commercial';
  if (/ottawa|kitchener|waterloo|carpet/.test(n)) return 'residential';
  return null;
}

// overrides: location id -> brand slug, or null when an admin chose "no brand".
export function brandForLocation(id: number | null | undefined, name: string | null | undefined, overrides: Record<string, BrandSlug | null>): BrandSlug | null {
  if (id != null && Object.prototype.hasOwnProperty.call(overrides, String(id))) return overrides[String(id)];
  return suggestBrand(name);
}

// A cleaner's brands: those of their Launch27 locations. Two brands = shared.
export function brandsForLocations(ids: number[] | undefined, brandOf: (id: number) => BrandSlug | null): BrandSlug[] {
  const out = new Set<BrandSlug>();
  for (const id of ids || []) {
    const b = brandOf(id);
    if (b) out.add(b);
  }
  return [...out].sort();
}
