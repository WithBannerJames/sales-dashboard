// GET /api/gong/drills?rep= — targeted practice drills from real fumbled moments (§7.4). Finds the
// weakest dimensions across recent calls (vs. Banner's targets) and returns a focused drill for
// each, plus the actual low-scoring calls to review. Grounded in the scores the engine computes.
import { createServerSupabaseClient, getSupabase } from '../../../lib/supabase';
import { apiError, apiSuccess, logRequest } from '../../../lib/apiUtils';

const avg = (a) => (a.length ? a.reduce((s, n) => s + n, 0) / a.length : null);

// area, target, higherIsBetter, drill copy
const AREAS = [
  { key: 'discovery', label: 'Discovery depth', field: 'discovery_score', target: 6, higher: true, drill: 'Run a 10-minute discovery-only roleplay: uncover the economic buyer, the decision process, and quantified pain BEFORE any feature talk. If you catch yourself pitching, restart.' },
  { key: 'pain', label: 'Pain quantification', field: 'pain_depth_score', target: 5, higher: true, drill: 'Take your last flat-pain call and write 3 questions that would have quantified the $ impact and tied it to a named stakeholder. Use them on your next call.' },
  { key: 'champion', label: 'Champion building', field: 'champion_health_score', target: 5, higher: true, drill: 'Pick one open deal, name the most likely champion, and script exactly how you would arm them to sell Banner internally when you are not in the room.' },
  { key: 'talk', label: 'Talk ratio', field: 'rep_talk_ratio', target: 45, higher: false, drill: 'Target under 45% talk time on your next call. Ask a question, then count to three before you respond. Let the silence do the work.' },
];

export default async function handler(req, res) {
  logRequest(req, 'gong/drills');
  if (req.method !== 'GET') return apiError(res, 405, 'GET only');
  const auth = createServerSupabaseClient(req, res);
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return apiError(res, 401, 'Unauthorized');

  const db = getSupabase();
  const rep = req.query.rep || null;
  const since = new Date(Date.now() - 90 * 86400000).toISOString();
  let q = db.from('gong_call_analyses').select('gong_call_id, title, rep_name, account_id, analysis, call_date')
    .gte('call_date', since).or('call_category.is.null,call_category.not.in.(cs,internal)').not('analyzed_at', 'is', null).limit(800);
  if (rep) q = q.ilike('rep_name', `%${rep}%`);
  const { data } = await q;
  const calls = data || [];

  const drills = AREAS.map((a) => {
    const scored = calls.map((c) => ({ c, v: parseFloat(c.analysis?.[a.field]) })).filter((x) => !isNaN(x.v) && x.v > 0);
    const mean = avg(scored.map((x) => x.v));
    if (mean == null) return null;
    const below = a.higher ? mean < a.target : mean > a.target;
    if (!below) return null;
    // Worst calls on this dimension.
    const worst = [...scored].sort((x, y) => a.higher ? x.v - y.v : y.v - x.v).slice(0, 2)
      .map((x) => ({ title: x.c.title || 'Untitled', rep: x.c.rep_name, accountId: x.c.account_id, score: Math.round(x.v * 10) / 10 }));
    return { area: a.label, yourAvg: Math.round(mean * 10) / 10, target: a.target, higherIsBetter: a.higher, drill: a.drill, examples: worst };
  }).filter(Boolean).sort((x, y) => Math.abs(y.yourAvg - y.target) - Math.abs(x.yourAvg - x.target));

  return apiSuccess(res, { drills, callsAnalyzed: calls.length });
}
