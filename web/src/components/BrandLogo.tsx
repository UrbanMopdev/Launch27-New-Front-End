// The brand mark and name at the top of the sidebar and the sign-in page.
// The UrbanMop logo is web/public/brand/logo.png (from UrbanMop's Drive); if it
// fails to load, the name is shown in text.
import { useState } from 'react';

export function BrandLogo({ name, sub }: { name: string; sub?: string }) {
  const [failed, setFailed] = useState(false);
  const isUrbanMop = /urban\s*mop/i.test(name);
  return (
    <div className="brand-logo">
      {isUrbanMop && !failed ? (
        <img src="/brand/logo.png" alt={name} className="brand-logo-img" onError={() => setFailed(true)} />
      ) : (
        <>
          <div className="brand-mark" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M11 3l1.9 5.1L18 10l-5.1 1.9L11 17l-1.9-5.1L4 10l5.1-1.9z" />
              <path d="M18.5 14l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z" />
            </svg>
          </div>
          <div className="brand-text">
            <div className="brand-name">{name}</div>
            {sub && <div className="brand-sub">{sub}</div>}
          </div>
        </>
      )}
    </div>
  );
}
