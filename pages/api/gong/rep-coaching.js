// Generates an AI coaching card for a specific rep based on their recent Gong calls.
// GET ?repName=X&days=30

import { apiError, apiSuccess, logRequest } from '../../../lib/apiUtils';
import { createServerSupabaseClient, getSupabase } from '../../../lib/supabase';
import { getSalesProcessConfig, buildSalesProcessContext } from '../../../lib/salesProcess';

export default async function handler(req, res) {
  logRequest(req, 'gong/rep-coaching');
  if (req.method !== 'GET') return apiError(res, 405, 'GET only');

  const auth = createServerSupabaseClient(req, res);
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return apiError(res, 401, 'Unauthorized');

  const { repName, days = '30' } = req.query;
  if (!repName) return apiError(res, 400, 'repName required');

  const daysNum = Math.min(parseInt(days, 10) || 30, 90);
  const since = new Date(Date.now() - daysNum * 24 * 60 * 60 * 1000).toISOString();
  const prevSince = new Date(Date.now() - 2 * daysNum * 24 * 60 * 60 * 1000).toISOString();

  const db = getSupabase();

  const [currentRes, prevRes, processConfig] = await Promise.all([
    db.from('gong_call_analyses')
      .select('gong_call_id, title, analysis, analyzed_at, account_id')
      .ilike('rep_name', `%${repName.split(' ')[0]}%`)
      .gte('analyzed_at', since)
      .not('analysis', 'is', null)
      .or('call_category.is.null,call_category.not.in.(cs,internal)')
      .order('analyzed_at', { ascending: false })
      .limit(50),
    db.from('gong_call_analyses')
      .select('gong_call_id, title, analysis, analyzed_at')
      .ilike('rep_name', `%${repName.split(' ')[0]}%`)
      .gte('analyzed_at', prevSince)
      .lt('analyzed_at', since)
      .not('analysis', 'is', null)
      .or('call_category.is.null,call_category.not.in.(cs,internal)')
      .limit(50),
    getSalesProcessConfig(),
  ]);

  const currentCalls = currentRes.data || [];
  const prevCalls = prevRes.data || [];

  if (!currentCalls.length) {
    return apiSuccess(res, {
      repName,
      metrics: null,
      coachingCard: null,
      evidenceCalls: [],
      message: `No analyzed calls found for ${repName} in the last ${daysNum} days`,
    });
  }

  function computeMetrics(calls) {
    if (!calls.length) return null;
    const withDiscovery = calls.filter(c => c.analysis?.discovery_score != null);
    const withTalkRatio = calls.filter(c => c.analysis?.rep_talk_ratio != null);
    const withNextSteps = calls.filter(c => (c.analysis?.next_steps_mentioned || []).length > 0);
    const withCommitments = calls.filter(c => (c.analysis?.commitments || []).length > 0);
    const withRedFlags = calls.filter(c => (c.analysis?.red_flags || []).length > 0);
    const withFillerWords = calls.filter(c => c.analysis?.filler_words?.per_minute != null);

    return {
      callCount: calls.length,
      avgDiscoveryScore: withDiscovery.length
        ? Math.round((withDiscovery.reduce((s, c) => s + c.analysis.discovery_score, 0) / withDiscovery.length) * 10) / 10
        : null,
      avgTalkRatio: withTalkRatio.length
        ? Math.round(withTalkRatio.reduce((s, c) => s + c.analysis.rep_talk_ratio, 0) / withTalkRatio.length)
        : null,
      nextStepRate: Math.round((withNextSteps.length / calls.length) * 100),
      commitmentRate: Math.round((withCommitments.length / calls.length) * 100),
      redFlagRate: Math.round((withRedFlags.length / calls.length) * 100),
      avgFillerWordsPerMin: withFillerWords.length
        ? Math.round((withFillerWords.reduce((s, c) => s + c.analysis.filler_words.per_minute, 0) / withFillerWords.length) * 10) / 10
        : null,
    };
  }

  const current = computeMetrics(currentCalls);
  const prev = computeMetrics(prevCalls);

  function trendObj(curr, prv, threshold = 0.05) {
    if (curr == null || prv == null) return { delta: null, direction: 'neutral' };
    const delta = Math.round((curr - prv) * 100) / 100;
    const pctChange = prv !== 0 ? Math.abs(delta / prv) : (delta !== 0 ? 1 : 0);
    if (pctChange < threshold) return { delta, direction: 'neutral' };
    return { delta, direction: delta > 0 ? 'up' : 'down' };
  }

  const trends = {
    discoveryScore: trendObj(current.avgDiscoveryScore, prev?.avgDiscoveryScore),
    talkRatio: trendObj(current.avgTalkRatio, prev?.avgTalkRatio),
    nextStepRate: trendObj(current.nextStepRate, prev?.nextStepRate),
    fillerWordsPerMin: trendObj(current.avgFillerWordsPerMin, prev?.avgFillerWordsPerMin),
  };

  const metrics = {
    ...current,
    trends,
    currentPeriod: current,
    priorPeriod: prev,
  };

  // Build call evidence for the coaching prompt
  const callEvidence = currentCalls.slice(0, 10).map(c => {
    const a = c.analysis || {};
    return [
      `Call: "${c.title || 'untitled'}" (${c.analyzed_at?.slice(0, 10)})`,
      a.summary ? `Summary: ${a.summary.slice(0, 300)}` : '',
      a.discovery_score != null ? `Discovery score: ${a.discovery_score}/10` : '',
      a.rep_talk_ratio != null ? `Talk ratio: ${a.rep_talk_ratio}%` : '',
      (a.next_steps_mentioned || []).length
        ? `Next steps defined: ${a.next_steps_mentioned.slice(0, 3).join(' | ')}`
        : 'Next steps: NONE DEFINED',
      (a.commitments || []).length ? `Rep commitments: ${a.commitments.slice(0, 2).join(' | ')}` : '',
      (a.red_flags || []).length ? `Red flags: ${(a.red_flags || []).slice(0, 2).join(' | ')}` : '',
      (a.objections || []).length ? `Objections raised: ${(a.objections || []).slice(0, 2).map(o => typeof o === 'string' ? o : o.text).join(' | ')}` : '',
    ].filter(Boolean).join('\n');
  }).join('\n\n---\n\n');

  const processContext = buildSalesProcessContext(processConfig);

  const prompt = `You are a sales coach for Banner, a CapEx software company. You are generating a coaching card for ${repName} based on their last ${daysNum} days of call activity.

${processContext}

PERFORMANCE METRICS (current ${daysNum} days):
- Calls analyzed: ${metrics.callCount}
- Avg discovery score: ${metrics.avgDiscoveryScore ?? 'N/A'}/10 (trend: ${trends.discoveryScore.direction}, delta: ${trends.discoveryScore.delta ?? 'N/A'})
- Avg talk ratio: ${metrics.avgTalkRatio ?? 'N/A'}% — reps should aim for 30-45% (trend: ${trends.talkRatio.direction}, delta: ${trends.talkRatio.delta ?? 'N/A'})
- Next-step rate: ${metrics.nextStepRate}% of calls ended with a defined next step (trend: ${trends.nextStepRate.direction}, delta: ${trends.nextStepRate.delta ?? 'N/A'})
- Commitment rate: ${metrics.commitmentRate}% of calls had rep commitments
- Red flag rate: ${metrics.redFlagRate}% of calls had red flags
- Avg filler words/min: ${metrics.avgFillerWordsPerMin ?? 'N/A'} (trend: ${trends.fillerWordsPerMin.direction}, delta: ${trends.fillerWordsPerMin.delta ?? 'N/A'})

PREVIOUS PERIOD COMPARISON:
${prev ? `Discovery: ${prev.avgDiscoveryScore ?? 'N/A'} | Talk ratio: ${prev.avgTalkRatio ?? 'N/A'}% | Next-step rate: ${prev.nextStepRate}% | Filler words/min: ${prev.avgFillerWordsPerMin ?? 'N/A'}` : 'No prior period data'}

CALL EVIDENCE:
${callEvidence}

Generate a specific, evidence-backed coaching card. Name calls. Quote behaviors. Do not give generic sales advice.

Respond with ONLY valid JSON:
{
  "summary": "2-3 sentence overall assessment of where this rep is right now",
  "strengths": ["2-3 specific things this rep is doing well, with call evidence"],
  "observations": [
    {
      "pattern": "name of the pattern/issue",
      "evidence": "specific call evidence — title or behavior you observed",
      "impact": "why this matters for deal outcomes",
      "coaching_tip": "specific, actionable thing to try"
    }
  ],
  "focus_area": "THE single most important thing for this rep to improve in the next 30 days",
  "one_on_one_script": "an opening question or statement James can use in their next 1:1 to surface this naturally",
  "leading_indicators": "what to watch in the next 30 days to know if things are improving"
}`;

  let coachingCard;
  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await claudeRes.json();
    const text = data.content?.[0]?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    coachingCard = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
  } catch (e) {
    return apiError(res, 500, `Claude error: ${e.message}`);
  }

  const evidenceCalls = currentCalls.slice(0, 15).map(c => {
    const a = c.analysis || {};
    return {
      gongCallId: c.gong_call_id,
      title: c.title || 'Untitled call',
      date: c.analyzed_at,
      discoveryScore: a.discovery_score ?? null,
      talkRatio: a.rep_talk_ratio ?? null,
      hasNextSteps: (a.next_steps_mentioned || []).length > 0,
      hasRedFlags: (a.red_flags || []).length > 0,
      summary: a.summary?.slice(0, 200) || null,
    };
  });

  return apiSuccess(res, { repName, metrics, coachingCard, evidenceCalls, daysAnalyzed: daysNum });
}
