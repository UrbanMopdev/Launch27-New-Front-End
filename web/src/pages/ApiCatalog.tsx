import { useState } from 'react';
import catalog from '../../../docs/api-catalog.json';

interface Endpoint {
  method: string;
  endpoint: string;
  statuses: number[];
  pages: string[];
  query: Record<string, string[]>;
  blocked: boolean;
  requestShape?: unknown;
  responseShape?: unknown;
}

interface Catalog {
  generatedAt: string | null;
  pages: { template: string; heading: string | null; requests: string[] }[];
  endpoints: Endpoint[];
}

// Browse what `npm run capture` recorded from the Launch27 admin portal:
// which endpoints each admin page calls, and the shape of each response.
export function ApiCatalogPage() {
  const data = catalog as Catalog;
  const [filter, setFilter] = useState('');
  const q = filter.toLowerCase();

  if (!data.generatedAt) {
    return (
      <>
        <h1>API catalog</h1>
        <p className="muted">
          Nothing captured yet. Run <code>npm run capture</code> to crawl the Launch27 admin portal and record its API calls.
        </p>
      </>
    );
  }

  const endpoints = data.endpoints.filter((e) => `${e.method} ${e.endpoint} ${e.pages.join(' ')}`.toLowerCase().includes(q));

  return (
    <>
      <header className="page-header">
        <h1>API catalog</h1>
        <input placeholder="Filter endpoints or pages…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </header>
      <p className="muted small">
        Captured {new Date(data.generatedAt).toLocaleString()} · {data.pages.length} pages · {data.endpoints.length} endpoints
      </p>
      {endpoints.map((e) => (
        <details key={`${e.method} ${e.endpoint}`} className="card endpoint">
          <summary>
            <span className={`method ${e.method.toLowerCase()}`}>{e.method}</span> <code>{e.endpoint}</code>
            {e.blocked && <span className="badge">write</span>}
          </summary>
          <p className="small">Pages: {e.pages.join(', ')}</p>
          {Object.keys(e.query).length > 0 && (
            <p className="small">
              Query: {Object.entries(e.query).map(([k, v]) => `${k} (${v.join(', ')})`).join('; ')}
            </p>
          )}
          {e.requestShape != null && <pre>{JSON.stringify(e.requestShape, null, 2)}</pre>}
          {e.responseShape != null && <pre>{JSON.stringify(e.responseShape, null, 2)}</pre>}
        </details>
      ))}
    </>
  );
}
