import { useEffect, useRef, useState } from 'react';
import { useMeta } from '../inbox/util';
import { BrandLogo } from './BrandLogo';
import { Icon } from './Icon';
import { PortalLogo } from './PortalLogo';

// The brand name at the top of the sidebar. When other brands' portals are set up
// (the PORTALS setting on the server), it opens a menu to switch to them.
export function PortalSwitcher() {
  const meta = useMeta();
  const portal = meta.data?.portal;
  const name = portal?.name || 'UrbanMop';
  const here = typeof window !== 'undefined' ? window.location.origin : '';
  // Other brands only: this portal (by address, or by name on dev and QA) isn't listed again.
  const others = (portal?.links || []).filter((l) => l.url !== here && l.name.toLowerCase() !== name.toLowerCase());
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  if (!others.length) return <BrandLogo name={name} sub="Operations" />;
  return (
    <div ref={box} className="portal-wrap">
      <button type="button" className="portal-switch" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} title="Switch portal">
        <BrandLogo name={name} sub="Operations" />
        <Icon name="chevron" size={14} />
      </button>
      {open && (
        <div className="portal-menu" role="menu">
          <div className="eyebrow">Portals</div>
          <div className="portal-item" aria-current="true">
            <span className="portal-item-name"><PortalLogo name={name} />{name}</span> <span className="muted small">this portal</span>
          </div>
          {others.map((l) => (
            <a key={l.url} role="menuitem" className="portal-item" href={l.url}>
              <span className="portal-item-name"><PortalLogo name={l.name} />{l.name}</span> <span className="muted small">open</span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
