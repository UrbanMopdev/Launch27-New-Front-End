// Client for /api/brands on our own server.
import { ApiError, describeErrors } from '../api';
import type { BrandSlug } from './rules';

export interface BrandInfo { slug: BrandSlug; name: string; color: string; signature: string | null }
export interface BrandPerson { id: number; email: string; name: string | null; role: string; brand: BrandSlug | null }
export interface BrandsData { brands: BrandInfo[]; overrides: Record<string, BrandSlug | null>; me: { id: number; brand: BrandSlug | null }; people: BrandPerson[] }

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) window.dispatchEvent(new Event('l27:logged-out'));
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, describeErrors(data) || `${res.status} ${res.statusText}`, data);
  }
  return res.json();
}

export const brandsApi = {
  get: () => call<BrandsData>('GET', '/brands'),
  setLocation: (id: number, name: string, brand: BrandSlug | null) => call('PUT', `/brands/locations/${id}`, { brand, name }),
  setPerson: (id: number, brand: BrandSlug | null) => call('PUT', `/brands/people/${id}`, { brand }),
};
