// GET /api/ceo-dashboard
// The exec view: $ pipeline, close-date win rate, a real forecast, top deals, win/loss. All
// numbers come from lib/metrics so they match every other surface (PLATFORM_REVIEW §6.3/§6.4).

import { createServerSupabaseClient, getSupabase } from '../../lib/supabase';
import { apiError, apiSuccess, logRequest } from '../../lib/apiUtils';
import { STAGE_PROBABILITY, STAGE_LABELS, ACTIVE_STAGE_ORDER } from '../../lib/constants';
import { openPipeline, weightedPipeline, pipelineConfidence, winRate, fmtUsd } from '../../lib/metrics';

const LATE_STAGES = ['demo', 'solution_validation', 'proposal', 'legal'];
const daysSince = (d) => (d ? Math.floor((Date.now() - new Date(d).getTime()) / 86400000) : null);

function quarterBounds(now = new Date()) {
  const q = Math.floor(now.getMonth() / 3);
  const start = new Date(now.getFullYear(), q * 3, 1);
  const end = new Date(now.getFullYear(), q * 3 + 3, 0);
  return { start, end };
}

export default async function handler(req, res) {
  logRequest(req, 'ceo-dashboard');
  if (req.method !== 'GET') return apiError(res, 405, 'GET only');

  const auth = createServerSupabaseClient(req, res);
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return apiError(res, 401, 'Unauthorized');

  const db = getSupabase();
  const [accountsRes, callsRes, configRes] = await Promise.all([
    db.from('accounts').select('id, name, stage, owner_name, deal_value, risk_score, debrief, close_date, updated_at').limit(5000),
    db.from('gong_call_analyses').select('account_id, call_date').or('call_category.is.null,call_category.not.in.(cs,internal)').order('call_date', { ascending: false }),
    db.from('sales_process_config').select('stage_weights').limit(1).single(),
  ]);

  const accounts = accountsRes.data || [];
  const calls = callsRes.data || [];
  const weights = { ...STAGE_PROBABILITY, ...(configRes.data?.stage_weights || {}) };

  const lastCallByAccount = {};
  for (const c of calls) if (!lastCallByAccount[c.account_id]) lastCallByAccount[c.account_id] = c.call_date;

  const activeDeals = accounts.filter((a) => ACTIVE_STAGE_ORDER.includes(a.stage));

  // Pipeline by stage — count AND dollars.
  const byStage = ACTIVE_STAGE_ORDER.map((stage) => {
    const inStage = activeDeals.filter((a) => a.stage === stage);
    return { stage, label: STAGE_LABELS[stage] || stage, count: inStage.length, value: inStage.reduce((s, a) => s + (Number(a.deal_value) || 0), 0) };
  }).filter((s) => s.count > 0);

  // Canonical dollars + confidence + win rate (win rate windowed by CLOSE DATE, not updated_at).
  const open = openPipeline(accounts);
  const weighted = weightedPipeline(accounts, weights);
  const confidenceScore = pipelineConfidence(accounts, weights);
  const wr = winRate(accounts, { windowDays: 90 });

  // Forecast: what is expected to close this quarter (by close_date), gross and weighted.
  const { start: qStart, end: qEnd } = quarterBounds();
  const closingThisQuarter = activeDeals.filter((a) => a.close_date && new Date(a.close_date) >= qStart && new Date(a.close_date) <= qEnd);
  const commitThisQuarter = closingThisQuarter.reduce((s, a) => s + (Number(a.deal_value) || 0) * ((weights[a.stage] ?? 0) / 100), 0);
  const grossThisQuarter = closingThisQuarter.reduce((s, a) => s + (Number(a.deal_value) || 0), 0);

  const topDeals = activeDeals
    .filter((a) => LATE_STAGES.includes(a.stage))
    .map((a) => ({ id: a.id, name: a.name, stage: a.stage, stageLabel: STAGE_LABELS[a.stage], ownerName: a.owner_name, dealValue: a.deal_value, riskScore: a.risk_score, closeDate: a.close_date, daysSinceLastCall: daysSince(lastCallByAccount[a.id]) }))
    .sort((a, b) => (b.daysSinceLastCall ?? 999) - (a.daysSinceLastCall ?? 999))
    .slice(0, 8);

  // Recent closes windowed by close_date (fall back to updated_at only when close_date is missing).
  const ninety = Date.now() - 90 * 86400000;
  const closedRecently = accounts.filter((a) => ['closed_won', 'closed_lost'].includes(a.stage) && new Date(a.close_date || a.updated_at).getTime() >= ninety);
  const recentCloses = closedRecently
    .sort((a, b) => new Date(b.close_date || b.updated_at) - new Date(a.close_date || a.updated_at))
    .slice(0, 10)
    .map((a) => ({ id: a.id, name: a.name, stage: a.stage, dealValue: a.deal_value, closedOn: a.close_date || a.updated_at, hasDebrief: !!a.debrief, wonOn: a.debrief?.what_we_won_on || null, lostOn: a.debrief?.what_we_lost_on || null, competitor: a.debrief?.competitor || null, keyLessons: a.debrief?.key_lessons || null }));

  const repMap = {};
  for (const a of activeDeals) {
    const rep = a.owner_name || 'Unassigned';
    if (!repMap[rep]) repMap[rep] = { name: rep, activeDeals: 0, value: 0, lateStage: 0, staleDeals: 0 };
    repMap[rep].activeDeals++;
    repMap[rep].value += Number(a.deal_value) || 0;
    if (LATE_STAGES.includes(a.stage)) repMap[rep].lateStage++;
    const ds = daysSince(lastCallByAccount[a.id]);
    if (ds != null && ds > 14) repMap[rep].staleDeals++;
  }
  const repBreakdown = Object.values(repMap).sort((a, b) => b.value - a.value);

  const lostReasons = [], wonReasons = [], competitorLosses = {};
  for (const a of accounts) {
    if (!a.debrief) continue;
    if (a.stage === 'closed_lost') {
      if (a.debrief.what_we_lost_on) lostReasons.push({ account: a.name, reason: a.debrief.what_we_lost_on });
      if (a.debrief.competitor) competitorLosses[a.debrief.competitor] = (competitorLosses[a.debrief.competitor] || 0) + 1;
    }
    if (a.stage === 'closed_won' && a.debrief.what_we_won_on) wonReasons.push({ account: a.name, reason: a.debrief.what_we_won_on });
  }

  return apiSuccess(res, {
    summary: {
      activeDeals: activeDeals.length,
      openPipeline: open,
      weightedPipeline: Math.round(weighted),
      openPipelineLabel: fmtUsd(open),
      weightedPipelineLabel: fmtUsd(weighted),
      confidenceScore,
      lateStageDeals: activeDeals.filter((a) => LATE_STAGES.includes(a.stage)).length,
      staleDeals: activeDeals.filter((a) => { const ds = daysSince(lastCallByAccount[a.id]); return ds == null || ds > 14; }).length,
      wonLast90: wr.won,
      lostLast90: wr.lost,
      winRate: wr.rate,
    },
    forecast: {
      commitThisQuarter: Math.round(commitThisQuarter),
      commitThisQuarterLabel: fmtUsd(commitThisQuarter),
      grossThisQuarter,
      grossThisQuarterLabel: fmtUsd(grossThisQuarter),
      dealsClosingThisQuarter: closingThisQuarter.length,
      weightedPipelineLabel: fmtUsd(weighted),
    },
    byStage,
    topDeals,
    recentCloses,
    repBreakdown,
    winLossInsights: {
      topLostReasons: lostReasons.slice(0, 5),
      topWonFactors: wonReasons.slice(0, 5),
      topCompetitorLosses: Object.entries(competitorLosses).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([competitor, count]) => ({ competitor, count })),
      totalDebriefed: accounts.filter((a) => a.debrief).length,
    },
  });
}
