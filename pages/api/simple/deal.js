// GET /api/simple/deal?id=<accountId>
// One deal: the company row, its nested child deal-rows, and every conversation rolled up
// across the family — transcripts read straight from Supabase (gong_call_analyses.transcript_text),
// not the Gong API.
//
// No auth (wide-open internal page) — service-role reads only.

import { getSupabase } from '../../../lib/supabase';
import { aggregateMeddpicc } from '../../../lib/meddpicc';
import { criteriaForStage, goalForStage, stageProcessLabel } from '../../../lib/stageExitCriteria';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'id required' });

  try {
    const db = getSupabase();

    const { data: deal, error: dealErr } = await db
      .from('accounts')
      .select('id, name, stage, owner_name, deal_value, close_date, vertical, parent_account_id, is_master, hubspot_deal_id, meddicc, stage_exit_criteria, risk_score, risk_factors')
      .eq('id', id)
      .maybeSingle();
    if (dealErr) throw new Error(dealErr.message);
    if (!deal) return res.status(404).json({ error: 'Deal not found' });

    // Family rollup: a merged company keeps its calls on the child deal-rows, so the company
    // view must union self + root + all siblings. Same pattern as gong/account-calls.
    const rootId = deal.parent_account_id || deal.id;
    const { data: kids } = await db
      .from('accounts')
      .select('id, name, stage, deal_value, close_date, owner_name, hubspot_deal_id')
      .eq('parent_account_id', rootId);
    const children = (kids || []).filter((k) => k.id !== deal.id);
    const familyIds = [...new Set([deal.id, rootId, ...(kids || []).map((k) => k.id)])];

    const { data: rows, error: callErr } = await db
      .from('gong_call_analyses')
      .select('gong_call_id, account_id, title, rep_name, call_date, duration_seconds, gong_url, analysis, transcript_text, call_category, analyzed_at')
      .in('account_id', familyIds)
      .eq('ignored', false)
      .or('call_category.is.null,call_category.neq.internal')
      .order('call_date', { ascending: false })
      .limit(100);
    if (callErr) throw new Error(callErr.message);

    const calls = (rows || []).map((r) => {
      const a = r.analysis || {};
      const pending = !r.analyzed_at;
      return {
        id: r.gong_call_id,
        title: r.title || null,
        date: r.call_date || null,
        repName: r.rep_name || null,
        durationMinutes: r.duration_seconds ? Math.round(r.duration_seconds / 60) : null,
        gongUrl: r.gong_url || null,
        category: r.call_category || null,
        pending,
        summary: pending ? null : (a.summary || null),
        nextSteps: pending ? [] : (a.next_steps_mentioned || []),
        commitments: pending ? [] : (a.commitments || []),
        redFlags: pending ? [] : (a.red_flags || a.redFlags || []),
        hasTranscript: !!(r.transcript_text && r.transcript_text.length > 50),
        transcriptText: r.transcript_text || null,
      };
    });

    // What we can show instantly from stored data. Usually sparse — most of the corpus was
    // analysed before MEDDICC extraction existed — so the UI then calls /api/simple/gaps,
    // which extracts from the transcripts and writes results back onto the account.
    const meddpicc = aggregateMeddpicc(deal, rows || []);

    const savedChecks = (deal.stage_exit_criteria || {})[deal.stage] || {};
    const stageExit = criteriaForStage(deal.stage).map((c) => ({
      ...c,
      manuallyChecked: !!savedChecks[c.id],
    }));

    return res.status(200).json({
      deal: {
        id: deal.id,
        name: deal.name,
        stage: deal.stage,
        owner: deal.owner_name || null,
        dealValue: deal.deal_value ?? null,
        closeDate: deal.close_date || null,
        vertical: deal.vertical || null,
        hubspotDealId: deal.hubspot_deal_id || null,
        riskScore: deal.risk_score ?? null,
        riskFactors: deal.risk_factors || null,
      },
      children: children.map((k) => ({
        id: k.id,
        name: k.name,
        stage: k.stage,
        dealValue: k.deal_value ?? null,
        closeDate: k.close_date || null,
        owner: k.owner_name || null,
      })),
      calls,
      callCount: calls.length,
      meddpicc,
      stageExit,
      stageGoal: goalForStage(deal.stage),
      stageLabel: stageProcessLabel(deal.stage),
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[simple/deal]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
