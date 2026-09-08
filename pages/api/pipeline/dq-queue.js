// GET /api/pipeline/dq-queue — the disqualification-discipline queue (PLATFORM_REVIEW §8.4).
// Surfaces active deals that are limping along: the last call raised a disqualification signal
// (soft close, no committed next step) OR there's been no call in 30+ days. These need an explicit
// advance-or-kill decision instead of sitting in the pipeline forever.
import { createServerSupabaseClient, getSupabase } from '../../../lib/supabase';
import { apiError, apiSuccess, logRequest } from '../../../lib/apiUtils';
import { ACTIVE_STAGE_ORDER, STAGE_LABELS } from '../../../lib/constants';

export default async function handler(req, res) {
  logRequest(req, 'pipeline/dq-queue');
  if (req.method !== 'GET') return apiError(res, 405, 'GET only');
  const auth = createServerSupabaseClient(req, res);
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return apiError(res, 401, 'Unauthorized');

  const db = getSupabase();
  const [acctRes, callsRes] = await Promise.all([
    db.from('accounts').select('id, name, stage, owner_name, deal_value').limit(2000),
    db.from('gong_call_analyses').select('account_id, analysis, call_date').or('call_category.is.null,call_category.not.in.(cs,internal)').not('analyzed_at', 'is', null).order('call_date', { ascending: false }).limit(4000),
  ]);
  const ACTIVE = new Set(ACTIVE_STAGE_ORDER);
  const latest = {};
  for (const c of callsRes.data || []) if (!latest[c.account_id]) latest[c.account_id] = { analysis: c.analysis, date: c.call_date };

  const deals = (acctRes.data || [])
    .filter((a) => ACTIVE.has(a.stage))
    .map((a) => {
      const l = latest[a.id];
      const dqSignal = l?.analysis?.disqualification_signal === true;
      const days = l?.date ? Math.floor((Date.now() - new Date(l.date).getTime()) / 86400000) : null;
      let reason = null;
      if (dqSignal) reason = l?.analysis?.disqualification_notes || 'Last call ended with a soft, non-committal close (no clear next step).';
      else if (days == null) reason = 'No analyzed call on record.';
      else if (days >= 30) reason = `${days} days since the last call — no forward motion.`;
      return { id: a.id, name: a.name, stage: a.stage, stageLabel: STAGE_LABELS[a.stage] || a.stage, owner: a.owner_name, dealValue: a.deal_value, dqSignal, daysSinceCall: days, reason };
    })
    .filter((a) => a.dqSignal || a.daysSinceCall == null || a.daysSinceCall >= 30)
    .sort((x, y) => (y.dqSignal ? 1 : 0) - (x.dqSignal ? 1 : 0) || (y.daysSinceCall || 0) - (x.daysSinceCall || 0))
    .slice(0, 50);

  return apiSuccess(res, { deals, count: deals.length });
}
