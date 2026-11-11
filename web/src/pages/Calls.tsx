import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { TIMEZONE } from '../format';
import { CallButton } from '../components/CallButton';
import { inbox, type CallLogRow } from '../inbox/api';
import { ago, displayIdentity, useInboxMe } from '../inbox/util';

// Calls log: every call the portal logged (answered, missed, voicemail, outbound), and the
// missed calls still waiting for a callback, one row per caller (requirements W-5, W-6,
// V-2 to V-4). A missed call counts as handled once someone calls the person back and
// reaches them, or they call again and get an answer.

type View = 'waiting' | 'all' | 'missed' | 'answered' | 'outbound';
const VIEWS: { id: View; label: string }[] = [
  { id: 'waiting', label: 'Waiting for a callback' },
  { id: 'all', label: 'All calls' },
  { id: 'missed', label: 'Missed' },
  { id: 'answered', label: 'Answered' },
  { id: 'outbound', label: 'Outbound' },
];
const RANGES = [
  { days: 1, label: 'Today' },
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
];

const RESULT: Record<string, string> = { answered: 'Answered', missed: 'Missed', voicemail: 'Voicemail', no_answer: 'No answer' };
const CALLBACK: Record<string, string> = { open: 'Not called back', tried: 'Tried, no answer', called_back: 'Called back' };
const dayOf = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: TIMEZONE });
const when = (iso: string) => new Date(iso).toLocaleString('en-CA', { timeZone: TIMEZONE, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const mins = (s: number | null) => (s == null ? '—' : s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`);
const isMissed = (r: CallLogRow) => r.direction === 'in' && (r.result === 'missed' || r.result === 'voicemail');
const theirNumber = (r: CallLogRow) => (r.direction === 'in' ? r.from_addr : r.to_addr) || '';

function pageOf(r: CallLogRow) {
  if (r.l27_team_id) return `/cleaners/${r.l27_team_id}`;
  if (r.l27_customer_id) return `/customers/${r.l27_customer_id}`;
  return r.contact_id ? `/contacts/${r.contact_id}` : null;
}
function typeOf(r: CallLogRow) {
  if (r.caller_flag === 'spam') return 'Spam';
  if (r.caller_flag === 'wrong_number') return 'Wrong number';
  if (r.l27_team_id) return 'Cleaner';
  if (r.l27_customer_id) return 'Customer';
  if (r.contact_roles?.includes('applicant')) return 'Applicant';
  if (r.lead_stage) return 'Lead';
  return r.contact_name ? 'Contact' : 'Unknown';
}

function Caller({ r }: { r: CallLogRow }) {
  const path = pageOf(r);
  const label = r.contact_name || displayIdentity(theirNumber(r)) || 'Unknown';
  return (
    <>
      {path ? <Link to={path}>{label}</Link> : label} <span className="role-badge">{typeOf(r)}</span>
      {r.contact_name && <div className="muted small">{displayIdentity(theirNumber(r))}</div>}
    </>
  );
}

export function CallsPage() {
  const [view, setView] = useState<View>('waiting');
  const [days, setDays] = useState(7);
  const [agent, setAgent] = useState('');
  const me = useInboxMe();
  const canHear = me.data?.role === 'admin' || me.data?.role === 'supervisor'; // P-2
  const log = useQuery({ queryKey: ['inbox', 'calls', days], queryFn: () => inbox.callLog(Math.max(days, 1)), refetchInterval: 30_000 });

  const today = dayOf(new Date().toISOString());
  const rows = useMemo(() => (log.data?.rows || []).filter((r) => (days === 1 ? dayOf(r.created_at) === today : true)), [log.data, days, today]);
  const agents = useMemo(() => [...new Map(rows.filter((r) => r.agent_id).map((r) => [String(r.agent_id), r.agent_name || 'Agent'])).entries()], [rows]);
  const byAgent = agent ? rows.filter((r) => String(r.agent_id) === agent) : rows;

  // Missed calls still waiting: one row per caller, with how many times they tried (V-2).
  const waiting = useMemo(() => {
    const groups = new Map<string, { latest: CallLogRow; times: number; voicemail: boolean; tried: boolean }>();
    for (const r of rows) {
      // Spam and wrong numbers don't need a callback.
      if (!isMissed(r) || r.callback === 'called_back' || r.caller_flag || (!r.contact_id && !theirNumber(r))) continue;
      const k = r.contact_id ? `c${r.contact_id}` : theirNumber(r);
      const g = groups.get(k);
      if (g) {
        g.times++;
        g.voicemail ||= r.result === 'voicemail';
        g.tried ||= r.callback === 'tried';
      } else groups.set(k, { latest: r, times: 1, voicemail: r.result === 'voicemail', tried: r.callback === 'tried' });
    }
    // Voicemail first (V-3), then the oldest wait.
    return [...groups.values()].sort((a, b) => Number(b.voicemail) - Number(a.voicemail) || a.latest.created_at.localeCompare(b.latest.created_at));
  }, [rows]);

  const shown = byAgent.filter((r) => (view === 'missed' ? isMissed(r) : view === 'answered' ? r.result === 'answered' : view === 'outbound' ? r.direction === 'out' : true));
  const answered = rows.filter((r) => r.result === 'answered');
  const talk = answered.filter((r) => r.duration_seconds != null);
  const avg = talk.length ? Math.round(talk.reduce((a, r) => a + (r.duration_seconds || 0), 0) / talk.length) : null;

  return (
    <>
      <header className="page-header">
        <h1>Calls</h1>
        <div className="actions">
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Period">
            {RANGES.map((r) => (
              <option key={r.days} value={r.days}>{r.label}</option>
            ))}
          </select>
          {view !== 'waiting' && (
            <select value={agent} onChange={(e) => setAgent(e.target.value)} aria-label="Agent">
              <option value="">Every agent</option>
              {agents.map(([id, name]) => (
                <option key={id} value={id}>{name}</option>
              ))}
            </select>
          )}
        </div>
      </header>
      <p className="muted small">Calls taken or missed in the portal's phone. Calls answered on a desk phone or the RingCentral app aren't here yet.</p>

      <div className="tiles">
        <Tile label="Calls" value={String(rows.length)} sub={`${rows.filter((r) => r.direction === 'in').length} in · ${rows.filter((r) => r.direction === 'out').length} out`} />
        <Tile label="Answered" value={String(answered.length)} sub={avg != null ? `${mins(avg)} average` : undefined} />
        <Tile label="Missed" value={String(rows.filter(isMissed).length)} sub={`${rows.filter((r) => r.result === 'voicemail').length} left a voicemail`} />
        <Tile label="Waiting for a callback" value={String(waiting.length)} tone={waiting.length ? 'neg' : 'ok'} sub={waiting.length ? 'callers not reached yet' : 'everyone was reached'} />
      </div>

      <div className="tabs">
        {VIEWS.map((v) => (
          <button key={v.id} className={v.id === view ? 'tab active' : 'tab'} onClick={() => setView(v.id)}>
            {v.label}
            {v.id === 'waiting' && waiting.length ? ` (${waiting.length})` : ''}
          </button>
        ))}
      </div>

      {log.isLoading && <div className="muted">Loading calls…</div>}
      {log.error && <div className="error">{(log.error as Error).message}</div>}

      {log.data && view === 'waiting' && (
        waiting.length ? (
          <div className="card no-pad">
            <table>
              <thead>
                <tr>
                  <th>Caller</th>
                  <th>Called</th>
                  <th>Last call</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {waiting.map((g) => (
                  <tr key={g.latest.id}>
                    <td><Caller r={g.latest} /></td>
                    <td>{g.times === 1 ? 'Once' : `${g.times} times`}{g.voicemail && <div className="small warn">Left a voicemail</div>}</td>
                    <td>{when(g.latest.created_at)}<div className="muted small">{ago(g.latest.created_at)} ago</div></td>
                    <td>{g.tried ? 'Tried, no answer' : 'Not called back'}</td>
                    <td className="actions">
                      <CallButton phone={theirNumber(g.latest)} label="Call back" />
                      <Link to={`/inbox/${g.latest.conversation_id}`} className="button secondary-link">Conversation</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">No one is waiting for a callback{days === 1 ? ' today' : ''}.</p>
        )
      )}

      {log.data && view !== 'waiting' && (
        shown.length ? (
          <div className="card no-pad">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Caller</th>
                  <th />
                  <th>Result</th>
                  <th>Talk time</th>
                  <th>Agent</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.id}>
                    <td className="nowrap">{when(r.created_at)}</td>
                    <td><Caller r={r} /></td>
                    <td className="muted small">{r.direction === 'in' ? 'Incoming' : 'Outgoing'}</td>
                    <td>
                      <span className={isMissed(r) ? 'neg' : ''}>{RESULT[r.result] || r.result}</span>
                      {isMissed(r) && r.callback && <div className={`small ${r.callback === 'called_back' ? 'muted' : 'warn'}`}>{CALLBACK[r.callback]}</div>}
                    </td>
                    <td>{r.result === 'answered' ? mins(r.duration_seconds) : '—'}</td>
                    <td>{!r.agent_name ? <span className="muted">—</span> : isMissed(r) ? <span className="muted">Rang {r.agent_name}</span> : r.agent_name}</td>
                    <td className="actions">
                      {r.recording_url && canHear && <a href={r.recording_url} target="_blank" rel="noreferrer" className="small">Recording</a>}
                      {r.recording_url && !canHear && <span className="muted small">Recorded</span>}
                      <Link to={`/inbox/${r.conversation_id}`} className="small">Conversation</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">No calls in this period.</p>
        )
      )}
    </>
  );
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'ok' | 'neg' }) {
  return (
    <div className="card tile">
      <div className="muted small">{label}</div>
      <div className={`tile-value ${tone || ''}`}>{value}</div>
      {sub && <div className="muted small">{sub}</div>}
    </div>
  );
}
