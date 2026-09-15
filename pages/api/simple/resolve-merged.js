// POST /api/simple/resolve-merged
// Works out what actually happened to accounts whose HubSpot deal stopped coming back from the
// search API, and records it.
//
// The answer is almost always "merged". HubSpot excludes merged-away records from search but a
// direct GET still resolves the old id to its SURVIVOR — requesting deal 13692694838 returns id
// 63673380271. So comparing the requested id with the returned id detects a merge precisely.
// Deals don't leave HubSpot unless someone deletes them; they get merged.
//
// Sets accounts.hubspot_merged_into for merged rows, and logs one history event each so the
// timeline reads honestly. Batched — call repeatedly until remaining hits 0.
//
// Secured by CRON_SECRET (the HubSpot key is server-side only).

import { getSupabase } from '../../../lib/supabase';

export const config = { maxDuration: 300 };

const HS = 'https://api.hubapi.com';
const BATCH = 120;

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).end();
  const secret = (process.env.CRON_SECRET || '').trim();
  if (!secret) return res.status(503).json({ error: 'CRON_SECRET not configured' });
  if (req.headers['authorization'] !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' });

  const key = (process.env.HUBSPOT_API_KEY || '').trim();
  if (!key) return res.status(500).json({ error: 'HUBSPOT_API_KEY not configured' });
  const auth = { Authorization: `Bearer ${key}` };

  try {
    const db = getSupabase();
    const limit = Math.min(parseInt(req.query.limit, 10) || BATCH, 300);

    // Candidates: HubSpot-sourced, not yet resolved, and flagged as having left the pipeline.
    const { data: left } = await db
      .from('account_stage_history')
      .select('account_id')
      .eq('event_type', 'left_pipeline')
      .limit(5000);
    const leftIds = [...new Set((left || []).map((r) => r.account_id))];
    if (!leftIds.length) return res.status(200).json({ checked: 0, remaining: 0, message: 'nothing to resolve' });

    const candidates = [];
    for (let i = 0; i < leftIds.length && candidates.length < limit * 3; i += 200) {
      const { data } = await db
        .from('accounts')
        .select('id, name, stage, hubspot_deal_id, hubspot_merged_into')
        .in('id', leftIds.slice(i, i + 200))
        .is('hubspot_merged_into', null)
        .not('hubspot_deal_id', 'is', null);
      candidates.push(...(data || []));
    }
    const batch = candidates.slice(0, limit);

    let merged = 0, gone = 0, stillThere = 0, failed = 0;
    const events = [];

    for (const a of batch) {
      try {
        const r = await fetch(`${HS}/crm/v3/objects/deals/${a.hubspot_deal_id}?properties=dealname`, { headers: auth });
        if (r.status === 404) {
          gone++;
          events.push({ account_id: a.id, stage: a.stage, account_name: a.name, from_stage: a.stage, to_stage: a.stage, event_type: 'deleted_in_hubspot' });
          continue;
        }
        if (!r.ok) { failed++; continue; }
        const d = await r.json();
        const returnedId = String(d.id || '');
        if (returnedId && returnedId !== String(a.hubspot_deal_id)) {
          merged++;
          await db.from('accounts').update({ hubspot_merged_into: returnedId }).eq('id', a.id);
          events.push({ account_id: a.id, stage: a.stage, account_name: a.name, from_stage: a.stage, to_stage: a.stage, event_type: 'merged_in_hubspot', changed_by: returnedId });
        } else {
          // Still a distinct live deal — it was missing from search for some other reason.
          stillThere++;
        }
      } catch {
        failed++;
      }
      await new Promise((r2) => setTimeout(r2, 60)); // stay under HubSpot's rate limit
    }

    for (let i = 0; i < events.length; i += 200) {
      const { error } = await db.from('account_stage_history').insert(events.slice(i, i + 200));
      if (error) console.error('[resolve-merged] event insert failed:', error.message);
    }

    return res.status(200).json({
      checked: batch.length,
      merged,
      deletedInHubspot: gone,
      stillDistinct: stillThere,
      failed,
      remaining: Math.max(0, candidates.length - batch.length),
    });
  } catch (e) {
    console.error('[resolve-merged]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
