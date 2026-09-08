// GET /api/gong/rep-coaching-trend?repName=X&weeks=12
// Returns time-bucketed coaching metrics for a rep (discovery score, talk ratio, next-step rate).
// Groups calls into 2-week buckets for trend visualization.

import { createServerSupabaseClient, getSupabase } from '../../../lib/supabase';
import { apiError, apiSuccess, logRequest } from '../../../lib/apiUtils';

function avg(arr) {
  if (!arr.length) return null;
  return Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10;
}

export default async function handler(req, res) {
  logRequest(req, 'gong/rep-coaching-trend');
  if (req.method !== 'GET') return apiError(res, 405, 'GET only');

  const auth = createServerSupabaseClient(req, res);
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return apiError(res, 401, 'Unauthorized');

  const { repName, weeks = '12' } = req.query;
  if (!repName) return apiError(res, 400, 'repName required');

  const totalWeeks = parseInt(weeks, 10) || 12;
  const lookback = new Date(Date.now() - totalWeeks * 7 * 86400000).toISOString();

  const db = getSupabase();

  const { data: calls, error } = await db
    .from('gong_call_analyses')
    .select('call_date, analysis, rep_email, rep_name')
    .gte('call_date', lookback)
    .not('analyzed_at', 'is', null)
    .not('ignored', 'is', true)
    .or('call_category.is.null,call_category.not.in.(cs,internal)')
    .ilike('rep_name', `%${repName.split(' ')[0]}%`)
    .order('call_date', { ascending: true });

  if (error) return apiError(res, 500, error.message);

  const repCalls = calls || [];

  if (!repCalls.length) {
    return apiSuccess(res, { buckets: [], repName, totalCalls: 0 });
  }

  // Group into 2-week buckets
  const bucketSizeMs = 14 * 86400000;
  const now = Date.now();
  const numBuckets = Math.ceil(totalWeeks / 2);
  const buckets = [];

  for (let i = numBuckets - 1; i >= 0; i--) {
    const bucketEnd = now - i * bucketSizeMs;
    const bucketStart = bucketEnd - bucketSizeMs;

    const bucketCalls = repCalls.filter(c => {
      const t = new Date(c.call_date).getTime();
      return t >= bucketStart && t < bucketEnd;
    });

    const label = new Date(bucketEnd).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

    if (bucketCalls.length === 0) {
      buckets.push({ label, callCount: 0, discoveryScore: null, talkRatio: null, nextStepRate: null, champHealthScore: null });
      continue;
    }

    const discoveryScores = bucketCalls.map(c => c.analysis?.discovery_score).filter(v => v != null);
    const talkRatios = bucketCalls.map(c => c.analysis?.rep_talk_ratio).filter(v => v != null);
    const nextStepCalls = bucketCalls.filter(c => c.analysis?.next_steps_mentioned?.length > 0).length;
    const champScores = bucketCalls.map(c => c.analysis?.champion_health_score).filter(v => v != null);

    buckets.push({
      label,
      callCount: bucketCalls.length,
      discoveryScore: avg(discoveryScores),
      talkRatio: avg(talkRatios),
      nextStepRate: bucketCalls.length > 0 ? Math.round((nextStepCalls / bucketCalls.length) * 100) : null,
      champHealthScore: avg(champScores),
    });
  }

  return apiSuccess(res, {
    buckets,
    repName,
    totalCalls: repCalls.length,
  });
}
