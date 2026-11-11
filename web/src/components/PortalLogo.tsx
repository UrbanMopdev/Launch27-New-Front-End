// A portal's logo in the portal menu. Known brands have a logo file (web/public/brand/<slug>.png)
// once one is added below; until then, and for any other portal, a badge with the brand's
// initials in its colour.
import { useState } from 'react';

interface Known { initials: string; color: string; logo?: string }
// Add `logo: '/brand/<slug>.png'` here when the brand's logo file is in web/public/brand/.
const KNOWN: Record<string, Known> = {
  urbanmop: { initials: 'UM', color: '#2f7d4f' },
  cleanbee: { initials: 'CB', color: '#c58b00' },
  luxoclean: { initials: 'LC', color: '#1f4e79' },
  saleshub: { initials: 'SH', color: '#6b4fa3' },
};

export const portalSlug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

export function portalBadge(name: string): Known {
  const known = KNOWN[portalSlug(name)];
  if (known) return known;
  const words = name.trim().split(/\s+/).filter(Boolean);
  const initials = (words.length > 1 ? words[0][0] + words[1][0] : name.slice(0, 2)).toUpperCase();
  return { initials, color: '#5b6573' };
}

export function PortalLogo({ name, size = 28 }: { name: string; size?: number }) {
  const b = portalBadge(name);
  const [failed, setFailed] = useState(false);
  if (b.logo && !failed) return <img className="portal-logo" src={b.logo} alt="" width={size} height={size} onError={() => setFailed(true)} />;
  return (
    <span className="portal-logo portal-logo-badge" aria-hidden="true" style={{ width: size, height: size, background: b.color, fontSize: Math.round(size * 0.4) }}>
      {b.initials}
    </span>
  );
}
