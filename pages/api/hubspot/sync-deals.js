// POST /api/hubspot/sync-deals
// Creates/upserts Supabase accounts from HubSpot deals (Sales Opportunities pipeline).
// HubSpot is source of truth for deal metadata — runs nightly and on-demand from Settings.
// Owner mapping: James's HubSpot owner ID → his Supabase UUID. Others stored by name only.

import { apiError, apiSuccess, logRequest } from '../../../lib/apiUtils';
import { createServerSupabaseClient, getSupabase } from '../../../lib/supabase';
import { recordStageChange } from '../../../lib/stageHistory';

const HS_API_BASE = 'https://api.hubapi.com';
const SALES_PIPELINE_ID = '663206213';

const STAGE_MAP = {
  '973866334':  'inactive_sdr_follow_up',   // Pre Pursuit
  '1268649029': 'inactive_sdr_follow_up', // Inactive Pursuit - SDR Follow Up
  '973866335':  'inactive_ae_follow_up',  // Inactive Pursuit - AE Follow Up
  '973866336':  'active_pursuit',         // Active Pursuit
  '973866337':  'qualifying',             // Qualify
  '973866339':  'solution_validation',    // Solution Validation
  '973818959':  'proposal',               // Proposal
  '973818960':  'legal',                  // Legal
  '973818961':  'closed_won',             // Close Won
  '973818962':  'closed_lost',            // Closed Lost - DQ
  '974622038':  'closed_lost',            // Churned
  'closedlost': 'closed_lost',            // Closed Lost - Remarketing
  '159786509':  'closed_lost',            // Closed Lost - AE Follow Up
  '133539465':  'closed_lost',            // Disqualified - Will Never Be a Deal
  '147472456':  'qualifying',             // Intro Call - No Show/Rescheduling
  '1176174939': 'inactive_sdr_follow_up', // Connected - Re-engage
  '1176174940': 'closed_lost',            // Connected - DQ
};

// Add entries here as reps sign up to the platform
const OWNER_USER_MAP = {
  '355982922': '8c969178-4d4e-494f-a8d7-752276fb683c', // James Lindberg
};

// Fallback overrides only. Owner names are read live from HubSpot (fetchOwnerNames) — this
// map used to be the ONLY source, so any deal owned by someone not listed here landed with
// owner_name = null (344 accounts, 2026-09).
const OWNER_NAMES = {
  '355982922': 'James Lindberg',
  '587669685': 'Logan King',
  '402320791': 'Mark Murphy',
  '83834887':  'Tony Alic',
  '40554838':  'Justin Goodkind',
  '75421653':  'Jovan Arsovski',
};

// HubSpot owner id -> display name, straight from the CRM so new reps need no code change.
async function fetchOwnerNames(key) {
  const names = {};
  let after = null;
  let pages = 0;
  do {
    const url = `${HS_API_BASE}/crm/v3/owners?limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
    if (!r.ok) break; // non-fatal: fall back to the static map below
    const d = await r.json().catch(() => ({}));
    for (const o of (d.results || [])) {
      const full = [o.firstName, o.lastName].filter(Boolean).join(' ').trim();
      if (o.id && (full || o.email)) names[String(o.id)] = full || o.email;
    }
    after = d.paging?.next?.after || null;
    pages++;
  } while (after && pages < 20);
  return names;
}

function cleanDealName(raw) {
  return (raw || '').replace(/\s*-\s*New Deal\s*$/i, '').trim()
}

// Fetch every deal in the sales pipeline.
//
// Two bugs used to make this silently return a PARTIAL list, which is worse than failing:
// upserting a subset looks identical to a complete sync, so every deal on a dropped page
// kept its last-known stage forever. That is how a closed MAA deal sat in Proposal for five
// weeks, and why 33 of 142 "live" deals were frozen (13 at the same timestamp — one dropped
// page, not 13 deletions).
//   1. `if (!r.ok) break` swallowed rate limits and transient 5xx. Now retried, then thrown.
//   2. No sort on a paginated /search. HubSpot requires a stable sort for reliable paging;
//      without one records are skipped between pages.
async function fetchAllDeals(key) {
  const deals = [];
  let after = null;
  let pages = 0;

  do {
    const body = {
      filterGroups: [{
        filters: [{ propertyName: 'pipeline', operator: 'EQ', value: SALES_PIPELINE_ID }],
      }],
      // Stable pagination — without this, paging over /search can skip records.
      sorts: [{ propertyName: 'hs_object_id', direction: 'ASCENDING' }],
      properties: ['dealname', 'amount', 'dealstage', 'closedate', 'hubspot_owner_id'],
      limit: 100,
      ...(after ? { after } : {}),
    };

    let d = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await fetch(`${HS_API_BASE}/crm/v3/objects/deals/search`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (r.ok) { d = await r.json().catch(() => null); break; }
      // 429 (search is rate-limited hard) and 5xx are worth retrying; 4xx is not.
      if (r.status !== 429 && r.status < 500) {
        const detail = await r.text().catch(() => '');
        throw new Error(`HubSpot deal search failed: ${r.status} ${detail.slice(0, 200)}`);
      }
      await new Promise((res) => setTimeout(res, 500 * 2 ** attempt));
    }
    if (!d) throw new Error(`HubSpot deal search failed after retries on page ${pages + 1} — refusing to sync a partial deal list`);

    deals.push(...(d.results || []));
    after = d.paging?.next?.after || null;
    pages++;
    if (after) await new Promise((res) => setTimeout(res, 120)); // stay under the search rate limit
  } while (after && pages < 100);

  if (after) throw new Error(`HubSpot returned more than ${pages} pages — refusing to sync a partial deal list`);

  console.log(`[hubspot/sync-deals] fetched ${deals.length} deals across ${pages} pages`);
  return deals;
}

export default async function handler(req, res) {
  logRequest(req, 'hubspot/sync-deals');
  if (req.method !== 'POST') return apiError(res, 405, 'Method not allowed');

  const isCron = process.env.CRON_SECRET && req.headers['authorization'] === `Bearer ${process.env.CRON_SECRET}`;
  if (!isCron) {
    const authClient = createServerSupabaseClient(req, res);
    const { data: { user } } = await authClient.auth.getUser();
    if (!user) return apiError(res, 401, 'Unauthorized');
  }

  const hsKey = process.env.HUBSPOT_API_KEY;
  if (!hsKey) return apiError(res, 500, 'HUBSPOT_API_KEY not configured');

  const db = getSupabase();
  const deals = await fetchAllDeals(hsKey);
  if (!deals.length) return apiError(res, 502, 'No deals returned from HubSpot');

  const now = new Date().toISOString();

  // Snapshot current stage per existing account so we can record HubSpot-driven moves into
  // account_stage_history — previously these went straight through .upsert() and bypassed every
  // history writer, so the funnel never saw the vast majority of real transitions (§6/§8).
  const dealIds = deals.map(d => d.id);
  const existingByDeal = {};
  for (let i = 0; i < dealIds.length; i += 200) {
    const { data: ex } = await db.from('accounts')
      .select('id, stage, hubspot_deal_id')
      .in('hubspot_deal_id', dealIds.slice(i, i + 200));
    for (const a of (ex || [])) existingByDeal[a.hubspot_deal_id] = a;
  }
  const stageChanges = [];
  for (const deal of deals) {
    const stageId = deal.properties?.dealstage || null;
    const newStage = stageId ? (STAGE_MAP[stageId] || 'qualifying') : 'qualifying';
    const ex = existingByDeal[deal.id];
    if (ex && ex.stage && ex.stage !== newStage) {
      stageChanges.push({
        accountId: ex.id, fromStage: ex.stage, toStage: newStage,
        dealValue: deal.properties?.amount ? parseFloat(deal.properties.amount) : null,
      });
    }
  }

  // Live owner directory, with the static map as an override/fallback.
  const ownerNames = { ...(await fetchOwnerNames(hsKey)), ...OWNER_NAMES };

  const rows = deals.map(deal => {
    const ownerId = deal.properties?.hubspot_owner_id || null;
    const stageId  = deal.properties?.dealstage || null;
    const rawAmount = deal.properties?.amount;
    const rawClose  = deal.properties?.closedate;

    return {
      name:              cleanDealName(deal.properties?.dealname || '') || `Deal ${deal.id}`,
      hubspot_deal_id:   deal.id,
      hubspot_stage:     stageId,
      hubspot_owner_id:  ownerId,
      owner_name:        ownerId ? (ownerNames[ownerId] || null) : null,
      user_id:           ownerId ? (OWNER_USER_MAP[ownerId] || null) : null,
      stage:             stageId ? (STAGE_MAP[stageId] || 'qualifying') : 'qualifying',
      deal_value:        rawAmount ? parseFloat(rawAmount) : null,
      close_date:        rawClose ? rawClose.split('T')[0] : null,
      hubspot_synced_at: now,
    };
  });

  let synced = 0;
  let errors = 0;
  for (let i = 0; i < rows.length; i += 100) {
    const { error } = await db
      .from('accounts')
      .upsert(rows.slice(i, i + 100), { onConflict: 'hubspot_deal_id' });
    if (error) {
      console.error('[hubspot/sync-deals] upsert error:', error.message);
      errors++;
    } else {
      synced += rows.slice(i, i + 100).length;
    }
  }

  // Record the detected stage moves (best-effort, never blocks the sync).
  for (const ch of stageChanges) {
    await recordStageChange(db, { ...ch, changedByName: 'HubSpot sync' });
  }

  // Regroup the company hierarchy so a newly-synced deal for an existing company becomes a CHILD of
  // that company's master instead of a new top-level duplicate (Phase 0.3 dedup prevention). Idempotent.
  await db.rpc('regroup_account_hierarchy').then(() => {}, (e) => console.error('[sync-deals] regroup error:', e?.message));

  console.log(`[hubspot/sync-deals] synced ${synced} accounts (${errors} batch errors, ${stageChanges.length} stage moves recorded)`);
  return apiSuccess(res, { synced, total: deals.length, errors, stageChanges: stageChanges.length });
}
