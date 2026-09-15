// The app. One page: pick a deal on the left, see everything known about it on the right —
// every conversation, and what's missing on MEDDPICC and on Banner's stage process.
//
// Deliberately does NOT use AppShell: the 2026-09 reset shelved all 32 legacy modules, so
// there is no module nav. Everything here reads through /api/simple/* (service-role,
// no sign-in) because `accounts` has RLS on and a browser client would read zero rows.

import { useEffect, useMemo, useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { STAGE_PROCESS, PROCESS_STAGE_ORDER } from '../lib/stageExitCriteria';

const STAGE_STYLE = {
  active_pursuit: 'bg-blue-50 text-blue-700 ring-blue-200',
  qualifying: 'bg-amber-50 text-amber-700 ring-amber-200',
  solution_validation: 'bg-violet-50 text-violet-700 ring-violet-200',
  proposal: 'bg-orange-50 text-orange-700 ring-orange-200',
  legal: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  demo: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
  closed_won: 'bg-green-50 text-green-700 ring-green-200',
  closed_lost: 'bg-slate-100 text-slate-500 ring-slate-200',
  inactive_sdr_follow_up: 'bg-slate-100 text-slate-500 ring-slate-200',
  inactive_ae_follow_up: 'bg-slate-100 text-slate-500 ring-slate-200',
};

const label = (stage) => STAGE_PROCESS[stage]?.label || (stage || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

// Default list order: closest to close first, following Banner's process. Dead and closed
// stages sink below everything live when they're shown at all.
const STAGE_RANK = { legal: 1, proposal: 2, solution_validation: 3, qualifying: 4, active_pursuit: 5, demo: 6 };
const rankOf = (stage) => STAGE_RANK[stage] ?? 90;

function StageChip({ stage, className = '' }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${STAGE_STYLE[stage] || 'bg-slate-100 text-slate-600 ring-slate-200'} ${className}`}>
      {label(stage)}
    </span>
  );
}

const money = (v) => (v == null ? null : `$${Number(v).toLocaleString()}`);
const day = (d) => (d ? new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : null);
function daysAgo(d) {
  if (!d) return null;
  const n = Math.floor((Date.now() - new Date(d).getTime()) / 86400000);
  return n <= 0 ? 'today' : n === 1 ? '1d ago' : `${n}d ago`;
}

function Meter({ n, total }) {
  const pct = total ? (n / total) * 100 : 0;
  const tone = pct >= 75 ? 'bg-emerald-500' : pct >= 40 ? 'bg-amber-500' : 'bg-rose-400';
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="h-1.5 w-10 overflow-hidden rounded-full bg-slate-200">
        <span className={`block h-full ${tone}`} style={{ width: `${pct}%` }} />
      </span>
      <span className="text-[11px] font-medium tabular-nums text-slate-500">{n}/{total}</span>
    </span>
  );
}

export default function Deals() {
  const [list, setList] = useState([]);
  const [hiddenStages, setHiddenStages] = useState([]);
  const [filters, setFilters] = useState({ owners: [], stages: [], quarters: [] });
  const [listErr, setListErr] = useState(null);
  const [loadingList, setLoadingList] = useState(true);

  const [q, setQ] = useState('');
  const [owner, setOwner] = useState('');
  const [stage, setStage] = useState('');
  const [quarter, setQuarter] = useState('');
  const [showDead, setShowDead] = useState(false);

  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [gaps, setGaps] = useState(null);
  const [loadingGaps, setLoadingGaps] = useState(false);

  useEffect(() => {
    fetch('/api/simple/deals')
      .then((r) => r.json())
      .then((d) => {
        if (d.error) throw new Error(d.error);
        setList(d.deals || []);
        setHiddenStages(d.defaultHiddenStages || []);
        setFilters(d.filters || { owners: [], stages: [], quarters: [] });
      })
      .catch((e) => setListErr(e.message))
      .finally(() => setLoadingList(false));
  }, []);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return list
      .filter((d) => {
        if (!showDead && !stage && hiddenStages.includes(d.stage)) return false;
        if (stage && d.stage !== stage) return false;
        if (owner === '__unassigned' ? !!d.owner : owner && d.owner !== owner) return false;
        if (quarter && d.closeQuarter !== quarter) return false;
        if (needle && !(d.name || '').toLowerCase().includes(needle)) return false;
        return true;
      })
      .sort((a, b) => {
        const byStage = rankOf(a.stage) - rankOf(b.stage);
        if (byStage) return byStage;
        // Within a stage, most recent activity first; deals with no calls last.
        if (a.lastCallDate && b.lastCallDate) return new Date(b.lastCallDate) - new Date(a.lastCallDate);
        if (a.lastCallDate) return -1;
        if (b.lastCallDate) return 1;
        return (a.name || '').localeCompare(b.name || '');
      });
  }, [list, q, owner, stage, quarter, showDead, hiddenStages]);

  function openDeal(id) {
    setSelectedId(id);
    setDetail(null);
    setGaps(null);
    setLoadingDetail(true);
    fetch(`/api/simple/deal?id=${id}`)
      .then((r) => r.json())
      .then((d) => setDetail(d.error ? { error: d.error } : d))
      .catch((e) => setDetail({ error: e.message }))
      .finally(() => setLoadingDetail(false));

    setLoadingGaps(true);
    fetch(`/api/simple/gaps?id=${id}`)
      .then((r) => r.json())
      .then((d) => setGaps(d))
      .catch((e) => setGaps({ error: e.message }))
      .finally(() => setLoadingGaps(false));
  }

  function rerun() {
    if (!selectedId) return;
    setLoadingGaps(true);
    setGaps(null);
    fetch(`/api/simple/gaps?id=${selectedId}&refresh=1`)
      .then((r) => r.json())
      .then((d) => setGaps(d))
      .catch((e) => setGaps({ error: e.message }))
      .finally(() => setLoadingGaps(false));
  }

  const stageOptions = useMemo(() => {
    const present = filters.stages || [];
    const ordered = PROCESS_STAGE_ORDER.filter((s) => present.includes(s));
    return [...ordered, ...present.filter((s) => !ordered.includes(s))];
  }, [filters.stages]);

  return (
    <>
      <Head><title>Deals — Banner</title></Head>
      <div className="flex h-screen flex-col bg-slate-50 text-slate-900">
        <header className="flex shrink-0 items-center justify-between border-b border-slate-200 bg-white px-5 py-3">
          <div className="flex items-baseline gap-3">
            <h1 className="text-[15px] font-semibold tracking-tight">Deals</h1>
            <span className="text-xs text-slate-400">
              {loadingList ? 'loading…' : `${visible.length} of ${list.length}`}
            </span>
          </div>
          <Link href="/roadmap" className="rounded-md border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50">
            Roadmap
          </Link>
        </header>

        <div className="flex min-h-0 flex-1">
          {/* Picker */}
          <aside className="flex w-[340px] shrink-0 flex-col border-r border-slate-200 bg-white">
            <div className="space-y-2 border-b border-slate-100 p-3">
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search deals"
                className="w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-[13px] outline-none placeholder:text-slate-400 focus:border-slate-400"
              />
              <div className="grid grid-cols-2 gap-2">
                <select value={owner} onChange={(e) => setOwner(e.target.value)} className="rounded-md border border-slate-200 px-2 py-1.5 text-xs">
                  <option value="">All owners</option>
                  {(filters.owners || []).map((o) => <option key={o} value={o}>{o}</option>)}
                  {filters.unassignedCount ? <option value="__unassigned">Unassigned ({filters.unassignedCount})</option> : null}
                </select>
                <select value={stage} onChange={(e) => setStage(e.target.value)} className="rounded-md border border-slate-200 px-2 py-1.5 text-xs">
                  <option value="">Live stages</option>
                  {stageOptions.map((s) => <option key={s} value={s}>{label(s)}</option>)}
                </select>
              </div>
              <select value={quarter} onChange={(e) => setQuarter(e.target.value)} className="w-full rounded-md border border-slate-200 px-2 py-1.5 text-xs">
                <option value="">Any close quarter</option>
                {(filters.quarters || []).map((qq) => <option key={qq} value={qq}>{qq}</option>)}
              </select>
              {!stage && (
                <label className="flex cursor-pointer items-center gap-2 text-[11px] text-slate-500">
                  <input type="checkbox" checked={showDead} onChange={(e) => setShowDead(e.target.checked)} />
                  Include inactive, closed and churned
                </label>
              )}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {loadingList && <p className="p-4 text-xs text-slate-400">Loading deals…</p>}
              {listErr && <p className="p-4 text-xs text-rose-600">{listErr}</p>}
              {!loadingList && !visible.length && <p className="p-4 text-xs text-slate-400">No deals match those filters.</p>}
              {visible.map((d) => (
                <button
                  key={d.id}
                  onClick={() => openDeal(d.id)}
                  className={`w-full border-b border-slate-50 px-3 py-2.5 text-left hover:bg-slate-50 ${selectedId === d.id ? 'bg-slate-50 ring-1 ring-inset ring-slate-200' : ''}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-[13px] font-medium leading-tight">{d.name}</span>
                    <StageChip stage={d.stage} className="shrink-0" />
                  </div>
                  <div className="mt-1.5 flex items-center justify-between gap-2">
                    <span className="truncate text-[11px] text-slate-500">
                      {d.owner || 'Unassigned'}
                      {d.callCount ? ` · ${d.callCount} call${d.callCount === 1 ? '' : 's'}` : ' · no calls'}
                      {d.lastCallDate ? ` · ${daysAgo(d.lastCallDate)}` : ''}
                    </span>
                    <Meter n={d.meddpiccCaptured} total={d.meddpiccTotal} />
                  </div>
                </button>
              ))}
            </div>
          </aside>

          {/* Detail */}
          <main className="min-w-0 flex-1 overflow-y-auto">
            {!selectedId && (
              <div className="flex h-full items-center justify-center">
                <p className="text-sm text-slate-400">Pick a deal to see its conversations and gaps.</p>
              </div>
            )}
            {selectedId && loadingDetail && <p className="p-6 text-xs text-slate-400">Loading deal…</p>}
            {detail?.error && <p className="p-6 text-sm text-rose-600">{detail.error}</p>}
            {detail && !detail.error && (
              <DealDetail detail={detail} gaps={gaps} loadingGaps={loadingGaps} onRerun={rerun} />
            )}
          </main>
        </div>
      </div>
    </>
  );
}

function DealDetail({ detail, gaps, loadingGaps, onRerun }) {
  const { deal, children, calls, stageGoal } = detail;
  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <section>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-xl font-semibold tracking-tight">{deal.name}</h2>
          <StageChip stage={deal.stage} />
        </div>
        <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-[12px] text-slate-600">
          <div><dt className="inline text-slate-400">Owner </dt><dd className="inline font-medium">{deal.owner || 'Unassigned'}</dd></div>
          {money(deal.dealValue) && <div><dt className="inline text-slate-400">Value </dt><dd className="inline font-medium tabular-nums">{money(deal.dealValue)}</dd></div>}
          {day(deal.closeDate) && <div><dt className="inline text-slate-400">Close </dt><dd className="inline font-medium">{day(deal.closeDate)}</dd></div>}
          {deal.vertical && <div><dt className="inline text-slate-400">Vertical </dt><dd className="inline font-medium">{deal.vertical}</dd></div>}
        </dl>
        {stageGoal && (
          <p className="mt-3 rounded-md bg-white px-3 py-2 text-[12px] text-slate-600 ring-1 ring-slate-200">
            <span className="text-slate-400">Goal of this stage · </span>{stageGoal}
          </p>
        )}
        {!!children?.length && (
          <div className="mt-3">
            <p className="text-[11px] uppercase tracking-wide text-slate-400">Deal rows in this company</p>
            <ul className="mt-1 space-y-1">
              {children.map((c) => (
                <li key={c.id} className="flex items-center gap-2 text-[12px] text-slate-600">
                  <StageChip stage={c.stage} />
                  <span>{c.name}</span>
                  {money(c.dealValue) && <span className="tabular-nums text-slate-400">{money(c.dealValue)}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <GapPanel gaps={gaps} loading={loadingGaps} onRerun={onRerun} />
      <ProcessPanel gaps={gaps} loading={loadingGaps} stageGoal={stageGoal} fallback={detail.stageExit} />
      <Conversations calls={calls} />
    </div>
  );
}

function GapPanel({ gaps, loading, onRerun }) {
  const captured = gaps?.capturedCount ?? 0;
  const total = gaps?.total ?? 8;
  return (
    <section className="rounded-lg bg-white ring-1 ring-slate-200">
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
        <div className="flex items-center gap-3">
          <h3 className="text-[13px] font-semibold">MEDDPICC</h3>
          {gaps?.status === 'ok' && <Meter n={captured} total={total} />}
        </div>
        <div className="flex items-center gap-3">
          {gaps?.basedOn?.calls != null && (
            <span className="text-[11px] text-slate-400">from {gaps.basedOn.calls} transcript{gaps.basedOn.calls === 1 ? '' : 's'}</span>
          )}
          <button onClick={onRerun} disabled={loading} className="rounded-md border border-slate-200 px-2 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50">
            {loading ? 'Reading…' : 'Re-run'}
          </button>
        </div>
      </div>

      {loading && <p className="px-4 py-6 text-xs text-slate-400">Reading the transcripts…</p>}
      {!loading && gaps?.error && <p className="px-4 py-6 text-xs text-rose-600">{gaps.error}</p>}
      {!loading && gaps?.status === 'no_transcripts' && (
        <p className="px-4 py-6 text-xs text-slate-500">{gaps.message}</p>
      )}
      {!loading && gaps?.status === 'not_in_scope' && (
        <p className="px-4 py-6 text-xs text-slate-500">{gaps.message}</p>
      )}
      {!loading && gaps?.status === 'ok' && (
        <ul className="divide-y divide-slate-50">
          {gaps.elements.map((e) => (
            <li key={e.id} className="px-4 py-3">
              <div className="flex items-start gap-2.5">
                <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${e.captured ? 'bg-emerald-500' : 'bg-rose-400'}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-[12px] font-semibold">{e.label}</span>
                    {!e.captured && <span className="text-[10px] font-medium uppercase tracking-wide text-rose-500">missing</span>}
                  </div>
                  {e.captured ? (
                    <>
                      <p className="mt-0.5 text-[12px] leading-snug text-slate-700">{e.value}</p>
                      {e.evidence && (
                        <p className="mt-1.5 border-l-2 border-slate-200 pl-2 text-[11px] italic leading-snug text-slate-500">
                          “{e.evidence}”{e.sourceCall ? <span className="not-italic"> — {e.sourceCall}</span> : null}
                        </p>
                      )}
                    </>
                  ) : (
                    <>
                      <p className="mt-0.5 text-[11px] leading-snug text-slate-500">{e.why}</p>
                      {!!e.questions?.length && (
                        <p className="mt-1 text-[11px] leading-snug text-slate-600">
                          <span className="text-slate-400">Ask: </span>{e.questions[0]}
                        </p>
                      )}
                    </>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const VERDICT = {
  advance: { label: 'Advance', cls: 'bg-emerald-50 text-emerald-700 ring-emerald-200' },
  progress: { label: 'Progress', cls: 'bg-amber-50 text-amber-700 ring-amber-200' },
  exit: { label: 'Exit', cls: 'bg-rose-50 text-rose-700 ring-rose-200' },
};

function ProcessPanel({ gaps, loading, stageGoal, fallback }) {
  const items = gaps?.stageExit?.length ? gaps.stageExit : fallback || [];
  const stage = gaps?.stage || null;
  const rec = gaps?.recommendation || null;
  if (!items.length && !stage?.goals?.length) return null;
  const assessed = !!gaps?.stageExit?.length && gaps?.status === 'ok';
  const met = items.filter((c) => c.met).length;

  return (
    <section className="rounded-lg bg-white ring-1 ring-slate-200">
      <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-4 py-3">
        <div className="min-w-0">
          <h3 className="text-[13px] font-semibold">Sales process</h3>
          <p className="mt-0.5 text-[11px] text-slate-400">
            {stageGoal ? `Goal: ${stageGoal}. ` : ''}What has to be true to move forward.
          </p>
        </div>
        {assessed && (
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-[11px] tabular-nums text-slate-400">{met}/{items.length}</span>
            {rec && (
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${VERDICT[rec.verdict]?.cls || 'bg-slate-100 text-slate-600 ring-slate-200'}`}>
                {VERDICT[rec.verdict]?.label || rec.verdict}
              </span>
            )}
          </div>
        )}
      </div>

      {rec?.reason && !loading && (
        <p className="border-b border-slate-50 px-4 py-2 text-[11.5px] leading-snug text-slate-600">{rec.reason}</p>
      )}

      {loading && <p className="px-4 py-5 text-xs text-slate-400">Assessing…</p>}

      {!loading && !!items.length && (
        <ul className="divide-y divide-slate-50">
          {items.map((c) => (
            <li key={c.id} className="flex items-start gap-2.5 px-4 py-2.5">
              <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${c.met ? 'bg-emerald-500' : 'bg-slate-300'}`} />
              <div className="min-w-0 flex-1">
                <p className="text-[12px] leading-snug text-slate-700">{c.label}</p>
                {c.note && <p className="mt-0.5 text-[11px] leading-snug text-slate-500">{c.note}</p>}
                {!assessed && c.manuallyChecked && <p className="mt-0.5 text-[11px] text-slate-400">Marked done previously</p>}
              </div>
            </li>
          ))}
        </ul>
      )}

      {!loading && !!stage?.killWhen?.length && (
        <div className="border-t border-slate-100 px-4 py-2.5">
          <p className="text-[10.5px] font-medium uppercase tracking-wide text-slate-400">Close it when</p>
          <ul className="mt-1 space-y-0.5">
            {stage.killWhen.map((k, i) => (
              <li key={i} className="text-[11.5px] leading-snug text-slate-600">{k}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function Conversations({ calls }) {
  const [open, setOpen] = useState(null);
  return (
    <section className="rounded-lg bg-white ring-1 ring-slate-200">
      <div className="border-b border-slate-100 px-4 py-3">
        <h3 className="text-[13px] font-semibold">
          Conversations <span className="font-normal text-slate-400">{calls.length}</span>
        </h3>
      </div>
      {!calls.length && (
        <p className="px-4 py-6 text-xs text-slate-500">
          No Gong calls are linked to this deal. Either none have happened, or calls exist but were never matched to it.
        </p>
      )}
      <ul className="divide-y divide-slate-50">
        {calls.map((c) => (
          <li key={c.id} className="px-4 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[12.5px] font-medium leading-snug">{c.title || 'Untitled call'}</p>
                <p className="mt-0.5 text-[11px] text-slate-500">
                  {day(c.date)}{c.repName ? ` · ${c.repName}` : ''}{c.durationMinutes ? ` · ${c.durationMinutes}m` : ''}
                  {c.category && c.category !== 'sales' ? ` · ${c.category}` : ''}
                  {c.pending ? ' · not yet analysed' : ''}
                </p>
              </div>
              {c.hasTranscript && (
                <button onClick={() => setOpen(open === c.id ? null : c.id)} className="shrink-0 rounded-md border border-slate-200 px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-50">
                  {open === c.id ? 'Hide' : 'Transcript'}
                </button>
              )}
            </div>
            {c.summary && <p className="mt-1.5 text-[12px] leading-snug text-slate-600">{c.summary}</p>}
            {!!c.nextSteps?.length && (
              <ul className="mt-1.5 space-y-0.5">
                {c.nextSteps.slice(0, 4).map((s, i) => (
                  <li key={i} className="text-[11px] leading-snug text-slate-600">→ {s}</li>
                ))}
              </ul>
            )}
            {open === c.id && (
              <pre className="mt-2 max-h-80 overflow-y-auto whitespace-pre-wrap rounded-md bg-slate-50 p-3 text-[11px] leading-relaxed text-slate-700">
                {c.transcriptText}
              </pre>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
