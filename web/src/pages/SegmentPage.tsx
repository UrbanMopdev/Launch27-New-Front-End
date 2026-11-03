import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CallButton } from '../components/CallButton';
import { useInboxMe } from '../inbox/util';
import { segmentsApi, type Outcome, type SegmentId, type SegmentRow, type SegmentSettings } from '../segments/api';
import { OUTCOME_LABEL, SEGMENT_HELP, SEGMENT_LABEL, SegmentPill, TraitTag, UpdatedLine, money, shortDate } from '../segments/ui';
import { Pager } from './Customers';

const PAGE = 50;
const HEADLINE: Partial<Record<SegmentId, (n: number) => string>> = {
  risk: (n) => `${n} plan customer${n === 1 ? ' has' : 's have'} nothing booked next`,
  repeat: (n) => `${n} one-time customer${n === 1 ? ' keeps' : 's keep'} coming back`,
  first: (n) => `${n} first-time customer${n === 1 ? '' : 's'}`,
  recurring: (n) => `${n} customer${n === 1 ? '' : 's'} on a plan`,
};
const OUTCOMES: Outcome[] = ['rebooked', 'pause', 'price', 'quality', 'cleaner', 'moved', 'no_answer', 'other'];

export function SegmentPage() {
  const { segment = 'risk' } = useParams();
  const seg = segment as SegmentId;
  const [page, setPage] = useState(0);
  const me = useInboxMe();
  const summary = useQuery({ queryKey: ['segments', 'summary'], queryFn: segmentsApi.summary });
  const stats = useQuery({ queryKey: ['segments', 'stats', seg], queryFn: () => segmentsApi.stats(seg) });
  const list = useQuery({ queryKey: ['segments', 'customers', seg, '', '', page], queryFn: () => segmentsApi.customers({ segment: seg, limit: PAGE, offset: page * PAGE }), placeholderData: (prev) => prev });
  const s = summary.data;
  const st = stats.data;
  const n = st?.customers ?? 0;
  if (!SEGMENT_LABEL[seg] || seg === ('new' as SegmentId)) return <div className="error">Unknown segment</div>;

  return (
    <div className="seg-page">
      <nav className="small muted"><Link to="/customers">Customers</Link> / {SEGMENT_LABEL[seg]}</nav>
      <header className="page-header seg-work-head">
        <div className="seg-head">
          <SegmentPill segment={seg} />
          <h1>{HEADLINE[seg]?.(n) ?? `${n} ${SEGMENT_LABEL[seg].toLowerCase()} customers`}</h1>
          {st && s && (
            <p className="muted">
              {SEGMENT_HELP[seg](s.settings)} They spent {money(st.revenue_12m)} with us in the last 12 months.
              {seg === 'risk' && ` Each one moves to Lapsed recurring ${s.settings.risk_days} days after their last clean, so the list is sorted by days left.`}
            </p>
          )}
          <UpdatedLine summary={s} />
        </div>
      </header>

      {st && (
        <div className="seg-stats">
          {seg === 'risk' && <Stat label="Moving to lapsed this week" value={String(st.lapsing_this_week ?? 0)} />}
          <Stat label="Not contacted yet" value={String(st.not_contacted)} />
          <Stat label="Moved onto a plan this month" value={String(st.saved_this_month)} accent />
          <Stat label="Top reason given (90 days)" value={st.top_reason ? OUTCOME_LABEL[st.top_reason] : '—'} small={!st.top_reason} />
        </div>
      )}

      <div className="seg-work">
        <section className="seg-work-list">
          {list.data?.rows.map((r) => <WorkCard key={r.customer_id} row={r} segment={seg} />)}
          {list.data && list.data.rows.length === 0 && <div className="card muted">Nobody here right now.</div>}
          <Pager total={list.data?.total ?? 0} page={page} setPage={setPage} />
        </section>
        <aside className="seg-work-side">
          {s && <SegmentSettingsCard settings={s.settings} canEdit={me.data?.role === 'admin'} />}
        </aside>
      </div>
    </div>
  );
}

function Stat({ label, value, accent, small }: { label: string; value: string; accent?: boolean; small?: boolean }) {
  return (
    <div className="card seg-stat">
      <span className="muted small">{label}</span>
      <span className={`seg-stat-value${accent ? ' accent' : ''}${small ? ' small' : ''}`}>{value}</span>
    </div>
  );
}

function WorkCard({ row: r, segment }: { row: SegmentRow; segment: SegmentId }) {
  const queryClient = useQueryClient();
  const [logging, setLogging] = useState(false);
  const log = useMutation({
    mutationFn: (body: { outcome: Outcome; snooze_days?: number }) => segmentsApi.logOutcome(r.customer_id, body),
    onSuccess: () => {
      setLogging(false);
      queryClient.invalidateQueries({ queryKey: ['segments'] });
    },
  });
  const snoozed = r.snoozed_until && r.snoozed_until > new Date().toISOString().slice(0, 10);
  return (
    <article className={snoozed ? 'card seg-work-card snoozed' : 'card seg-work-card'}>
      <div className="seg-work-top">
        <div>
          <Link to={`/customers/${r.customer_id}`} className="seg-name big">{r.name || `#${r.customer_id}`}</Link>
          <div className="muted small">{[r.plan, r.city, `${money(r.spend_12m)} in 12 months`].filter(Boolean).join(' · ')}</div>
          {r.traits.length > 0 && <div className="seg-trait-row">{r.traits.map((t) => <TraitTag key={t} trait={t} />)}</div>}
        </div>
        <div className="seg-work-when">
          {segment === 'risk' && r.days_left !== null && <span className={r.days_left <= 7 ? 'seg-days urgent' : 'seg-days'}>{r.days_left} days left</span>}
          <span className="muted small">Last clean {shortDate(r.last_clean)}{r.next_clean ? ` · next ${shortDate(r.next_clean)}` : ''}</span>
        </div>
      </div>
      <p className="seg-suggest">{r.suggestion}</p>
      {r.last_outcome && (
        <p className="muted small">
          Last outcome: {OUTCOME_LABEL[r.last_outcome]}
          {r.last_outcome_at && ` · ${new Date(r.last_outcome_at).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })}`}
          {snoozed && ` · snoozed until ${shortDate(r.snoozed_until)}`}
        </p>
      )}
      <div className="seg-work-actions">
        <CallButton phone={r.phone} className="primary" />
        <Link className="button secondary-link" to={`/bookings/new?customer=${r.customer_id}`}>Book next visit</Link>
        <button className="secondary" onClick={() => setLogging(!logging)} aria-expanded={logging}>Log outcome</button>
        <button className="link" disabled={log.isPending} onClick={() => log.mutate({ outcome: 'snoozed', snooze_days: 7 })}>Snooze 7 days</button>
      </div>
      {logging && (
        <div className="seg-outcomes" role="group" aria-label="Outcome">
          {OUTCOMES.map((o) => (
            <button key={o} className="chip-btn" disabled={log.isPending} onClick={() => log.mutate({ outcome: o })}>{OUTCOME_LABEL[o]}</button>
          ))}
        </div>
      )}
      {log.isError && <div className="error small">{(log.error as Error).message}</div>}
    </article>
  );
}

function SegmentSettingsCard({ settings, canEdit }: { settings: SegmentSettings; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<SegmentSettings>(settings);
  const save = useMutation({ mutationFn: () => segmentsApi.saveSettings(draft), onSuccess: () => queryClient.invalidateQueries({ queryKey: ['segments'] }) });
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);
  const field = (key: keyof SegmentSettings, label: string) => (
    <label className="seg-setting">
      <span>{label}</span>
      <span><input type="number" min={7} max={730} value={draft[key]} disabled={!canEdit} onChange={(e) => setDraft({ ...draft, [key]: Number(e.target.value) })} className="num-input" /> days</span>
    </label>
  );
  return (
    <section className="card seg-settings">
      <h2>Segment settings</h2>
      {field('risk_days', 'At risk becomes lapsed after')}
      {field('first_days', 'First-time becomes lapsed after')}
      {field('repeat_days', 'Repeat one-time becomes lapsed after')}
      {field('new_plan_days', '"New on a plan" lasts')}
      {canEdit ? (
        <div className="seg-settings-actions">
          <button disabled={!dirty || save.isPending} onClick={() => save.mutate()}>Save</button>
          <span className="muted small">Applies at the next update.</span>
        </div>
      ) : (
        <span className="muted small">Admins can change these.</span>
      )}
      {save.isError && <div className="error small">{(save.error as Error).message}</div>}
    </section>
  );
}
