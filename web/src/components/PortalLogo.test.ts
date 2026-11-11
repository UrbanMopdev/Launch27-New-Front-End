import { describe, expect, it } from 'vitest';
import { portalBadge, portalSlug } from './PortalLogo';

describe('portal logos', () => {
  it('knows the family of portals by name, however it is written', () => {
    expect(portalSlug('Clean Bee')).toBe('cleanbee');
    expect(portalBadge('UrbanMop').initials).toBe('UM');
    expect(portalBadge('Urban Mop').initials).toBe('UM');
    expect(portalBadge('clean bee').initials).toBe('CB');
    expect(portalBadge('Luxoclean').initials).toBe('LC');
  });
  it('gives any other portal its initials', () => {
    expect(portalBadge('North Star Cleaning')).toMatchObject({ initials: 'NS' });
    expect(portalBadge('Zeta').initials).toBe('ZE');
  });
});
