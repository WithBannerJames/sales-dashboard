// GET /api/reports/feed?days=14
// The constant feed: what people are doing, what prospects are saying, and an AI
// read on what's working / not working + suggestions (individual + team).
// All sources degrade gracefully if a table/column isn't present.

import { createServerSupabaseClient, getSupabase } from '../../../lib/supabase';
import { apiError, apiSuccess, logRequest, callAnthropic } from '../../../lib/apiUtils';
import { CLAUDE_MODELS } from '../../../lib/constants';

export default async function handler(req, res) {
  logRequest(req, 'reports/feed');
  if (req.method !== 'GET') return apiError(res, 405, 'GET only');

  const auth = createServerSupabaseClient(req, res);
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return apiError(res, 401, 'Unauthorized');

  const days = Math.min(parseInt(req.query.days, 10) || 14, 90);
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const sinceDate = since.slice(0, 10);

  const db = getSupabase();
  const feed = [];

  // ── Completed tasks ──────────────────────────────────────────────────────────
  try {
    // Base columns only (trigger may not exist pre-migration; PostgREST would null the whole query).
    const { data: tasks } = await db
      .from('tasks')
      .select('id, title, completed_at, source, owner_id, accounts ( name ), profiles!tasks_owner_id_fkey ( full_name )')
      .eq('status', 'complete')
      .gte('completed_at', since)
      .order('completed_at', { ascending: false })
      .limit(60);
    for (const t of tasks || []) {
      feed.push({
        type: 'task_done',
        at: t.completed_at,
        who: t.profiles?.full_name || 'Someone',
        account: t.accounts?.name || null,
        text: t.title,
        meta: t.source || null,
      });
    }
  } catch { /* ignore */ }

  // ── Stage changes ──────────────────────────────────────────────────────────────
  try {
    const { data: hist, error: histErr } = await db
      .from('account_stage_history')
      .select('account_id, from_stage, to_stage, changed_at, changed_by_name, accounts ( name )')
      .gte('changed_at', since)
      .order('changed_at', { ascending: false })
      .limit(60);
    if (histErr) throw histErr;
    for (const h of hist || []) {
      feed.push({
        type: 'stage_change',
        at: h.changed_at,
        who: h.changed_by_name || 'System',
        account: h.accounts?.name || null,
        text: `${h.from_stage || '?'} → ${h.to_stage || '?'}`,
        meta: h.to_stage,
      });
    }
  } catch { /* table optional */ }

  // ── Recent analyzed calls + what prospects are saying ───────────────────────────
  const prospectVoice = { objections: {}, buyingSignals: {}, pains: {}, competitors: {} };
  let analyzedCount = 0;
  try {
    const { data: calls } = await db
      .from('gong_call_analyses')
      .select('title, rep_name, call_date, analyzed_at, account_id, analysis, accounts ( name )')
      .gte('analyzed_at', since)
      .eq('ignored', false)
      .not('analysis', 'is', null)
      .or('call_category.is.null,call_category.not.in.(cs,internal)')
      .order('analyzed_at', { ascending: false })
      .limit(120);
    const bump = (bag, k) => { if (k && String(k).trim()) { const key = String(k).trim().slice(0, 80); bag[key] = (bag[key] || 0) + 1; } };
    for (const c of calls || []) {
      analyzedCount++;
      const a = c.analysis || {};
      if (analyzedCount <= 40) {
        feed.push({
          type: 'call',
          at: c.analyzed_at || c.call_date,
          who: c.rep_name || 'Rep',
          account: c.accounts?.name || null,
          text: c.title || 'Call analyzed',
          meta: a.discovery_score != null ? `discovery ${a.discovery_score}/10` : null,
        });
      }
      (a.objections || []).forEach(o => bump(prospectVoice.objections, typeof o === 'string' ? o : o?.text));
      (a.buying_signals || []).forEach(s => bump(prospectVoice.buyingSignals, s));
      (a.pain_points_identified || a.pain_points || []).forEach(p => bump(prospectVoice.pains, typeof p === 'string' ? p : p?.text));
      (a.competitor_mentions || []).forEach(m => bump(prospectVoice.competitors, m?.name));
    }
  } catch { /* ignore */ }

  feed.sort((x, y) => new Date(y.at || 0) - new Date(x.at || 0));

  const topN = (bag, n = 6) => Object.entries(bag).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ text: k, count: v }));
  const prospects = {
    objections: topN(prospectVoice.objections),
    buyingSignals: topN(prospectVoice.buyingSignals),
    pains: topN(prospectVoice.pains),
    competitors: topN(prospectVoice.competitors),
  };

  // ── AI synthesis: right / wrong / suggestions (team + individual) ───────────────
  let synthesis = null;
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey && (analyzedCount > 0 || feed.length > 0)) {
      const summary = {
        window_days: days,
        activity_counts: feed.reduce((m, f) => { m[f.type] = (m[f.type] || 0) + 1; return m; }, {}),
        top_objections: prospects.objections,
        top_buying_signals: prospects.buyingSignals,
        top_pains: prospects.pains,
        competitors: prospects.competitors,
      };
      const prompt = `You are the sales operations analyst for Banner (CapEx software). Based on the last ${days} days of team activity and call signals below, give a sharp, specific read. No fluff, no generic advice.

DATA:
${JSON.stringify(summary, null, 1)}

Respond with ONLY valid JSON:
{
  "headline": "one punchy sentence on the state of the team this period",
  "working": ["2-3 specific things going well, grounded in the data"],
  "not_working": ["2-3 specific risks or gaps, grounded in the data"],
  "team_suggestions": ["2-3 concrete actions for the team this week"],
  "watch": "the single most important thing to watch next"
}`;
      const raw = await callAnthropic(apiKey, { model: CLAUDE_MODELS.HAIKU, maxTokens: 800, messages: [{ role: 'user', content: prompt }] });
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) synthesis = JSON.parse(m[0]);
    }
  } catch (e) { console.error('[reports/feed] synthesis failed:', e.message); }

  return apiSuccess(res, {
    days,
    sinceDate,
    feed: feed.slice(0, 80),
    prospects,
    analyzedCount,
    synthesis,
  });
}
