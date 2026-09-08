// GET /api/gong/best-calls — a "learn from the best" library built from the scores the engine
// already computes (PLATFORM_REVIEW §7.2). Ranks recent sales calls by a composite of discovery,
// pain depth, champion health, and whether a next step was secured.
import { createServerSupabaseClient, getSupabase } from '../../../lib/supabase';
import { apiError, apiSuccess, logRequest } from '../../../lib/apiUtils';

export default async function handler(req, res) {
  logRequest(req, 'gong/best-calls');
  if (req.method !== 'GET') return apiError(res, 405, 'GET only');
  const auth = createServerSupabaseClient(req, res);
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return apiError(res, 401, 'Unauthorized');

  const db = getSupabase();
  const rep = req.query.rep || null;
  const since = new Date(Date.now() - 180 * 86400000).toISOString();
  let q = db.from('gong_call_analyses')
    .select('gong_call_id, title, rep_name, call_date, analysis, account_id, gong_url')
    .gte('call_date', since).eq('ignored', false).not('analyzed_at', 'is', null)
    .or('call_category.is.null,call_category.not.in.(cs,internal)').limit(1200);
  if (rep) q = q.ilike('rep_name', `%${rep}%`);
  const { data } = await q;

  const scored = (data || []).map((c) => {
    const a = c.analysis || {};
    const discovery = Number(a.discovery_score) || 0;
    const pain = Number(a.pain_depth_score) || 0;
    const champion = Number(a.champion_health_score) || 0;
    const nextStep = (a.next_steps_mentioned || []).length ? 1 : 0;
    const composite = discovery * 4 + pain * 3 + champion * 2 + nextStep * 10;
    return {
      gongCallId: c.gong_call_id, title: c.title || 'Untitled', rep: c.rep_name, date: c.call_date,
      accountId: c.account_id, gongUrl: c.gong_url, discovery, pain, champion, composite,
      why: a.summary ? String(a.summary).slice(0, 180) : null,
    };
  }).filter((c) => c.discovery >= 7 || c.composite >= 45)
    .sort((x, y) => y.composite - x.composite)
    .slice(0, 20);

  return apiSuccess(res, { calls: scored });
}
