import { ReactNode, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { l27 } from '../api';
import { todayISO } from '../format';

export interface Column<T> {
  header: string;
  render: (row: T) => ReactNode;
  className?: string;
}

interface Tab {
  label: string;
  // Path override (e.g. /v1/staff/customers/deleted) and/or extra params.
  path?: string;
  params?: Record<string, string>;
  // Some lists (e.g. /v1/staff/customers/deleted) have no /count endpoint.
  hasCount?: boolean;
}

interface Props<T> {
  title: string;
  // Launch27 list endpoint, e.g. /v1/staff/customers. Most have a sibling
  // `${path}/count` returning { count } that we use for paging.
  path: string;
  columns: Column<T>[];
  params?: Record<string, string | number | undefined>;
  tabs?: Tab[];
  // Name of the free-text search param, if the endpoint supports one (usually "query").
  searchParam?: string;
  hasCount?: boolean;
  pageSize?: number;
  rowKey?: (row: T) => string | number;
  onRowClick?: (row: T) => void;
  actions?: ReactNode;
  // Adds date inputs sent as from/to ("range") or a single `date` ("day").
  dates?: 'range' | 'day';
  defaultFrom?: string;
}

// Generic Launch27 list page: tabs, search, paging, table.
export function ResourceList<T extends { id?: number | string }>({
  title,
  path,
  columns,
  params = {},
  tabs,
  searchParam,
  hasCount = true,
  pageSize = 50,
  rowKey = (row) => row.id as number,
  onRowClick,
  actions,
  dates,
  defaultFrom,
}: Props<T>) {
  const [from, setFrom] = useState(defaultFrom || todayISO());
  const [to, setTo] = useState(todayISO());
  const [tabIndex, setTabIndex] = useState(0);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => setPage(0), [debounced, tabIndex, from, to, JSON.stringify(params)]);

  const tab = tabs?.[tabIndex];
  const listPath = tab?.path || path;
  const dateParams = dates === 'range' ? { from, to } : dates === 'day' ? { date: to } : {};
  const query = { ...params, ...dateParams, ...tab?.params, ...(searchParam ? { [searchParam]: debounced } : {}) };

  const rows = useQuery({
    queryKey: [listPath, query, page, pageSize],
    queryFn: () => l27<T[]>(listPath, { ...query, limit: pageSize, offset: page * pageSize }),
  });
  const count = useQuery({
    queryKey: [`${listPath}/count`, query],
    queryFn: () => l27<{ count: number }>(`${listPath}/count`, query),
    enabled: hasCount && tab?.hasCount !== false,
  });

  const total = hasCount && tab?.hasCount !== false ? count.data?.count : undefined;
  const lastPage = total !== undefined ? Math.max(0, Math.ceil(total / pageSize) - 1) : (rows.data?.length || 0) < pageSize ? page : page + 1;

  return (
    <>
      <header className="page-header">
        <h1>
          {title}
          {total !== undefined && <span className="muted count"> ({total.toLocaleString()})</span>}
        </h1>
        <div className="filters">
          {dates === 'range' && <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}
          {dates && <input type="date" value={to} min={dates === 'range' ? from : undefined} onChange={(e) => setTo(e.target.value)} />}
          {searchParam && <input placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} />}
          {actions}
        </div>
      </header>

      {tabs && (
        <div className="tabs">
          {tabs.map((t, i) => (
            <button key={t.label} className={i === tabIndex ? 'tab active' : 'tab'} onClick={() => setTabIndex(i)}>
              {t.label}
            </button>
          ))}
        </div>
      )}

      {rows.error && <div className="error">{(rows.error as Error).message}</div>}

      <div className="table-wrap cards-on-mobile">
        <table>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.header} className={c.className}>
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.isLoading && (
              <tr>
                <td colSpan={columns.length} className="muted">
                  Loading…
                </td>
              </tr>
            )}
            {rows.data?.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="muted">
                  Nothing here.
                </td>
              </tr>
            )}
            {rows.data?.map((row) => (
              <tr key={rowKey(row)} onClick={onRowClick ? () => onRowClick(row) : undefined} className={onRowClick ? '' : 'static'}>
                {columns.map((c) => (
                  <td key={c.header} className={c.className} data-label={c.header}>
                    {c.render(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {lastPage > 0 && (
        <div className="pager">
          <button disabled={page === 0} onClick={() => setPage(page - 1)}>
            ‹ Prev
          </button>
          <span className="muted small">
            Page {page + 1}
            {total !== undefined && ` of ${lastPage + 1}`}
          </span>
          <button disabled={page >= lastPage} onClick={() => setPage(page + 1)}>
            Next ›
          </button>
        </div>
      )}
    </>
  );
}
