// GET /api/accounts/timeline?accountId= — unified account activity feed (PLATFORM_REVIEW §1.3).
// Unions calls, stage changes, tasks, notes, and SDR touches (previously scattered, sdr_touches
// effectively write-only) into one date-sorted timeline.
import { createServerSupabaseClient, getSupabase } from '../../../lib/supabase';
import { apiError, apiSuccess, logRequest } from '../../../lib/apiUtils';
import { stageLabel } from '../../../lib/constants';

export default async function handler(req, res) {
  logRequest(req, 'accounts/timeline');
  if (req.method !== 'GET') return apiError(res, 405, 'GET only');
  const auth = createServerSupabaseClient(req, res);
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return apiError(res, 401, 'Unauthorized');
  const accountId = req.query.accountId;
  if (!accountId) return apiError(res, 400, 'accountId required');

  const db = getSupabase();
  const soft = (p) => p.then((r) => r, () => ({ data: [] }));
  const [callsRes, stageRes, tasksRes, notesRes, touchRes] = await Promise.all([
    soft(db.from('gong_call_analyses').select('title, analyzed_at, call_date, analysis, rep_name, call_category').eq('account_id', accountId).not('analyzed_at', 'is', null).or('call_category.is.null,call_category.not.in.(cs,internal)').order('analyzed_at', { ascending: false }).limit(50)),
    soft(db.from('account_stage_history').select('from_stage, to_stage, changed_at, changed_by_name').eq('account_id', accountId).order('changed_at', { ascending: false }).limit(50)),
    soft(db.from('tasks').select('title, status, created_at, completed_at').eq('account_id', accountId).order('created_at', { ascending: false }).limit(50)),
    soft(db.from('notes').select('content, created_at').eq('account_id', accountId).order('created_at', { ascending: false }).limit(30)),
    soft(db.from('sdr_touches').select('touch_type, outcome, touched_at').eq('account_id', accountId).order('touched_at', { ascending: false }).limit(50)),
  ]);

  const events = [];
  for (const c of callsRes.data || []) events.push({ type: 'call', ts: c.call_date || c.analyzed_at, title: c.title || 'Call analyzed', detail: (c.analysis?.summary || '').slice(0, 180), actor: c.rep_name || null });
  for (const s of stageRes.data || []) events.push({ type: 'stage_change', ts: s.changed_at, title: `${s.from_stage ? stageLabel(s.from_stage) + ' → ' : ''}${stageLabel(s.to_stage)}`, actor: s.changed_by_name || null });
  for (const t of tasksRes.data || []) events.push({ type: t.completed_at ? 'task_done' : 'task', ts: t.completed_at || t.created_at, title: t.title, detail: t.completed_at ? 'Completed' : t.status });
  for (const n of notesRes.data || []) events.push({ type: 'note', ts: n.created_at, title: 'Note', detail: (n.content || '').slice(0, 180) });
  for (const th of touchRes.data || []) events.push({ type: 'touch', ts: th.touched_at, title: `${th.touch_type}${th.outcome ? ' · ' + th.outcome : ''}`, detail: 'Outreach touch' });

  events.sort((a, b) => new Date(b.ts || 0) - new Date(a.ts || 0));
  return apiSuccess(res, { events: events.slice(0, 120) });
}
