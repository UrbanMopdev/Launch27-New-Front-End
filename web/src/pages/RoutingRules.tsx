// Routing rules, built with menus and chips instead of JSON. Rules are checked top to
// bottom; the first match decides the queue, reply target and priority.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { inbox, type Channel, type Role, type Rule } from '../inbox/api';
import { useMeta } from '../inbox/util';
import { PillPicker, SaveBar, Switch, TagInput, useLeaveWarning } from '../inbox/settingsUi';
import {
  CHANNEL_OPTIONS,
  FIELDS,
  FIELD_ORDER,
  LEAD_STAGES,
  PRIORITY_OPTIONS,
  ROLE_OPTIONS,
  describeAction,
  describeConditions,
  formatMinutes,
  fromForm,
  newRuleIndex,
  ruleProblems,
  toForm,
  type ConditionField,
  type ConditionRow,
  type RuleForm,
} from '../lib/routingRules';

type Draft = Rule & { key: string };
let nextKey = 1;
const withKey = (r: Rule): Draft => ({ ...r, key: `r${nextKey++}` });
const strip = ({ key: _key, ...r }: Draft): Rule => r;

interface Options {
  queues: { slug: string; name: string; restricted: boolean }[];
  slas: { slug: string; name: string; first_response_minutes: number }[];
  addresses: { value: string; label: string }[];
  dispositions: { audience: string[]; reason: string[]; outcome: string[] };
}

export function RulesEditor({ canEdit, onDirtyChange }: { canEdit: boolean; onDirtyChange?: (dirty: boolean) => void }) {
  const queryClient = useQueryClient();
  const data = useQuery({ queryKey: ['inbox', 'rules'], queryFn: inbox.rules });
  const wf = useQuery({ queryKey: ['inbox', 'workforce'], queryFn: inbox.workforce });
  const meta = useMeta();
  const [draft, setDraft] = useState<Draft[] | null>(null);
  const [saved, setSaved] = useState<Draft[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [hit, setHit] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  // Keep keys stable between the saved list and the draft so open editors survive.
  useEffect(() => {
    const rules = data.data?.rules;
    if (rules) setSaved((prev) => rules.map((r, i) => (prev[i] && prev[i].name === r.name ? { ...r, key: prev[i].key } : withKey(r))));
  }, [data.data]);

  const list = draft || saved;
  const dirty = !!draft;
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);
  useLeaveWarning(dirty);

  const opts: Options = useMemo(
    () => ({
      queues: (wf.data?.queues || []).map((q) => ({ slug: q.slug, name: q.name, restricted: q.restricted })),
      slas: meta.data?.sla_policies || [],
      addresses: [
        ...(meta.data?.identities.email || []).map((v) => ({ value: v, label: v })),
        ...(meta.data?.identities.sms || []).map((v) => ({ value: v, label: `${formatPhone(v)} (text)` })),
      ],
      dispositions: meta.data?.dispositions || { audience: [], reason: [], outcome: [] },
    }),
    [wf.data, meta.data],
  );
  const lookups = {
    queueName: (slug: string) => opts.queues.find((q) => q.slug === slug)?.name || slug,
    slaName: (slug: string) => {
      const p = opts.slas.find((s) => s.slug === slug);
      return p ? `${p.name} (${formatMinutes(p.first_response_minutes)})` : slug;
    },
  };
  const problems = ruleProblems(list);
  const blocking = list.some((r) => !r.name.trim()) ? 'Every rule needs a name before you can save.' : null;

  const change = (next: Draft[]) => {
    setDraft(next);
    setHit(null);
    setJustSaved(false);
  };
  const update = (key: string, patch: Partial<Rule>) => change(list.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const moveTo = (from: number, to: number) => {
    if (from === to || to < 0 || to >= list.length) return;
    const next = [...list];
    const [r] = next.splice(from, 1);
    next.splice(to, 0, r);
    change(next);
  };
  const add = () => {
    const r = withKey({ name: '', enabled: true, conditions: {}, action: { queue: 'operations' } });
    const next = [...list];
    next.splice(newRuleIndex(list), 0, r);
    change(next);
    setOpen(r.key);
    setFilter('');
    setTimeout(() => document.getElementById(`rule-${r.key}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  };
  const duplicate = (i: number) => {
    const r = withKey({ ...strip(list[i]), id: undefined, name: `${list[i].name} (copy)`, replaces: null });
    const next = [...list];
    next.splice(i + 1, 0, r);
    change(next);
    setOpen(r.key);
  };
  const remove = (i: number) => {
    if (!window.confirm(`Delete the rule “${list[i].name || 'Untitled'}”? Nothing changes until you save.`)) return;
    change(list.filter((_, j) => j !== i));
  };

  const save = useMutation({
    mutationFn: () => inbox.saveRules(list.map(strip)),
    onSuccess: (res) => {
      // Saved rows come back with new ids; keep each row's key so open editors stay open.
      setSaved(res.rules.map((r, i) => ({ ...r, key: list[i]?.key ?? `r${nextKey++}` })));
      setDraft(null);
      setJustSaved(true);
      queryClient.setQueryData(['inbox', 'rules'], res);
    },
  });

  if (data.isLoading || wf.isLoading) return <div className="muted">Loading…</div>;
  if (data.error) return <div className="error">{(data.error as Error).message}</div>;

  const q = filter.trim().toLowerCase();
  const visible = (r: Draft) =>
    !q ||
    r.name.toLowerCase().includes(q) ||
    describeConditions(r.conditions).join(' ').toLowerCase().includes(q) ||
    describeAction(r.action, lookups).toLowerCase().includes(q);
  const shown = list.filter(visible).length;

  return (
    <div className="rules">
      <div className="ws-intro rules-intro">
        <div>
          <p className="muted small">
            Each new conversation is checked against these rules <b>from top to bottom</b>. The first rule that matches decides where it goes; anything that matches none goes to <b>Fallback</b>. {canEdit ? 'Drag rules (or use the arrows) to change the order.' : ''}
          </p>
          {justSaved && <span className="ok small">Saved. New conversations now use these rules.</span>}
        </div>
        <div className="actions">
          <input className="rules-search" type="search" placeholder="Find a rule…" aria-label="Find a rule" value={filter} onChange={(e) => setFilter(e.target.value)} />
          {canEdit && <button type="button" onClick={add}>+ New rule</button>}
        </div>
      </div>

      <RuleTester rules={list} onHit={setHit} lookups={lookups} opts={opts} />

      <ol className="rule-list" aria-label="Routing rules in order">
        {list.map((r, i) => {
          if (!visible(r)) return null;
          const isOpen = open === r.key;
          const p = problems.get(i) || [];
          const cls = ['rule-card', !r.enabled && 'off', isOpen && 'open', hit === r.key && 'hit', overKey === r.key && dragKey !== r.key && 'drop-target', dragKey === r.key && 'dragging'].filter(Boolean).join(' ');
          return (
            <li
              key={r.key}
              id={`rule-${r.key}`}
              className={cls}
              draggable={canEdit && !isOpen && !q}
              onDragStart={(e) => {
                setDragKey(r.key);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(e) => {
                if (!dragKey) return;
                e.preventDefault();
                setOverKey(r.key);
              }}
              onDrop={(e) => {
                e.preventDefault();
                const from = list.findIndex((x) => x.key === dragKey);
                moveTo(from, i);
                setDragKey(null);
                setOverKey(null);
              }}
              onDragEnd={() => {
                setDragKey(null);
                setOverKey(null);
              }}
            >
              <div className="rule-card-head">
                {canEdit && !q && <span className="drag-handle" aria-hidden="true" title="Drag to reorder">⋮⋮</span>}
                <span className="rule-num" aria-label={`Rule ${i + 1}`}>{i + 1}</span>
                <div className="rule-main">
                  <div className="rule-title">
                    <b>{r.name || <span className="muted">Untitled rule</span>}</b>
                    {!r.enabled && <span className="chip">Off</span>}
                    {hit === r.key && <span className="chip ok">Test message matches this rule</span>}
                  </div>
                  <RuleSentence rule={r} lookups={lookups} />
                  {p.map((m) => <div key={m} className="rule-problem small">⚠ {m}</div>)}
                </div>
                <div className="rule-tools">
                  {canEdit && <Switch label={r.enabled ? 'Rule is on' : 'Rule is off'} checked={r.enabled} onChange={(v) => update(r.key, { enabled: v })} />}
                  {canEdit ? (
                    <button type="button" className="secondary small-btn" onClick={() => setOpen(isOpen ? null : r.key)} aria-expanded={isOpen}>
                      {isOpen ? 'Close' : 'Edit'}
                    </button>
                  ) : (
                    <button type="button" className="link small" onClick={() => setOpen(isOpen ? null : r.key)} aria-expanded={isOpen}>{isOpen ? 'Hide details' : 'Details'}</button>
                  )}
                </div>
              </div>
              {isOpen && (
                <RuleEditor
                  key={r.key}
                  rule={r}
                  opts={opts}
                  canEdit={canEdit}
                  existingStages={list.flatMap((x) => (Array.isArray(x.conditions.lead_stage) ? (x.conditions.lead_stage as string[]) : []))}
                  onChange={(patch) => update(r.key, patch)}
                  footer={
                    canEdit && (
                      <div className="actions rule-editor-foot">
                        <button type="button" className="link small" disabled={i === 0} onClick={() => moveTo(i, i - 1)}>↑ Move up</button>
                        <button type="button" className="link small" disabled={i === list.length - 1} onClick={() => moveTo(i, i + 1)}>↓ Move down</button>
                        <button type="button" className="link small" onClick={() => duplicate(i)}>Duplicate</button>
                        <button type="button" className="link small danger-link" onClick={() => remove(i)}>Delete rule</button>
                        <span className="grow" />
                        <button type="button" className="secondary" onClick={() => setOpen(null)}>Done</button>
                      </div>
                    )
                  }
                />
              )}
            </li>
          );
        })}
        {!q && (
          <li className={hit === 'fallback' ? 'rule-card fallback hit' : 'rule-card fallback'}>
            <div className="rule-card-head">
              <span className="rule-num" aria-hidden="true">∞</span>
              <div className="rule-main">
                <div className="rule-title"><b>Everything else</b>{hit === 'fallback' && <span className="chip ok">Test message ends up here</span>}</div>
                <div className="rule-sentence small"><span className="kw">Then</span> send to Fallback. Someone should check it daily.</div>
              </div>
            </div>
          </li>
        )}
      </ol>
      {q && !shown && <p className="muted small">No rules match “{filter}”.</p>}

      {canEdit && (
        <SaveBar
          show={dirty}
          saving={save.isPending}
          blocked={blocking}
          error={save.error ? (save.error as Error).message : null}
          onSave={() => save.mutate()}
          onDiscard={() => {
            setDraft(null);
            save.reset();
            setOpen(null);
          }}
        />
      )}
    </div>
  );
}

function RuleSentence({ rule, lookups }: { rule: Rule; lookups: Parameters<typeof describeAction>[1] }) {
  const conds = describeConditions(rule.conditions);
  return (
    <div className="rule-sentence small">
      <div>
        <span className="kw">When</span> {conds.length ? conds.map((c, i) => <span key={i}>{i > 0 && <span className="kw-and"> and </span>}{c}</span>) : <i>any message (no conditions)</i>}
      </div>
      <div><span className="kw">Then</span> {describeAction(rule.action, lookups)}</div>
    </div>
  );
}

// ---------- one rule ----------

function RuleEditor({ rule, opts, canEdit, existingStages, onChange, footer }: { rule: Rule; opts: Options; canEdit: boolean; existingStages: string[]; onChange: (patch: Partial<Rule>) => void; footer: ReactNode }) {
  const [form, setForm] = useState<RuleForm>(() => {
    const f = toForm(rule.conditions);
    if (!f.all.length && !f.alternatives.length && !Object.keys(f.extra).length) f.all = [{ field: 'subject_contains', values: [] }];
    return f;
  });
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!rule.name) nameRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const setConditions = (f: RuleForm) => {
    setForm(f);
    onChange({ conditions: fromForm(f) });
  };
  const a = rule.action;
  const setAction = (patch: Record<string, unknown>) => {
    const next = { ...a, ...patch };
    for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === '' || next[k] === false) delete next[k];
    onChange({ action: next });
  };
  const disp = (a.disposition || {}) as Record<string, string>;
  const empty = !Object.keys(fromForm(form)).length;
  const stageOptions = [...new Set([...LEAD_STAGES, ...existingStages])].map((s) => ({ value: s, label: s }));
  const ro = !canEdit;

  return (
    <div className="rule-editor">
      <label className="wf-field">
        Rule name
        <input ref={nameRef} disabled={ro} value={rule.name} placeholder="e.g. Refund requests to Billing" onChange={(e) => onChange({ name: e.target.value })} />
      </label>

      <fieldset className="rule-section">
        <legend><span className="kw">When</span> a new conversation…</legend>
        <ConditionList rows={form.all} opts={opts} stageOptions={stageOptions} disabled={ro} onChange={(rows) => setConditions({ ...form, all: rows })} addLabel={form.all.length ? '+ And…' : '+ Add a condition'} />

        {form.alternatives.length > 0 && (
          <div className="alt-groups">
            <div className="alt-intro small">{form.all.some((r) => r.values.length) ? 'and also matches at least one of these:' : 'matches at least one of these:'}</div>
            {form.alternatives.map((rows, gi) => (
              <div key={gi}>
                {gi > 0 && <div className="or-divider"><span>or</span></div>}
                <div className="alt-group">
                  <div className="alt-head small">
                    <span className="muted">Option {gi + 1}</span>
                    {!ro && <button type="button" className="link small" onClick={() => setConditions({ ...form, alternatives: form.alternatives.filter((_, j) => j !== gi) })}>Remove option</button>}
                  </div>
                  <ConditionList
                    rows={rows}
                    opts={opts}
                    stageOptions={stageOptions}
                    disabled={ro}
                    addLabel="+ And…"
                    onChange={(next) => setConditions({ ...form, alternatives: next.length ? form.alternatives.map((g, j) => (j === gi ? next : g)) : form.alternatives.filter((_, j) => j !== gi) })}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
        {!ro && (
          <button type="button" className="link small" onClick={() => setConditions({ ...form, alternatives: [...form.alternatives, [{ field: 'to', values: [] }]] })}>
            + Add an “or” option
          </button>
        )}
        {'any' in form.extra && <p className="small warn">This rule also has an advanced condition group that can’t be shown here. It’s kept as it is.</p>}
        {empty && <p className="small warn">No conditions yet, so this rule catches <b>every</b> message and the rules below it never run.</p>}
      </fieldset>

      <fieldset className="rule-section">
        <legend><span className="kw">Then</span></legend>
        <div className="rule-then">
          <label className="wf-field">
            Send to queue
            <select disabled={ro} value={String(a.queue || '')} onChange={(e) => setAction({ queue: e.target.value || undefined })}>
              <option value="">Don’t send to a queue</option>
              {opts.queues.map((qq) => <option key={qq.slug} value={qq.slug}>{qq.name}{qq.restricted ? ' (private)' : ''}</option>)}
            </select>
          </label>
          <label className="wf-field">
            Reply target
            <select disabled={ro} value={String(a.sla || '')} onChange={(e) => setAction({ sla: e.target.value || undefined })}>
              <option value="">Queue’s default</option>
              {opts.slas.map((s) => <option key={s.slug} value={s.slug}>{s.name}: {formatMinutes(s.first_response_minutes)}</option>)}
            </select>
          </label>
          <label className="wf-field">
            Priority
            <select disabled={ro} value={String(a.priority || '')} onChange={(e) => setAction({ priority: e.target.value ? Number(e.target.value) : undefined })}>
              <option value="">Normal (don’t change)</option>
              {PRIORITY_OPTIONS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </label>
        </div>
        <label className="check-row">
          <input type="checkbox" disabled={ro} checked={!!a.mark_done} onChange={(e) => setAction({ mark_done: e.target.checked, disposition: e.target.checked ? a.disposition : undefined })} />
          <span>
            <b>Mark as done straight away</b>
            <span className="muted small">For notices that never need a reply (system emails, receipts).</span>
          </span>
        </label>
        {!!a.mark_done && (
          <div className="rule-then indent-box">
            {(['audience', 'reason', 'outcome'] as const).map((k) => (
              <label key={k} className="wf-field">
                {k === 'audience' ? 'Audience' : k === 'reason' ? 'Reason' : 'Outcome'}
                <select disabled={ro} value={disp[k] || ''} onChange={(e) => setAction({ disposition: { ...disp, [k]: e.target.value || undefined } })}>
                  <option value="">—</option>
                  {[...new Set([...(opts.dispositions[k] || []), ...(disp[k] ? [disp[k]] : [])])].map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              </label>
            ))}
          </div>
        )}
        <label className="check-row">
          <input type="checkbox" disabled={ro} checked={!!a.redact} onChange={(e) => setAction({ redact: e.target.checked })} />
          <span>
            <b>Hide the message text</b>
            <span className="muted small">For bank verification codes and other sensitive messages. Agents see that a message arrived, not what it said.</span>
          </span>
        </label>
      </fieldset>
      {rule.replaces && <p className="small muted">Replaces these Kustomer rules: {rule.replaces}</p>}
      {footer}
    </div>
  );
}

function ConditionList({ rows, opts, stageOptions, disabled, onChange, addLabel }: { rows: ConditionRow[]; opts: Options; stageOptions: { value: string; label: string }[]; disabled: boolean; onChange: (rows: ConditionRow[]) => void; addLabel: string }) {
  const used = rows.map((r) => r.field);
  const nextField = FIELD_ORDER.find((f) => !used.includes(f)) || 'text_contains';
  return (
    <div className="cond-list">
      {rows.map((row, i) => (
        <div key={i} className="cond-row">
          {i > 0 && <span className="cond-and small">and</span>}
          <select
            aria-label="Condition"
            className="cond-field"
            disabled={disabled}
            value={row.field}
            onChange={(e) => onChange(rows.map((r, j) => (j === i ? { field: e.target.value as ConditionField, values: FIELDS[e.target.value as ConditionField].kind === FIELDS[r.field].kind ? r.values : [] } : r)))}
          >
            {FIELD_ORDER.map((f) => <option key={f} value={f} disabled={f !== row.field && used.includes(f)}>{FIELDS[f].label}</option>)}
          </select>
          <div className="cond-value">
            <ValueEditor row={row} opts={opts} stageOptions={stageOptions} disabled={disabled} onChange={(values) => onChange(rows.map((r, j) => (j === i ? { ...r, values } : r)))} />
            <div className="muted small">{FIELDS[row.field].help}{FIELDS[row.field].kind === 'words' && !disabled ? ' Press Enter after each one; any of them counts.' : ''}</div>
          </div>
          {!disabled && <button type="button" className="link small cond-x" aria-label="Remove condition" onClick={() => onChange(rows.filter((_, j) => j !== i))}>Remove</button>}
        </div>
      ))}
      {!disabled && used.length < FIELD_ORDER.length && (
        <button type="button" className="link small" onClick={() => onChange([...rows, { field: nextField, values: [] }])}>{addLabel}</button>
      )}
    </div>
  );
}

function ValueEditor({ row, opts, stageOptions, disabled, onChange }: { row: ConditionRow; opts: Options; stageOptions: { value: string; label: string }[]; disabled: boolean; onChange: (v: string[]) => void }) {
  const f = FIELDS[row.field];
  if (f.kind === 'channel') return <PillPicker options={CHANNEL_OPTIONS} values={row.values} onChange={onChange} disabled={disabled} />;
  if (f.kind === 'role') return <PillPicker options={ROLE_OPTIONS} values={row.values} onChange={onChange} disabled={disabled} />;
  if (f.kind === 'stage') return <PillPicker options={stageOptions} values={row.values} onChange={onChange} disabled={disabled} />;
  if (f.kind === 'address') {
    const known = opts.addresses.map((o) => o.value);
    const sameAddr = (a: string, b: string) => a.toLowerCase() === b.toLowerCase() || (digits(a).length >= 10 && digits(a).slice(-10) === digits(b).slice(-10));
    const picked = known.filter((k) => row.values.some((v) => sameAddr(v, k)));
    const other = row.values.filter((v) => !known.some((k) => sameAddr(v, k)));
    return (
      <>
        <PillPicker options={opts.addresses} values={picked} onChange={(p) => onChange([...p, ...other])} disabled={disabled} />
        {(other.length > 0 || !disabled) && <TagInput label="Another address or number" values={other} placeholder={f.placeholder} disabled={disabled} onChange={(o) => onChange([...picked, ...o])} />}
      </>
    );
  }
  return <TagInput label={f.label} values={row.values} placeholder={f.placeholder} disabled={disabled} onChange={onChange} />;
}

const digits = (s: string) => s.replace(/\D/g, '');
function formatPhone(v: string) {
  const d = digits(v).slice(-10);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : v;
}

// ---------- try a message ----------

function RuleTester({ rules, onHit, lookups, opts }: { rules: Draft[]; onHit: (key: string | null) => void; lookups: Parameters<typeof describeAction>[1]; opts: Options }) {
  const [openPanel, setOpenPanel] = useState(false);
  const [m, setM] = useState({ channel: 'email' as Channel, from: '', to: '', subject: '', body: '', role: '' as '' | Role });
  const [result, setResult] = useState<{ index: number; name: string | null; action: Record<string, unknown> } | null>(null);
  const run = useMutation({
    mutationFn: () => inbox.testRules({ channel: m.channel, from: m.from || (m.channel === 'email' ? 'someone@example.com' : '+16135550100'), to: m.to || undefined, subject: m.subject, body: m.body, roles: m.role ? [m.role] : undefined, rules: rules.map(strip) }),
    onSuccess: (res) => {
      const index = res.rule ? rules.findIndex((r) => r.enabled && r.name === res.rule) : -1;
      setResult({ index, name: res.rule, action: res.action });
      onHit(index >= 0 ? rules[index].key : 'fallback');
      const el = document.getElementById(index >= 0 ? `rule-${rules[index].key}` : '');
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    },
  });
  const set = (patch: Partial<typeof m>) => {
    setM({ ...m, ...patch });
    setResult(null);
    onHit(null);
  };
  const ours = opts.addresses.filter((a) => (m.channel === 'email' ? a.value.includes('@') : !a.value.includes('@')));
  if (!openPanel) {
    return (
      <button type="button" className="tester-toggle" onClick={() => setOpenPanel(true)}>
        <b>Try it:</b> <span className="muted">type a sample message and see which rule would pick it up →</span>
      </button>
    );
  }
  return (
    <section className="card tester">
      <div className="wf-card-head">
        <h2 className="grow">Try a message</h2>
        <button type="button" className="link small" onClick={() => { setOpenPanel(false); onHit(null); }}>Close</button>
      </div>
      <p className="muted small">Uses the rules below, including changes you haven’t saved yet. Nothing is sent or created.</p>
      <form
        className="tester-grid"
        onSubmit={(e) => {
          e.preventDefault();
          run.mutate();
        }}
      >
        <label className="wf-field">
          Arrives by
          <select value={m.channel} onChange={(e) => set({ channel: e.target.value as Channel, to: '' })}>
            {CHANNEL_OPTIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </label>
        <label className="wf-field">
          From
          <input value={m.from} placeholder={m.channel === 'email' ? 'jane@example.com' : '613-555-0100'} onChange={(e) => set({ from: e.target.value })} />
        </label>
        <label className="wf-field">
          Sent to
          <select value={m.to} onChange={(e) => set({ to: e.target.value })}>
            <option value="">—</option>
            {ours.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
          </select>
        </label>
        <label className="wf-field">
          Contact is a
          <select value={m.role} onChange={(e) => set({ role: e.target.value as Role | '' })}>
            <option value="">Look up the sender</option>
            {ROLE_OPTIONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </label>
        {m.channel === 'email' && (
          <label className="wf-field span-2">
            Subject
            <input value={m.subject} onChange={(e) => set({ subject: e.target.value })} />
          </label>
        )}
        <label className="wf-field span-all">
          Message
          <textarea rows={2} value={m.body} onChange={(e) => set({ body: e.target.value })} />
        </label>
        <div className="actions span-all">
          <button type="submit" disabled={run.isPending}>{run.isPending ? 'Checking…' : 'Check where it goes'}</button>
          {run.error && <span className="error small">{(run.error as Error).message}</span>}
        </div>
      </form>
      {result && (
        <div className="tester-result" role="status">
          {result.name ? (
            <>
              Rule <b>#{result.index + 1} “{result.name}”</b> picks this up: {describeAction(result.action, lookups)}.
            </>
          ) : (
            <>No rule matches, so it goes to <b>Fallback</b>.</>
          )}
        </div>
      )}
    </section>
  );
}
