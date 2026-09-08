// Generates a coaching-forward pipeline executive brief for James.
// GET  — generates and returns the brief JSON
// GET ?send=slack — also DMs it to James on Slack

import { apiError, apiSuccess, logRequest } from '../../../lib/apiUtils';
import { createServerSupabaseClient, getSupabase } from '../../../lib/supabase';
import { getSalesProcessConfig, buildSalesProcessContext } from '../../../lib/salesProcess';
import { sendSlackMessage } from '../../../lib/slack';

const JAMES_SLACK_DM = process.env.SLACK_MANAGER_CHANNEL || 'D02PGNHTR53';

// inactive_* deals are dead → excluded from the exec pipeline snapshot exactly like closed_lost (CEO rule 2026-07-24)
const INACCESSIBLE_STAGES = ['won', 'closed_won', 'closed_lost', 'lost', 'inactive_sdr_follow_up', 'inactive_ae_follow_up'];

export default async function handler(req, res) {
  logRequest(req, 'manager/weekly-brief');
  if (req.method !== 'GET') return apiError(res, 405, 'GET only');

  const isCron = process.env.CRON_SECRET && req.headers['authorization'] === `Bearer ${process.env.CRON_SECRET}`;
  if (!isCron) {
    const auth = createServerSupabaseClient(req, res);
    const { data: { user } } = await auth.auth.getUser();
    if (!user) return apiError(res, 401, 'Unauthorized');
  }

  const sendToSlack = req.query.send === 'slack';
  const db = getSupabase();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const startOfWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [accountsRes, callsRes, tasksRes, processConfig] = await Promise.all([
    db.from('accounts')
      .select('id, name, stage, deal_value, owner_name, hubspot_synced_at')
      .not('stage', 'in', `(${INACCESSIBLE_STAGES.map(s => `"${s}"`).join(',')})`)
      .order('deal_value', { ascending: false })
      .limit(200),
    db.from('gong_call_analyses')
      .select('gong_call_id, analysis, analyzed_at, account_id, rep_name, title, call_category')
      .gte('analyzed_at', sevenDaysAgo)
      .not('analysis', 'is', null)
      .or('call_category.is.null,call_category.not.in.(cs,internal)')
      .limit(200),
    db.from('tasks')
      .select('id, title, status, priority, due_date, owner_id, account_id, completed_at, source_type')
      .is('dismissed_at', null)
      .or(`status.eq.open,status.eq.in_progress,completed_at.gte.${startOfWeek}`)
      .limit(300),
    getSalesProcessConfig(),
  ]);

  const accounts = accountsRes.data || [];
  const recentCalls = callsRes.data || [];
  const tasks = tasksRes.data || [];

  // Group accounts by owner
  const byOwner = {};
  for (const acct of accounts) {
    const owner = acct.owner_name || 'Unassigned';
    if (!byOwner[owner]) byOwner[owner] = [];
    byOwner[owner].push(acct);
  }

  // Group calls by rep_name
  const callsByRep = {};
  for (const call of recentCalls) {
    const rep = call.rep_name || 'Unknown';
    if (!callsByRep[rep]) callsByRep[rep] = [];
    callsByRep[rep].push(call);
  }

  // Compute task stats
  const overdueTasks = tasks.filter(t =>
    ['open', 'in_progress'].includes(t.status) && t.due_date && new Date(t.due_date) < new Date()
  );
  const completedThisWeek = tasks.filter(t => t.completed_at && new Date(t.completed_at) >= new Date(startOfWeek));

  // Build compact pipeline snapshot for the prompt
  const pipelineSnapshot = Object.entries(byOwner).map(([owner, accts]) => {
    const stageBreakdown = {};
    accts.forEach(a => { stageBreakdown[a.stage] = (stageBreakdown[a.stage] || 0) + 1; });
    const totalValue = accts.reduce((sum, a) => sum + (a.deal_value || 0), 0);
    return `${owner}: ${accts.length} accounts | $${Math.round(totalValue / 1000)}K pipeline | stages: ${Object.entries(stageBreakdown).map(([s, n]) => `${s}(${n})`).join(', ')}`;
  }).join('\n');

  // Build per-rep call summaries
  const callSummaries = Object.entries(callsByRep).map(([rep, calls]) => {
    const nextStepRate = calls.filter(c => (c.analysis?.next_steps_mentioned || []).length > 0).length;
    const avgDiscovery = calls.reduce((sum, c) => sum + (c.analysis?.discovery_score || 0), 0) / calls.length;
    const avgTalkRatio = calls.reduce((sum, c) => sum + (c.analysis?.rep_talk_ratio || 0), 0) / calls.length;
    const redFlagCalls = calls.filter(c => (c.analysis?.red_flags || []).length > 0);
    const commitment_rate = calls.filter(c => (c.analysis?.commitments || []).length > 0).length;

    const callDetails = calls.slice(0, 5).map(c => {
      const a = c.analysis || {};
      return [
        `  Call: "${c.title || 'untitled'}"`,
        a.summary ? `  Summary: ${a.summary.slice(0, 200)}` : '',
        (a.next_steps_mentioned || []).length ? `  Next steps: ${a.next_steps_mentioned.slice(0, 2).join(' | ')}` : '  Next steps: NONE DEFINED',
        (a.red_flags || []).length ? `  Red flags: ${(a.red_flags || []).slice(0, 2).join(' | ')}` : '',
        (a.commitments || []).length ? `  Rep commitments: ${(a.commitments || []).slice(0, 2).join(' | ')}` : '',
      ].filter(Boolean).join('\n');
    }).join('\n---\n');

    return `REP: ${rep}
Calls this week: ${calls.length} | Next-step rate: ${nextStepRate}/${calls.length} | Avg discovery score: ${avgDiscovery.toFixed(1)}/10 | Avg talk ratio: ${avgTalkRatio.toFixed(0)}% | Commitments made: ${commitment_rate}/${calls.length} | Red flag calls: ${redFlagCalls.length}
${callDetails}`;
  }).join('\n\n===\n\n');

  const taskSummary = `Open/overdue: ${overdueTasks.length} overdue tasks | Completed this week: ${completedThisWeek.length}`;

  const processContext = buildSalesProcessContext(processConfig);

  const prompt = `You are generating a weekly executive pipeline brief for James Lindberg, the CEO/manager of Banner (a CapEx software company). Today is ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}.

${processContext}

PIPELINE SNAPSHOT (active deals only):
${pipelineSnapshot}

TASK HEALTH:
${taskSummary}

RECENT CALLS (last 7 days) — THIS IS THE COACHING DATA:
${callSummaries || 'No calls analyzed this week.'}

Generate a structured weekly brief. Be specific — name deals, name reps, cite call evidence. Avoid generic advice. Use Banner's actual sales process (MEDDICC, stage exit criteria, coaching priorities) as your benchmark.

Respond with ONLY valid JSON in this exact shape:
{
  "headline": "one punchy sentence capturing the week's pipeline mood",
  "pipeline_pulse": [
    "3-4 bullet strings about net movement this week — what advanced, what stalled, what's at risk, total pipeline health"
  ],
  "watch_list": [
    {
      "account": "account name",
      "owner": "rep name",
      "reason": "1-2 sentences: what specifically is concerning and why James should care",
      "suggested_action": "what James should do or say"
    }
  ],
  "rep_coaching": [
    {
      "rep": "rep name",
      "calls_reviewed": number,
      "observation": "1-2 sentences grounded in call evidence — what pattern is this rep showing? Be specific, cite call titles or next-step behavior",
      "coaching_focus": "the single most important thing for this rep to improve",
      "one_on_one_script": "a specific sentence or question James can open with in their next 1:1"
    }
  ],
  "wins": ["1-3 bullet strings — specific positive signals worth acknowledging"],
  "your_3_priorities": ["3 specific action items for James this week as manager — name deals, name reps"]
}`;

  let brief;
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
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await claudeRes.json();
    const text = data.content?.[0]?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    brief = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
  } catch (e) {
    return apiError(res, 500, `Claude error: ${e.message}`);
  }

  if (!brief) return apiError(res, 500, 'Failed to parse brief from Claude');

  if (sendToSlack) {
    await deliverToSlack(brief).catch(e => console.error('[weekly-brief] Slack error:', e.message));
  }

  return apiSuccess(res, { brief, generatedAt: new Date().toISOString() });
}

async function deliverToSlack(brief) {
  const lines = [
    `*📊 Weekly Pipeline Brief*`,
    `_${brief.headline}_`,
    '',
    `*Pipeline Pulse*`,
    ...(brief.pipeline_pulse || []).map(b => `• ${b}`),
    '',
    `*Watch List*`,
    ...(brief.watch_list || []).map(w => `• *${w.account}* (${w.owner}): ${w.reason}\n  → ${w.suggested_action}`),
    '',
    `*Rep Coaching*`,
    ...(brief.rep_coaching || []).map(r =>
      `• *${r.rep}* (${r.calls_reviewed} calls): ${r.observation}\n  Focus: ${r.coaching_focus}\n  1:1 opener: _"${r.one_on_one_script}"_`
    ),
    '',
    `*Wins*`,
    ...(brief.wins || []).map(w => `• ${w}`),
    '',
    `*Your 3 Priorities This Week*`,
    ...(brief.your_3_priorities || []).map((p, i) => `${i + 1}. ${p}`),
  ];

  await sendSlackMessage({ text: lines.join('\n') }, JAMES_SLACK_DM);
}
