// All Launch27 calls go through our server at /l27/..., which attaches the
// user's bearer token. Paths after /l27 are Launch27's own paths.

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', ...init });
  if (res.status === 401 && !path.startsWith('/auth/')) {
    window.dispatchEvent(new Event('l27:logged-out'));
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error || body.message || `${res.status} ${res.statusText}`);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

export function l27<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== '') query.set(k, String(v));
  const qs = query.toString();
  return request<T>(`/l27${path}${qs ? `?${qs}` : ''}`);
}

// Launch27 list endpoints page with limit/offset and return a bare array;
// a short page means it was the last one (same rule as the check-in tracker).
export async function l27All<T>(path: string, params: Record<string, string | number | undefined> = {}, pageSize = 100): Promise<T[]> {
  const all: T[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await l27<T[]>(path, { ...params, limit: pageSize, offset });
    all.push(...page);
    if (page.length < pageSize) return all;
  }
}

export const auth = {
  me: () => request<{ email: string; allowWrites: boolean }>('/auth/me'),
  login: (email: string, password: string) =>
    request<{ email: string }>('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }),
  logout: () => request<void>('/auth/logout', { method: 'POST' }),
};
