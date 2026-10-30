// All Launch27 calls go through our server at /l27/..., which attaches the
// user's bearer token. Paths after /l27 are Launch27's own paths.

export class ApiError extends Error {
  constructor(public status: number, message: string, public fields?: Record<string, unknown>) {
    super(message);
  }
}

// Launch27 validation errors look like
//   {"custom_field":[{"type":"invalid","message":"value required: id 267"}]}
// Flatten them into readable lines.
export function describeErrors(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const lines: string[] = [];
  for (const [field, value] of Object.entries(body as Record<string, unknown>)) {
    if (field === 'error' || field === 'message') {
      lines.push(String(value));
    } else if (Array.isArray(value)) {
      for (const item of value) lines.push(`${field}: ${(item as { message?: string })?.message ?? JSON.stringify(item)}`);
    }
  }
  return [...new Set(lines)].join('\n');
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', ...init });
  if (res.status === 401 && !path.startsWith('/auth/')) {
    window.dispatchEvent(new Event('l27:logged-out'));
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, describeErrors(body) || `${res.status} ${res.statusText}`, body);
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

// Writes go through the same proxy; the server rejects them unless L27_ALLOW_WRITES=true.
export function l27Write<T>(method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  return request<T>(`/l27${path}`, {
    method,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
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
