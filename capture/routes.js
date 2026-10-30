// Shared helpers for turning concrete URLs into templates, so /admin/bookings/123
// and /admin/bookings/456 count as one page and one endpoint.

const ID_SEGMENT = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|\d{4}-\d{2}-\d{2})$/i;

export function templatePath(pathname) {
  return pathname
    .split('/')
    .map((segment) => {
      if (!ID_SEGMENT.test(segment)) return segment;
      return /^\d{4}-\d{2}-\d{2}$/.test(segment) ? ':date' : ':id';
    })
    .join('/');
}

// Page identity: path plus hash route (older Angular admin panels route on #/...).
export function pageTemplate(url) {
  const u = new URL(url);
  const hash = u.hash.replace(/^#!?/, '').split('?')[0];
  return templatePath(u.pathname) + (hash ? `#${templatePath(hash)}` : '');
}

export function endpointTemplate(url) {
  const u = new URL(url);
  return `${u.host}${templatePath(u.pathname)}`;
}

const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
const PHONE = /\+?\d[\d\s().-]{8,}\d/g;

export function redact(value) {
  return String(value).replace(EMAIL, '<email>').replace(PHONE, '<phone>');
}
