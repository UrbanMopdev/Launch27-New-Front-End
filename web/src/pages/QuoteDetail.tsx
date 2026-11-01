import { Link, useLocation, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { l27, l27All } from '../api';
import type { Quote } from '../types';
import { CallButton } from '../components/CallButton';
import { Icon } from '../components/Icon';
import { useCanWrite, useLocations } from '../hooks';
import { fmtDateTime, fmtMoney } from '../format';
import { quoteStatus } from './Lists';

// Launch27 has no GET /v1/staff/quotes/:id (only the list the admin's /admin/quotes
// page uses), so the row clicked in QuotesPage is handed over via router state; a
// direct link re-fetches the list and finds the matching id in it.
interface Svc {
  id: number;
  name: string;
  price: number;
  extras: { id: number; name: string; price: number }[];
  pricing_parameters: { id: number; name: string; price: number }[];
}
interface Freq {
  id: number;
  name: string;
}
interface FormField {
  id: number;
  label: string;
  options?: { id: number; label: string }[];
}

export function QuoteDetailPage() {
  const { id } = useParams();
  const routerLocation = useLocation();
  const canWrite = useCanWrite();
  const stateQuote = (routerLocation.state as { quote?: Quote } | null)?.quote;

  const list = useQuery({
    queryKey: ['quotes', 'all'],
    queryFn: () => l27All<Quote>('/v1/staff/quotes'),
    enabled: !stateQuote,
  });
  const q = stateQuote || list.data?.find((x) => String(x.id) === id);

  const locations = useLocations();
  const bd = q?.booking_draft;
  const loc = bd?.location_id ?? locations.data?.[0]?.id ?? null;
  const services = useQuery({
    queryKey: ['booking-services', loc],
    queryFn: () => l27<Svc[]>('/v1/booking/services', { location_id: loc! }),
    enabled: !!loc,
  });
  const frequencies = useQuery({
    queryKey: ['booking-frequencies', loc],
    queryFn: () => l27<Freq[]>('/v1/booking/frequencies', { location_id: loc! }),
    enabled: !!loc,
  });
  const fields = useQuery({
    queryKey: ['booking-form-fields'],
    queryFn: () => l27<FormField[]>('/v1/staff/booking_form/custom_fields'),
    staleTime: 10 * 60_000,
  });

  if (!stateQuote && list.isLoading) return <div className="muted">Loading…</div>;
  if (!stateQuote && list.error) return <div className="error">{(list.error as Error).message}</div>;
  if (!q) {
    return (
      <div className="error">
        Quote not found. Open it from the <Link to="/quotes">quotes list</Link> — Launch27 has no direct link for a single quote.
      </div>
    );
  }

  const name = q.name || [q.first_name, q.last_name].filter(Boolean).join(' ') || [bd?.first_name, bd?.last_name].filter(Boolean).join(' ') || q.email || `Quote #${q.id}`;
  const status = quoteStatus(q.expires_at, q.booking_ids);
  const freq = frequencies.data?.find((f) => f.id === bd?.frequency_id);
  const serviceById = new Map((services.data || []).map((s) => [s.id, s]));
  const fieldById = new Map((fields.data || []).map((f) => [f.id, f]));
  const address = [bd?.address, bd?.city].filter(Boolean).join(', ');

  return (
    <div className="bk">
      <div className="crumbs small">
        <Link to="/quotes">Quotes</Link> / {name}
      </div>

      <section className="card bk-hero">
        <div className="bk-hero-top">
          <div className="grow bk-hero-main">
            <div className="c360-title">
              <span className="eyebrow">Quote #{q.id}</span>
              <span className={status.cls}>{status.label}</span>
            </div>
            <h1>{name}</h1>
            <p className="c360-summary">
              {[q.email, q.phone].filter(Boolean).join(' · ') || 'No contact info given'}
              {address && ` · ${address}`}
            </p>
          </div>
          <div className="c360-actions">
            {q.booking_ids?.length
              ? q.booking_ids.map((bid) => (
                  <Link key={bid} to={`/bookings/${bid}`} className="button">
                    Open booking #{bid}
                  </Link>
                ))
              : canWrite && (
                  <Link to="/bookings/new" state={{ quote: q }} className="button">
                    <Icon name="bolt" /> Create booking from this quote
                  </Link>
                )}
          </div>
        </div>
      </section>

      <div className="c360-cols">
        <div className="c360-main">
          <section className="card story bk-receipt">
            <div className="story-head">
              <h2>What they asked about</h2>
            </div>
            {!bd?.services?.length && <div className="muted">This quote has no service details.</div>}
            {bd?.services?.map((line) => {
              const svc = serviceById.get(line.id);
              const basePrice = svc ? (line.hourly ? svc.price * (line.hourly.minutes / 60) * line.hourly.quantity : svc.price) : undefined;
              return (
                <div key={line.id}>
                  <div className="rc-line main">
                    <span>
                      {svc?.name || `Service #${line.id}`}
                      {line.hourly ? ` · ${line.hourly.minutes / 60}h × ${line.hourly.quantity} cleaner${line.hourly.quantity === 1 ? '' : 's'}` : ''}
                    </span>
                    <span className="mono">{fmtMoney(basePrice)}</span>
                  </div>
                  {(line.pricing_parameters || [])
                    .filter((p) => p.quantity > 0)
                    .map((p) => {
                      const def = svc?.pricing_parameters.find((x) => x.id === p.id);
                      return (
                        <div key={p.id} className="rc-line">
                          <span>
                            {def?.name || `Item ${p.id}`} × {p.quantity}
                          </span>
                          <span className="mono">{def ? fmtMoney(def.price * p.quantity) : ''}</span>
                        </div>
                      );
                    })}
                  {(line.extras || [])
                    .filter((x) => x.quantity > 0)
                    .map((x) => {
                      const def = svc?.extras.find((e) => e.id === x.id);
                      return (
                        <div key={x.id} className="rc-line">
                          <span>
                            {def?.name || `Extra ${x.id}`}
                            {x.quantity > 1 ? ` × ${x.quantity}` : ''}
                          </span>
                          <span className="mono">{def ? fmtMoney(def.price * x.quantity) : ''}</span>
                        </div>
                      );
                    })}
                </div>
              );
            })}
            <div className="rc-sep" />
            <div className="rc-line total">
              <span>Quoted price</span>
              <span className="mono">{fmtMoney(bd?.final_price)}</span>
            </div>
            <div className="muted small">
              {freq?.name || 'No frequency given'}
              {bd?.discount_code && ` · code ${bd.discount_code.toUpperCase()}`}
              {bd?.arrival_window ? ` · ${bd.arrival_window}-minute arrival window` : ''}
            </div>
          </section>
        </div>

        <aside className="c360-side">
          <section className="card side-card">
            <h2>Contact</h2>
            <div className="muted small">{q.email || '—'}</div>
            {q.phone && (
              <div className="visit-actions grid2" style={{ borderTop: 0, paddingTop: 0 }}>
                <CallButton phone={q.phone} />
              </div>
            )}
          </section>

          <section className="card side-card access">
            <h2>Where</h2>
            {address ? (
              <div className="access-line">
                <Icon name="pin" />
                <span>
                  {address}{' '}
                  <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`} target="_blank" rel="noreferrer">
                    Map
                  </a>
                </span>
              </div>
            ) : (
              <div className="muted small">No address given.</div>
            )}
            {bd?.custom_fields
              ?.filter((cf) => cf.values?.length)
              .map((cf) => {
                const f = fieldById.get(cf.id);
                const labels = (cf.values || []).map((v) => f?.options?.find((o) => o.id === v.id)?.label || v.other).filter(Boolean);
                return (
                  <div key={cf.id} className="access-line">
                    <Icon name="key" />
                    <span>
                      <span className="muted">{f?.label?.replace(/\?$/, '') || `Question ${cf.id}`}:</span> {labels.join(', ') || '—'}
                    </span>
                  </div>
                );
              })}
          </section>

          <section className="card side-card">
            <h2>Details</h2>
            <dl className="kv2">
              <dt>Submitted</dt>
              <dd>
                {fmtDateTime(q.created_at)}
                {q.created_by?.name ? ` by ${q.created_by.name}` : ''}
              </dd>
              <dt>Expires</dt>
              <dd>{fmtDateTime(q.expires_at)}</dd>
              <dt>Payment method</dt>
              <dd>{bd?.payment_method || '—'}</dd>
            </dl>
          </section>
        </aside>
      </div>
    </div>
  );
}
