// GET /api/simple/deals
// The deal picker list: one row per COMPANY (parent_account_id IS NULL), every stage loaded,
// with call activity and MEDDPICC completeness rolled up across each company's child
// deal-rows. The UI hides dead stages by default (see DEFAULT_HIDDEN_STAGES).
//
// No auth. The 2026-09 reset made this a wide-open internal page, so every read goes through
// the service-role client — `accounts` has RLS on and an anonymous browser client reads ZERO
// rows, which is why the browser must never query it directly.

import { getSupabase } from '../../../lib/supabase';
import { MEDDPICC_KEYS, readValue } from '../../../lib/meddpicc';

const PAGE = 1000; // accounts is >1,000 rows — an unbounded select silently truncates A-Z

// Dead/dormant by default. "Churned" is not its own stage — HubSpot maps it into closed_lost
// (see STAGE_MAP in pages/api/hubspot/sync-deals.js).
export const DEFAULT_HIDDEN_STAGES = [
  'inactive_sdr_follow_up',
  'inactive_ae_follow_up',
  'closed_won',
  'closed_lost',
];

async function fetchAllAccounts(db, applyFilters) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    let q = db
      .from('accounts')
      .select('id, name, stage, owner_name, deal_value, close_date, parent_account_id, vertical, meddicc')
      .range(from, from + PAGE - 1);
    q = applyFilters ? applyFilters(q) : q;
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    if (!data || !data.length) break;
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

function closeQuarter(closeDate) {
  if (!closeDate) return null;
  const d = new Date(closeDate);
  if (isNaN(d)) return null;
  return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  try {
    const db = getSupabase();

    // Every account row, all stages. The list is company-grained; child deal-rows only
    // contribute their call history to the parent.
    const all = await fetchAllAccounts(db);
    const companies = all.filter((a) => !a.parent_account_id);
    if (!companies.length) {
      return res.status(200).json({ deals: [], total: 0, filters: {}, defaultHiddenStages: DEFAULT_HIDDEN_STAGES });
    }

    const toCompany = {};
    companies.forEach((c) => { toCompany[c.id] = c.id; });
    const childCount = {};
    all.forEach((a) => {
      if (!a.parent_account_id) return;
      toCompany[a.id] = a.parent_account_id;
      childCount[a.parent_account_id] = (childCount[a.parent_account_id] || 0) + 1;
    });

    // Light call rollup — just enough for "how many" and "how recently". Deliberately does
    // NOT pull the analysis blob; MEDDPICC comes from accounts.meddicc, which the deal-level
    // extractor (/api/simple/gaps) writes back as deals get opened.
    const byCompany = {};
    const ids = Object.keys(toCompany);
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await db
        .from('gong_call_analyses')
        .select('account_id, call_date')
        .in('account_id', ids.slice(i, i + 200))
        .eq('ignored', false)
        .not('analyzed_at', 'is', null)
        .or('call_category.is.null,call_category.neq.internal')
        .order('call_date', { ascending: false })
        .limit(5000);
      if (error) throw new Error(error.message);
      for (const c of data || []) {
        const owner = toCompany[c.account_id];
        if (!owner) continue;
        const cur = (byCompany[owner] ||= { count: 0, last: null });
        cur.count += 1;
        if (!cur.last || new Date(c.call_date) > new Date(cur.last)) cur.last = c.call_date;
      }
    }

    const deals = companies.map((c) => {
      const roll = byCompany[c.id] || { count: 0, last: null };
      const m = c.meddicc || {};
      return {
        id: c.id,
        name: c.name,
        stage: c.stage,
        owner: c.owner_name || null,
        dealValue: c.deal_value ?? null,
        closeDate: c.close_date || null,
        closeQuarter: closeQuarter(c.close_date),
        vertical: c.vertical || null,
        childDealCount: childCount[c.id] || 0,
        callCount: roll.count,
        lastCallDate: roll.last,
        meddpiccCaptured: MEDDPICC_KEYS.filter((k) => readValue(m[k])).length,
        meddpiccTotal: MEDDPICC_KEYS.length,
      };
    });

    deals.sort((a, b) => {
      if (!a.lastCallDate && !b.lastCallDate) return (a.name || '').localeCompare(b.name || '');
      if (!a.lastCallDate) return 1;
      if (!b.lastCallDate) return -1;
      return new Date(b.lastCallDate) - new Date(a.lastCallDate);
    });

    const uniqSorted = (vals) => [...new Set(vals.filter(Boolean))].sort();
    return res.status(200).json({
      deals,
      total: deals.length,
      defaultHiddenStages: DEFAULT_HIDDEN_STAGES,
      filters: {
        owners: uniqSorted(deals.map((d) => d.owner)),
        stages: uniqSorted(deals.map((d) => d.stage)),
        quarters: uniqSorted(deals.map((d) => d.closeQuarter)),
        unassignedCount: deals.filter((d) => !d.owner).length,
      },
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[simple/deals]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
