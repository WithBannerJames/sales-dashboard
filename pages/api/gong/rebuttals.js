// GET /api/gong/rebuttals — objection & rebuttal library (PLATFORM_REVIEW §7.5). Aggregates the
// objections the analyzer already extracts across recent calls, grouped by category, with real
// example handling (the rep_response that was captured) so reps can study how objections get
// answered. Grounded in actual calls, not invented.
import { createServerSupabaseClient, getSupabase } from '../../../lib/supabase';
import { apiError, apiSuccess, logRequest } from '../../../lib/apiUtils';

export default async function handler(req, res) {
  logRequest(req, 'gong/rebuttals');
  if (req.method !== 'GET') return apiError(res, 405, 'GET only');
  const auth = createServerSupabaseClient(req, res);
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return apiError(res, 401, 'Unauthorized');

  const db = getSupabase();
  const since = new Date(Date.now() - 180 * 86400000).toISOString();
  const { data } = await db.from('gong_call_analyses')
    .select('analysis, rep_name, call_date')
    .gte('call_date', since).or('call_category.is.null,call_category.not.in.(cs,internal)').not('analyzed_at', 'is', null)
    .limit(1500);

  const map = {};
  for (const c of data || []) {
    for (const o of (c.analysis?.objections || [])) {
      if (!o || typeof o !== 'object') continue;
      const cat = (o.category || 'other').toLowerCase();
      const text = (o.text || '').trim();
      const resp = (o.rep_response || '').trim();
      if (!text) continue;
      if (!map[cat]) map[cat] = { category: cat, count: 0, examples: [] };
      map[cat].count++;
      if (resp && map[cat].examples.length < 3) {
        map[cat].examples.push({ objection: text.slice(0, 160), response: resp.slice(0, 260), rep: c.rep_name || null });
      }
    }
  }
  const rebuttals = Object.values(map).sort((a, b) => b.count - a.count).slice(0, 8);
  return apiSuccess(res, { rebuttals });
}
