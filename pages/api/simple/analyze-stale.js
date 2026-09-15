// POST /api/simple/analyze-stale
// Keeps the deal view instant: finds working-stage deals whose MEDDPICC read is missing or
// stale and runs /api/simple/gaps for a batch of them. Runs nightly after the HubSpot sync
// (which is what moves stages), so a deal that entered a live stage yesterday is already
// analysed by the time an AE opens it.
//
// Stale means: never analysed, OR analysed before the deal last ENTERED its current stage
// (so a deal that left and came back is re-done), OR a new conversation has landed since.
//
// Secured by CRON_SECRET — this spends Anthropic credits.

import { getSupabase } from '../../../lib/supabase';
import { WORKING_STAGE_IDS } from '../../../lib/constants';
import { ANALYSIS_VERSION } from '../../../lib/meddpicc';

export const config = { maxDuration: 300 };

const BATCH = 6;       // each deal is one Sonnet pass over its transcripts
const CONCURRENCY = 3;

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).end();
  const secret = (process.env.CRON_SECRET || '').trim();
  if (!secret) return res.status(503).json({ error: 'CRON_SECRET not configured' });
  if (req.headers['authorization'] !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' });

  const limit = Math.min(parseInt(req.query.limit, 10) || BATCH, 25);
  const baseUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'http://localhost:3000';

  try {
    const db = getSupabase();

    // Company-grained, live stages only.
    const { data: deals, error } = await db
      .from('accounts')
      .select('id, name, stage, meddicc')
      .in('stage', WORKING_STAGE_IDS)
      .is('parent_account_id', null)
      .limit(1000);
    if (error) throw new Error(error.message);
    if (!deals?.length) return res.status(200).json({ analyzed: 0, remaining: 0, message: 'No live deals' });

    const ids = deals.map((d) => d.id);

    // Latest entry into each deal's CURRENT stage.
    const enteredAt = {};
    for (let i = 0; i < ids.length; i += 200) {
      const { data: hist } = await db
        .from('account_stage_history')
        .select('account_id, to_stage, changed_at')
        .in('account_id', ids.slice(i, i + 200))
        .order('changed_at', { ascending: false })
        .limit(5000);
      for (const h of hist || []) {
        const key = `${h.account_id}:${h.to_stage}`;
        if (!enteredAt[key]) enteredAt[key] = h.changed_at; // newest first, so first wins
      }
    }

    // Newest linked conversation per deal family.
    const { data: fam } = await db
      .from('accounts')
      .select('id, parent_account_id')
      .in('parent_account_id', ids)
      .limit(2000);
    const toCompany = {};
    ids.forEach((id) => { toCompany[id] = id; });
    (fam || []).forEach((k) => { toCompany[k.id] = k.parent_account_id; });

    const newestCall = {};
    const callCount = {};
    const famIds = Object.keys(toCompany);
    for (let i = 0; i < famIds.length; i += 200) {
      const { data: calls } = await db
        .from('gong_call_analyses')
        .select('account_id, call_date, transcript_text')
        .in('account_id', famIds.slice(i, i + 200))
        .eq('ignored', false)
        .not('analyzed_at', 'is', null)
        .or('call_category.is.null,call_category.neq.internal')
        .order('call_date', { ascending: false })
        .limit(5000);
      for (const c of calls || []) {
        if (!(c.transcript_text && c.transcript_text.length > 50)) continue;
        const owner = toCompany[c.account_id];
        if (!owner) continue;
        callCount[owner] = (callCount[owner] || 0) + 1;
        if (!newestCall[owner] || new Date(c.call_date) > new Date(newestCall[owner])) newestCall[owner] = c.call_date;
      }
    }

    const stale = deals.filter((d) => {
      if (!callCount[d.id]) return false; // nothing to analyse
      const meta = d.meddicc?._meta;
      if (!meta) return true;
      if (meta.version !== ANALYSIS_VERSION) return true; // judged by older rules
      if (meta.stage !== d.stage) return true;
      if (meta.newestCall !== newestCall[d.id]) return true;
      if (meta.callCount !== callCount[d.id]) return true;
      const entered = enteredAt[`${d.id}:${d.stage}`];
      if (entered && new Date(meta.analyzedAt) < new Date(entered)) return true;
      return false;
    });

    const batch = stale.slice(0, limit);
    const results = [];
    for (let i = 0; i < batch.length; i += CONCURRENCY) {
      await Promise.all(batch.slice(i, i + CONCURRENCY).map(async (d) => {
        try {
          const r = await fetch(`${baseUrl}/api/simple/gaps?id=${d.id}&refresh=1`);
          const j = await r.json().catch(() => ({}));
          results.push({ deal: d.name, status: j.status || 'error', captured: j.capturedCount ?? null });
        } catch (e) {
          results.push({ deal: d.name, status: 'error', error: e.message });
        }
      }));
    }

    return res.status(200).json({
      liveDeals: deals.length,
      stale: stale.length,
      analyzed: results.filter((r) => r.status === 'ok').length,
      remaining: Math.max(0, stale.length - batch.length),
      results,
    });
  } catch (e) {
    console.error('[simple/analyze-stale]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
