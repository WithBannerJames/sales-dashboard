import {
  apiError,
  apiSuccess,
  validateMethod,
  validateAnthropicKey,
  callAnthropic,
  parseClaudeJson,
  logRequest,
} from '../../../lib/apiUtils';
import { createServerSupabaseClient } from '../../../lib/supabase';

export default async function handler(req, res) {
  logRequest(req, 'gong/intel-aggregate');
  const db = createServerSupabaseClient(req, res);

  if (req.method === 'GET') {
    const { data: rows, error } = await db
      .from('gong_aggregate_analysis')
      .select('*')
      .order('computed_at', { ascending: false })
      .limit(2);

    if (error || !rows?.length) {
      return apiSuccess(res, { aggregate: null });
    }
    const current = rows[0];
    const prior = rows[1] || null;
    return apiSuccess(res, {
      aggregate: current.analysis,
      computedAt: current.computed_at,
      callCount: current.call_count,
      priorAggregate: prior?.analysis || null,
      priorComputedAt: prior?.computed_at || null,
    });

  } else if (req.method === 'POST') {
    const apiKey = validateAnthropicKey(res);
    if (!apiKey) return;

    const { repNames } = req.body || {};

    let query = db
      .from('gong_call_analyses')
      .select('*')
      .or('ignored.is.null,ignored.eq.false')
      .or('call_category.is.null,call_category.not.in.(cs,internal)')
      .not('analysis', 'is', null)
      .order('call_date', { ascending: false });

    if (repNames?.length) {
      query = query.in('rep_name', repNames);
    }

    const { data: rows, error } = await query;

    if (error || !rows || rows.length === 0) {
      return apiError(res, 400, 'No analyzed calls found — analyze some calls first.');
    }

    // Only include rows with actual analysis content to avoid polluting the aggregate
    const richRows = rows.filter(r => r.analysis?.summary || r.analysis?.themes?.length > 0);
    if (!richRows.length) {
      return apiError(res, 400, 'Calls have been analyzed but no content was extracted yet. Try re-analyzing some calls first.');
    }

    // Cap at 150 most recent to stay within Claude's context + output limits
    const cappedRows = richRows.slice(0, 150);

    const callSummaries = cappedRows.map(r => ({
      title: r.title,
      date: r.call_date ? new Date(r.call_date).toLocaleDateString() : null,
      rep: r.rep_name,
      type: r.call_type,
      duration_min: r.duration_seconds ? Math.round(r.duration_seconds / 60) : null,
      ...(r.analysis || {}),
    }));

    const aggregatePrompt = `You are analyzing ${cappedRows.length} sales calls for Banner, a CapEx management software company for commercial real estate. Your audience is the CEO.

Individual call analyses:
${JSON.stringify(callSummaries, null, 2)}

Return ONLY valid JSON with this aggregate analysis:
{
  "executive_summary": "One crisp sentence — the single most important thing the CEO should know. Frame as a finding with an implication. E.g. 'We're losing 40% of qualified deals to authority mismatches — reps are consistently demo-ing to the wrong person.'",
  "top_objections": [{"text": "summarized objection pattern", "count": 5, "category": "pricing|timeline|technical|authority|competition|other", "example": "verbatim example"}],
  "buyer_priorities": [{"priority": "what this buyer segment cares about, framed as their goal not our feature", "count": 14, "example": "verbatim quote or close paraphrase from a call"}],
  "loss_reasons": [{"reason": "specific, actionable reason deals go cold or are lost", "pct_of_negative_calls": 40, "example": "brief example from the calls"}],
  "competitor_mentions": [{"name": "competitor", "count": 3, "typical_context": "how they come up"}],
  "avg_rep_talk_ratio": 47,
  "avg_icp_score": 6.8,
  "avg_discovery_score": 5.4,
  "sentiment_breakdown": {"positive": 12, "neutral": 8, "negative": 5},
  "key_insights": [
    {
      "signal": "one-line data-backed finding (e.g. 'Economic buyer absent in 78% of calls')",
      "scope": "human-readable scope (e.g. '35 active deals · 4 reps' or '12 calls this period')",
      "scope_reps": ["rep name if rep-specific, else omit"],
      "recommended_action": "specific one-line action the team should take",
      "action_type": "outreach_batch_create|coaching_task_create|flag_counter_for_review|process_doc_update|assign_review_task",
      "urgency": "high|medium|low"
    }
  ],
  "win_patterns": ["pattern consistently seen in positive-sentiment calls"],
  "loss_patterns": ["pattern consistently seen in negative-sentiment calls"],
  "rep_stats": [{"rep": "name", "call_count": 5, "avg_talk_ratio": 45, "positive_pct": 60, "avg_icp_score": 7.2, "avg_discovery_score": 5.8, "top_objection": "pricing"}],
  "investor_narrative": "200-300 words covering: market validation signals (ICP fit scores, named segments closing), product-market fit indicators (positive sentiment trend, buyer themes), momentum metrics (period-over-period improvements), and any identified high-leverage interventions in progress. Frame around momentum and validation. Avoid hedging language. Always pair problem statements with interventions.",
  "weekly_actions": [
    {
      "title": "One-line action title — specific enough to act on immediately",
      "description": "1-2 sentences: what to do and why it matters right now based on the data",
      "action_type": "coaching_task_create|outreach_batch_create|process_doc_update|flag_counter_for_review",
      "urgency": "high|medium|low",
      "target_rep": "rep full name — only for coaching_task_create",
      "target_account": "company name — only for outreach_batch_create",
      "scope": "brief scope note e.g. '4 of 5 recent calls' or '3 deals at risk'"
    }
  ]
}

Return exactly 3 weekly_actions. Prioritize: (1) coaching_task_create for the highest-leverage rep coaching gap, (2) outreach_batch_create for the highest-value stalled account, (3) whichever has the most data-backed urgency. Be specific — name reps and accounts where possible.`;

    const rawAggregate = await callAnthropic(apiKey, {
      model: 'claude-sonnet-4-6',
      maxTokens: 6000,
      messages: [{ role: 'user', content: aggregatePrompt }],
    });

    const analysis = parseClaudeJson(rawAggregate, {});

    await db.from('gong_aggregate_analysis').insert({
      call_count: cappedRows.length,
      date_range_start: cappedRows[cappedRows.length - 1]?.call_date || null,
      date_range_end: cappedRows[0]?.call_date || null,
      analysis,
      computed_at: new Date().toISOString(),
    });

    return apiSuccess(res, { aggregate: analysis, callCount: cappedRows.length });
  } else {
    return apiError(res, 405, 'Method not allowed');
  }
}
