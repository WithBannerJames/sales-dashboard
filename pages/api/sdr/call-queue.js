// GET /api/sdr/call-queue?scope=mine|all&days=
// The AI-first daily call queue: real pipeline accounts ranked by who is most worth a touch
// today — composite of how overdue they are, ICP fit (latest call's icp_score), stage, and tier.
// Supabase-backed (manager-visible), unlike the legacy localStorage pursuit tool.
// Read-only. Also returns today's logged-touch count + the daily target.

import { createServerSupabaseClient, getSupabase } from '../../../lib/supabase';
import { apiError, apiSuccess, validateMethod, logRequest } from '../../../lib/apiUtils';
import { ownsAccount } from '../../../lib/repConfig';

// Start-of-business-day in America/New_York, returned as the exact UTC instant. Vercel runs in UTC,
// so a naive setHours(0,0,0,0) would anchor to UTC midnight (~8pm ET the night before) and bleed the
// prior evening's touches into today's count. This subtracts the elapsed ET wall-clock from `now`,
// which is DST-robust because it reads the actual ET clock.
function startOfEtDay() {
  const now = new Date();
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(now).reduce((o, x) => (o[x.type] = x.value, o), {});
  const intoDayMs = ((+p.hour) * 3600 + (+p.minute) * 60 + (+p.second)) * 1000;
  return new Date(now.getTime() - intoDayMs);
}

// Excluded from the daily queue: closed + inactive/dead deals. inactive_* are dormant deals migrating
// to closed_lost — they belong in reengagement campaigns, not the daily "who to call" list.
const CLOSED = new Set(['closed_won', 'closed_lost', 'inactive_sdr_follow_up', 'inactive_ae_follow_up']);
// SDR-relevant stages (cold / early / re-engage) rank higher than late AE-owned stages.
const STAGE_POINTS = {
  inactive_sdr_follow_up: 20, inactive_ae_follow_up: 18, qualifying: 18, intro_scheduled: 14,
  active_pursuit: 12, demo: 8, solution_validation: 5, proposal: 2, legal: 0,
};
const DEFAULT_TARGET = 20;

export default async function handler(req, res) {
  logRequest(req, 'sdr/call-queue');
  if (!validateMethod(req, res, 'GET')) return;

  const auth = createServerSupabaseClient(req, res);
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return apiError(res, 401, 'Unauthorized');

  const db = getSupabase();
  const { data: profile } = await db.from('profiles').select('id, full_name, role').eq('id', user.id).maybeSingle();
  const isManager = ['manager','admin'].includes(profile?.role);
  const scope = req.query.scope === 'all' ? 'all' : (req.query.scope === 'mine' ? 'mine' : (isManager ? 'all' : 'mine'));
  const target = Math.max(1, parseInt(req.query.target, 10) || DEFAULT_TARGET);

  // Pull active accounts + (for recency/ICP) their analyzed calls.
  const [acctRes, callsRes] = await Promise.all([
    db.from('accounts').select('id, name, stage, tier, owner_name, vertical, deal_value, user_id').limit(5000),
    db.from('gong_call_analyses').select('account_id, call_date, analysis')
      .not('account_id', 'is', null).eq('ignored', false).not('analyzed_at', 'is', null)
      .or('call_category.is.null,call_category.not.in.(cs,internal)')
      .order('call_date', { ascending: false }).limit(3000),
  ]);
  if ((callsRes.data || []).length === 3000) console.warn('[sdr/call-queue] gong_call_analyses hit the 3000-row cap — some accounts may show a stale/absent last-contact date.');
  let accounts = (acctRes.data || []).filter(a => !CLOSED.has(a.stage) && a.tier !== 'archived');
  // "mine" filters to the rep's accounts. If we do not even know their name (no profile),
  // fall through to the full active list rather than silently emptying the queue.
  if (scope === 'mine' && profile?.full_name) {
    accounts = accounts.filter(a => ownsAccount(a, profile));
  }

  // last call date + latest icp_score per account
  const lastCall = {}, icp = {};
  for (const c of (callsRes.data || [])) {
    if (!lastCall[c.account_id]) { lastCall[c.account_id] = c.call_date; icp[c.account_id] = c.analysis?.icp_score ?? null; }
  }

  // latest logged outreach touch per account — so a worked account de-prioritizes instead of
  // re-surfacing at the top labeled "never contacted". Degrades to empty if sdr_touches is
  // not migrated yet (same fail-soft as the touchesToday count below).
  const lastTouch = {};
  try {
    const { data: touchRows } = await db.from('sdr_touches')
      .select('account_id, touched_at').not('account_id', 'is', null)
      .order('touched_at', { ascending: false }).limit(3000);
    for (const t of (touchRows || [])) { if (!lastTouch[t.account_id]) lastTouch[t.account_id] = t.touched_at; }
  } catch { /* table not migrated */ }

  const now = Date.now();
  const daysSince = d => d ? Math.floor((now - new Date(d).getTime()) / 86400000) : null;
  const mostRecent = (...ds) => {
    const ts = ds.filter(Boolean).map(d => new Date(d).getTime()).filter(t => !isNaN(t));
    return ts.length ? new Date(Math.max(...ts)).toISOString() : null;
  };

  const ranked = accounts.map(a => {
    const ds = daysSince(mostRecent(lastCall[a.id], lastTouch[a.id])); // null = no call AND no logged touch
    const recencyPts = ds == null ? 45 : Math.min(ds, 45);
    const stagePts = STAGE_POINTS[a.stage] ?? 8;
    const icpScore = icp[a.id];
    const icpPts = icpScore != null ? Math.round((icpScore / 10) * 25) : 5; // unknown ICP treated as weak fit, not neutral
    const tierPts = a.tier === 'hot' ? 10 : a.tier === 'active' ? 5 : 0;
    const score = recencyPts + stagePts + icpPts + tierPts;

    const reasonBits = [];
    if (ds == null) reasonBits.push('never contacted');
    else if (ds >= 30) reasonBits.push(`${ds}d cold`);
    else if (ds >= 14) reasonBits.push(`${ds}d since last touch`);
    if (icpScore != null && icpScore >= 7) reasonBits.push(`strong ICP fit (${icpScore}/10)`);
    if (a.tier === 'hot') reasonBits.push('hot tier');
    const channel = ds == null || (ds != null && ds >= 21) ? 'call' : 'email';

    return {
      accountId: a.id, name: a.name, stage: a.stage, tier: a.tier, owner: a.owner_name || null,
      vertical: a.vertical || null, daysSinceContact: ds, icpScore: icpScore ?? null,
      score, channel, why: reasonBits.length ? reasonBits.join(' · ') : 'due for a touch',
    };
  }).sort((x, y) => y.score - x.score).slice(0, 40);

  // Today's logged touches for THIS rep (degrades to 0 if the sdr_touches table isn't migrated).
  // Always rep-scoped: the daily target/bar is per-rep, and the frontend's optimistic bump is
  // per-user, so a team-wide count under "all" would mismatch the bump and peg the bar at 100%.
  let touchesToday = 0;
  try {
    const { count } = await db.from('sdr_touches').select('id', { count: 'exact', head: true })
      .gte('touched_at', startOfEtDay().toISOString()).eq('rep_id', user.id);
    touchesToday = count || 0;
  } catch { /* table not migrated */ }

  return apiSuccess(res, { queue: ranked, scope, target, touchesToday, generatedAt: new Date().toISOString() });
}
