import {
  apiError,
  apiSuccess,
  validateMethod,
  validateRequired,
  validateGongCredentials,
  validateAnthropicKey,
  createGongHeaders,
  callAnthropic,
  parseClaudeJson,
  logRequest,
} from '../../../lib/apiUtils';
import { createServerSupabaseClient, getSupabase } from '../../../lib/supabase';
import { getSalesProcessConfig, buildSalesProcessContext } from '../../../lib/salesProcess';
import { bestAccountForTitle } from '../../../lib/accountMatch';
import { deriveDerivedCallType, deriveCallCategory } from '../../../lib/callCategory';
import { sendSlackMessage } from '../../../lib/slack';
import { sendCallCoachingDM } from '../../../lib/coaching';
import { isAutoProcessRep, isCoachRep, COACH_REPS } from '../../../lib/repConfig';
import { generateTaskDraft } from '../../../lib/taskActions';
import { writeBackFromAnalysis, writeAccountSignals } from '../../../lib/accountWriteback';

const GONG_API_BASE = 'https://api.gong.io';

const STAGE_PRIORITY = {
  legal: 10, proposal: 10, solution_validation: 9, demo: 9,
  active_pursuit: 8, intro_scheduled: 7, qualifying: 6,
  inactive_ae_follow_up: 3, inactive_sdr_follow_up: 3,
  closed_lost: 1, closed_won: 0,
};

function extractCompanyFromTitle(title) {
  if (!title) return null;
  // "Banner - Company: Topic", "Banner | Company - Topic", "Banner/Company: Topic"
  // Stop at `: ` or ` - ` which separate company from topic
  let m = title.match(/^Banner\s*[-|/]\s*(.+?)(?:\s*[:|]\s*\S.*|\s+-\s+\S.*)?$/i);
  if (m) return m[1].trim();
  m = title.match(/^(.+?)\s*[|]\s*Banner\b/i);
  if (m) return m[1].trim();
  m = title.match(/^(.+?)\s+-\s+Banner\b/i);
  if (m) return m[1].trim();
  m = title.match(/^(.+?)\s*\+\s*Banner\b/i);
  if (m) return m[1].trim();
  return null;
}

function normalizeName(s) {
  return (s || '')
    .toLowerCase()
    .replace(/banner[\s\-–—|+]*/gi, '')
    .replace(/[\-–—:|+,]/g, ' ')
    .replace(/\b(intro|demo|presentation|follow\s*up|meeting|call|new deal|year \d+|weekly|monthly|check\s*in|training|implementation|onboarding|review|update|sync|status|overview|assoc\.?|associates|llc|inc\.?|corp\.?|ltd\.?)\b/gi, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreMatch(accountName, targetText, extracted) {
  const a = normalizeName(accountName);
  const d = normalizeName(targetText);
  if (!a || !d) return 0;
  if (a === d) return extracted ? 10 : 8;
  if (d.startsWith(a) || a.startsWith(d)) return extracted ? 9 : 7;
  if (d.includes(a) || a.includes(d)) return extracted ? 8 : 6;
  const aWords = new Set(a.split(' ').filter(w => w.length > 3));
  const dWords = d.split(' ').filter(w => w.length > 3);
  const overlap = dWords.filter(w => aWords.has(w)).length;
  if (overlap >= 3) return 5;
  if (overlap >= 2) return extracted ? 5 : 3;
  if (overlap === 1) {
    const firstWord = a.split(' ')[0];
    if (firstWord.length >= 6 && dWords.includes(firstWord)) return extracted ? 3 : 2;
  }
  return 0;
}

function matchScore(accountName, callTitle) {
  const extracted = extractCompanyFromTitle(callTitle);
  return extracted
    ? scoreMatch(accountName, extracted, true)
    : scoreMatch(accountName, callTitle, false);
}

async function tryMatchCallToAccount(callId, callTitle, db) {
  if (!callTitle?.trim()) return null;
  try {
    // Paginate (table exceeds the 1k default cap; the old .limit(600) silently missed accounts) and
    // fetch the fields the shared matcher needs, incl. is_master/parent so calls land on the company.
    let accounts = [];
    for (let from = 0; ; from += 1000) {
      const { data } = await db.from('accounts')
        .select('id, name, stage, aliases, email_domains, is_master, parent_account_id')
        .order('id', { ascending: true })
        .range(from, from + 999);
      accounts = accounts.concat(data || []);
      if (!data || data.length < 1000) break;
    }
    if (!accounts.length) return null;
    const best = bestAccountForTitle(callTitle, accounts); // shared: alias/domain + master-preference
    if (best) {
      const extracted = extractCompanyFromTitle(callTitle);
      await db.from('gong_call_analyses').update({
        account_id: best.id,
        match_confidence: best.score / 10,
        match_method: extracted ? 'title_structured_inline' : 'title_fuzzy_inline',
      }).eq('gong_call_id', callId);
      console.log(`[intel-analyze] matched "${callTitle}" → "${best.name}" (score ${best.score})`);
      return best.id;
    }
  } catch (e) {
    console.error('[intel-analyze] tryMatchCallToAccount error:', e.message);
  }
  return null;
}

async function autoInsertTranscript({ accountId, callId, transcriptText, date, callType, analysis, gongUrl, db }) {
  if (!accountId) return;
  try {
    // Skip if already exists
    const { data: existing } = await db
      .from('transcripts')
      .select('id')
      .eq('gong_call_id', callId)
      .maybeSingle();
    if (existing) return;

    const dateStr = date ? date.split('T')[0] : null;
    await db.from('transcripts').insert({
      account_id: accountId,
      gong_call_id: callId,
      text: transcriptText?.trim() || '[Transcript from Gong — full text not stored]',
      date: dateStr,
      call_type: callType || 'other',
      summary: analysis?.summary || null,
      raw_analysis: analysis,
      source: 'gong',
      gong_url: gongUrl || null,
    });
    console.log(`[intel-analyze] inserted transcript for call ${callId} → account ${accountId}`);
  } catch (e) {
    console.error('[intel-analyze] autoInsertTranscript error:', e.message);
  }
}

// Auto-tasks + coaching only fire for calls no older than this — prevents a
// historical backlog drain from flooding task lists or DMing stale coaching.
const AUTO_TASK_MAX_AGE_MS = 72 * 60 * 60 * 1000;

const PROSPECT_STEP_PREFIXES = [
  'prospect to ', 'customer to ', 'client to ', 'they will ', 'they to ',
  'implied:', 'implicit:', 'no explicit', 'conditional on', 'if ',
];

function isProspectStep(step) {
  const lower = step.toLowerCase().trim();
  if (PROSPECT_STEP_PREFIXES.some(p => lower.startsWith(p))) return true;
  // First-person ("I'll send the deck", "we'll follow up") is the REP's own action, not the prospect's.
  if (/^(i|we|i'?ll|we'?ll|i'?m|let me|let'?s)\b/.test(lower)) return false;
  // A third-party subject + "to/will" ("Todd to review", "they will send it") is prospect-owned.
  if (/^[a-z]+ (to |will )/.test(lower) && !lower.startsWith('rep ')) return true;
  return false;
}

function isRepOwnedStep(step) {
  if (!step || step.trim().length < 10) return false;
  return !isProspectStep(step);
}

// Quality filter (PLATFORM_REVIEW §2.4): keep reps from triaging transcript filler. Rejects a step
// only when the WHOLE thing is generic boilerplate with no specific deliverable (conservative — a
// step with any concrete object survives).
const LOW_SIGNAL_PATTERNS = [
  /^(rep\s+)?(will\s+)?(follow[\s-]?up|circle back|check in|touch base|keep\s+.*\s+posted|stay in touch|reach out|be in touch)\.?$/i,
  /^(rep\s+)?(will\s+)?(send|share)\s+(the\s+|over\s+|some\s+)?(deck|info(rmation)?|details?|materials?|stuff)\.?$/i,
];
// In-call demo narration ("I'll show that", "come back to that in a second", "open this one"): the
// model extracts these as commitments because they start with "I'll", but they are the rep narrating
// the live demo, not a post-call deliverable. High-precision — requires a deictic/immediate marker or
// a demo verb on a bare demonstrative, so real deliverables ("I'll send the proposal Tuesday") survive.
const IN_CALL_NARRATION = [
  /\b(in a (sec|second|minute|bit)|as we go|right (here|now|there)|over (here|there)|down here|up here|for a (sec|second)|real quick)\b/i,
  /\b(come back to|get\s+(?:\w+\s+){0,2}into|jump\s+(?:back\s+)?into|circle back to|show|walk through|pull up|open|close|scroll|expand|collapse|dive into)\b\s+(that|this|it|these|those|everything|here|there|one|(?:the\s+)?(?:\w+\s+){0,4}(?:bidding|workflow|workflows|feature|features|screen|tab|page|section|part|piece|options?|settings?|report|dashboard))\b/i,
  /^\s*(i'?ll|i will|i can|i'?m going to|i am going to|let me|let'?s)\s+[\w\s]{0,20}\b(that|this|it|one|these|those|here|there)\s*\.?$/i,
];
function isLowSignalStep(step) {
  const s = (step || '').trim();
  const core = s.replace(/^(rep|i)\s+(will|to|'ll|am going to|going to)\s+/i, '').trim();
  if (core.length < 12) return true;
  if (LOW_SIGNAL_PATTERNS.some(re => re.test(s))) return true;
  return IN_CALL_NARRATION.some(re => re.test(s));
}

const normStep = (s) => (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
// Turn a raw extracted step into a clean task title: drop the "Rep will / I'll / to " lead-in and capitalize.
const cleanStepTitle = (s) => {
  const t = (s || '').replace(/^(rep|i|we)\s+(to\s+|will\s+|'ll\s+|should\s+|am going to\s+|going to\s+)?/i, '').replace(/^to\s+/i, '').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : (s || '');
};
// Drop near-identical steps within one call (the "Rep will keep Todd posted" ×5 problem) via
// token-Jaccard ≥ 0.8. Keeps the first occurrence.
function dedupSteps(steps) {
  const out = [], seen = [];
  for (const s of steps) {
    const toks = new Set(normStep(s).split(' ').filter(w => w.length > 2));
    if (!toks.size) continue;
    const dup = seen.some(prev => {
      const inter = [...toks].filter(t => prev.has(t)).length;
      const uni = new Set([...toks, ...prev]).size;
      return uni > 0 && inter / uni >= 0.8;
    });
    if (!dup) { out.push(s); seen.push(toks); }
  }
  return out;
}

// Resolve a spoken reconnection timeframe ("July", "in 2 weeks", "Q3", "next month", "after the
// holidays") to a due date (YYYY-MM-DD) relative to the call. Returns null if unparseable or past.
function resolveReengageDate(when, callDate) {
  if (!when || typeof when !== 'string') return null;
  const w = when.toLowerCase().trim();
  const base = callDate ? new Date(callDate) : new Date();
  const now = new Date();
  const iso = (d) => (d && !isNaN(d) && d > now ? d.toISOString().slice(0, 10) : null);
  const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  let m;
  if ((m = w.match(/in\s+(\d+)\s+(day|week|month|quarter)s?/))) {
    const n = parseInt(m[1], 10), d = new Date(base);
    if (m[2] === 'day') d.setDate(d.getDate() + n);
    else if (m[2] === 'week') d.setDate(d.getDate() + n * 7);
    else if (m[2] === 'month') d.setMonth(d.getMonth() + n);
    else d.setMonth(d.getMonth() + n * 3);
    return iso(d);
  }
  if (/couple (of )?weeks|few weeks/.test(w)) { const d = new Date(base); d.setDate(d.getDate() + 14); return iso(d); }
  if (/next week/.test(w)) { const d = new Date(base); d.setDate(d.getDate() + 7); return iso(d); }
  if (/next month/.test(w)) { const d = new Date(base); d.setMonth(d.getMonth() + 1, 15); return iso(d); }
  if (/next quarter/.test(w)) { const d = new Date(base); d.setMonth(d.getMonth() + 3, 1); return iso(d); }
  if (/after the holidays|new year/.test(w)) return iso(new Date(now.getFullYear() + 1, 0, 15));
  if (/end of (the )?year|year[- ]?end/.test(w)) { const d = new Date(base.getFullYear(), 11, 15); return iso(d); }
  const clampSoon = (d) => (d > now ? d : new Date(now.getTime() + 7 * 86400000)); // never schedule in the past — a week out at the soonest
  const qm = w.match(/q([1-4])/);
  if (qm) {
    const q = parseInt(qm[1], 10);
    const qEnd = new Date(base.getFullYear(), q * 3, 0); // last day of the quarter
    // Only bump a full year when the WHOLE quarter is already past; if we're inside it, aim at its start (or a week out).
    const d = qEnd < now ? new Date(base.getFullYear() + 1, (q - 1) * 3, 1) : clampSoon(new Date(base.getFullYear(), (q - 1) * 3, 1));
    return iso(d);
  }
  const mi = months.findIndex(mn => w.includes(mn));
  if (mi >= 0) {
    const mEnd = new Date(base.getFullYear(), mi + 1, 0); // last day of that month
    const d = mEnd < now ? new Date(base.getFullYear() + 1, mi, 15) : clampSoon(new Date(base.getFullYear(), mi, 15));
    return iso(d);
  }
  return null;
}

async function autoCreateTasksFromAnalysis({ callId, title, date, repEmail, repName, analysis, durationSeconds, callCategory, accountId, attendees = [], db }) {
  // Governance: only auto-process reps get auto-tasks, and never from CS-category calls.
  if (!isAutoProcessRep(repEmail) && !isAutoProcessRep(repName)) return;
  if (callCategory === 'cs') return;
  if (!repEmail) return;

  // Freshness gate: never flood the task list from a historical backlog drain.
  const isRecentEnough = date && (Date.now() - new Date(date).getTime()) < AUTO_TASK_MAX_AGE_MS;
  if (!isRecentEnough) return;

  // Resolve the rep's user_id + Slack ID from profiles — no hardcoded UUID map.
  const { data: repProfile } = await db
    .from('profiles')
    .select('id, slack_user_id')
    .ilike('email', repEmail)
    .maybeSingle();
  const userId = repProfile?.id;
  if (!userId) return;

  // Coached-call attribution: if the lead rep is NOT a coach but a coach (e.g. James) was among the
  // internal attendees, the tasks belong to the lead rep (deal owner) but are tagged coached_by the
  // coach so they can filter "Calls I coached". No-op for a coach's OWN calls (they're the lead).
  let coachedBy = null;
  const leadIsCoach = isCoachRep(repEmail) || isCoachRep(repName);
  const coachPresent = Array.isArray(attendees) && attendees.some(a => isCoachRep(a.email) || isCoachRep(a.name));
  if (coachPresent && !leadIsCoach && COACH_REPS[0]?.email) {
    const { data: coachProfile } = await db.from('profiles').select('id').ilike('email', COACH_REPS[0].email).maybeSingle();
    coachedBy = coachProfile?.id || null;
  }

  const repSteps = dedupSteps((analysis.next_steps_mentioned || []).filter(isRepOwnedStep).filter(s => !isLowSignalStep(s)));
  const triggerList = Array.isArray(analysis.reengagement_triggers) ? analysis.reengagement_triggers : [];
  const hasCommitments = (analysis.commitments || []).some(c => c && c.length > 5 && !isLowSignalStep(c));

  // Post-call playbook: a fixed checklist added after every analyzed call (editable in /modules/playbooks).
  const { data: postPlaybook } = await db.from('task_playbooks')
    .select('steps').eq('trigger', 'post_call').eq('active', true).limit(1).maybeSingle();
  const playbookSteps = Array.isArray(postPlaybook?.steps) ? postPlaybook.steps : [];

  if (!repSteps.length && !triggerList.length && !hasCommitments && !playbookSteps.length) return;

  // Dedup: skip if tasks already exist for this gong call id
  const { count } = await db
    .from('tasks')
    .select('id', { count: 'exact', head: true })
    .eq('source', 'gong')
    .ilike('description', `%${callId}%`);
  if (count > 0) return;

  const callDateStr = date
    ? new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : 'unknown date';

  // Post-call checklist rows from the playbook — due = call date + the step's offset hours.
  const playbookRows = playbookSteps.slice(0, 8).map(s => ({
    owner_id: userId, created_by: userId, type: 'triggered',
    priority: [1, 2, 3].includes(Number(s.priority)) ? Number(s.priority) : 2,
    title: String(s.title || '').slice(0, 200),
    description: `Post-call checklist — from Gong call: "${title || 'Untitled'}" on ${callDateStr} (call ID: ${callId})`,
    status: 'open', source: 'gong', source_id: callId, source_type: 'playbook_post_call', account_id: accountId || null,
    due_date: new Date((date ? new Date(date) : new Date()).getTime() + (Number(s.due_offset_hours) || 0) * 3600000).toISOString().slice(0, 10),
    rationale: 'Standard post-call step.', visible_to_manager: true,
  })).filter(r => r.title.trim());

  // Rep-owned next steps (priority 2)
  const nextStepRows = repSteps.slice(0, 4).map(step => ({
    owner_id:          userId,
    created_by:        userId,
    type:              'triggered',
    priority:          2,
    title:             (t => t.length > 120 ? t.slice(0, 117) + '...' : t)(cleanStepTitle(step)),
    description:       `Auto-extracted from Gong call: "${title || 'Untitled'}" on ${callDateStr} (call ID: ${callId})`,
    status:            'open',
    source:            'gong',
    source_type:       'gong_next_step',
    account_id:        accountId || null,
    rationale:         analysis.summary ? analysis.summary.slice(0, 200) : null,
    visible_to_manager: true,
  }));

  // Commitments — explicit first-person promises (priority 1, higher urgency)
  const commitments = dedupSteps((analysis.commitments || []).filter(c => c && c.length > 5 && !isLowSignalStep(c)));
  const commitmentRows = commitments.slice(0, 2).map(c => ({
    owner_id:          userId,
    created_by:        userId,
    type:              'triggered',
    priority:          1,
    title:             (t => t.length > 120 ? t.slice(0, 117) + '...' : t)(cleanStepTitle(c)),
    description:       `Rep commitment from Gong call: "${title || 'Untitled'}" on ${callDateStr} (call ID: ${callId})`,
    status:            'open',
    source:            'gong',
    source_type:       'gong_commitment',
    account_id:        accountId || null,
    rationale:         `Explicit promise made on the call — highest urgency to follow through.`,
    visible_to_manager: true,
  }));

  // Re-engagement triggers → scheduled follow-up tasks with a resolved due date. "Let's touch base in
  // July" becomes a July task with a drafted message; these count toward the AE weekly re-engage goal.
  const reengageRows = triggerList.slice(0, 2).map(t => {
    const text = (typeof t === 'string' ? t : t?.text || '').trim();
    const when = typeof t === 'object' ? (t?.when || null) : null;
    if (!text || text.length < 5) return null;
    // Fall back to callDate+14d so an unparseable timeframe still lands on a real day (not a null due date).
    const due = resolveReengageDate(when, date) || new Date((date ? new Date(date) : new Date()).getTime() + 14 * 86400000).toISOString().slice(0, 10);
    return {
      owner_id: userId, created_by: userId, type: 'triggered', priority: 2,
      title: (`Re-engage${when ? ` (${when})` : ''}: ${text}`).slice(0, 117),
      description: `Re-engagement trigger from Gong call: "${title || 'Untitled'}" on ${callDateStr} (call ID: ${callId})${when ? ` — reconnect ${when}` : ''}`,
      status: 'open', source: 'gong', source_type: 'gong_reengage',
      account_id: accountId || null, due_date: due,
      rationale: `Prospect asked to reconnect${when ? ` (${when})` : ''} — scheduled follow-up.`,
      visible_to_manager: true,
    };
  }).filter(Boolean);

  // Cross-array dedup: one real action often surfaces as both a commitment AND a next-step (or a
  // re-engage). Keep the highest-priority occurrence — rows are ordered commitments → reengage →
  // next-steps, so the first survivor wins. Compare on the underlying text (strip the re-engage prefix).
  const cmpText = (row) => normStep(row.source_type === 'gong_reengage' ? row.title.replace(/^re-engage[^:]*:\s*/i, '') : row.title);
  const rows = [];
  const keptTokenSets = [];
  for (const row of [...commitmentRows, ...reengageRows, ...nextStepRows]) {
    const toks = new Set(cmpText(row).split(' ').filter(w => w.length > 2));
    const dup = toks.size > 0 && keptTokenSets.some(prev => {
      const inter = [...toks].filter(t => prev.has(t)).length;
      const uni = new Set([...toks, ...prev]).size;
      return uni > 0 && inter / uni >= 0.7;
    });
    if (!dup) { rows.push(row); keptTokenSets.push(toks); }
  }
  rows.push(...playbookRows); // append the fixed post-call checklist (not deduped against extracted steps)
  if (!rows.length) return;
  if (coachedBy) for (const r of rows) r.coached_by = coachedBy; // tag coached-call tasks for the coach's filter

  // Base columns only on insert — keeps task creation working even before the
  // 20260628 migration adds trigger/ai_draft.
  const { data: createdTasks, error } = await db
    .from('tasks')
    .insert(rows)
    .select('id, title, description, rationale, source_type');
  if (error) {
    console.error('[intel-analyze] Auto-task creation failed:', error.message);
    return;
  }

  console.log(`[intel-analyze] Created ${rows.length} tasks (${commitmentRows.length} commitments, ${reengageRows.length} re-engage, ${nextStepRows.length} next steps) from "${title}"`);

  // Pre-generate each task's AI action so the rep never opens a blank task, and tag the
  // trigger. Both are best-effort: a missing column (pre-migration) just logs and moves on.
  const draftCtxCall = {
    title, date,
    summary: analysis.summary,
    painPoints: analysis.pain_points_identified || analysis.pain_points,
    nextSteps: analysis.next_steps_mentioned,
    commitments: analysis.commitments,
    objections: (analysis.objections || []).map(o => (typeof o === 'string' ? o : o?.text)).filter(Boolean),
  };
  // Awaited (intel-analyze is server-to-server) + parallel so drafts actually persist on
  // serverless instead of being dropped when the instance freezes after the response.
  await Promise.all((createdTasks || []).map(async (t) => {
    const trig = t.source_type === 'gong_commitment' ? 'gong_commitment' : 'gong_action_item';
    try {
      const draft = await generateTaskDraft({ task: { ...t, trigger: trig }, calls: [draftCtxCall], repName: (repEmail || '').split('@')[0] });
      await db.from('tasks').update({ trigger: trig, ...(draft ? { ai_draft: draft } : {}) }).eq('id', t.id);
    } catch (e) { console.error('[intel-analyze] task trigger/draft update skipped:', e.message); }
  }));

  // Send Slack DM if call is fresh (within last 8 hours)
  const isFresh = date && (Date.now() - new Date(date).getTime()) < 8 * 60 * 60 * 1000;
  if (!isFresh) return;

  try {
    const durationMin = durationSeconds ? Math.round(durationSeconds / 60) : null;
    const callLabel = [title || 'Untitled call', durationMin ? `${durationMin} min` : null].filter(Boolean).join(' — ');

    // Derive from `rows` (the actually-inserted, cross-array-deduped set) so the DM matches the tasks
    // created — and includes re-engage follow-ups, which were previously omitted.
    const taskLines = rows.map(r => {
      if (r.source_type === 'gong_commitment') return `🔴 ${r.title}  _(commitment)_`;
      if (r.source_type === 'gong_reengage') return `📅 ${r.title}  _(re-engage${r.due_date ? `: ${r.due_date}` : ''})_`;
      return `• ${r.title}  _(next step)_`;
    });

    const blocks = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `🎙️ *Call analyzed: ${callLabel}*\n\n*Added to your task list:*\n${taskLines.join('\n')}`,
        },
      },
      {
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: `<https://sales-dashboard-james-projects-87ec0089.vercel.app/modules/tasks|Open Tasks →>`,
        }],
      },
    ];

    // Send to the rep's own DM (push to the person who owns the work), not the manager channel.
    const channel = repProfile?.slack_user_id || process.env.SLACK_MANAGER_CHANNEL;
    await sendSlackMessage({ blocks }, channel);
  } catch (e) {
    console.error('[intel-analyze] Slack notification failed:', e.message);
  }
}

export default async function handler(req, res) {
  logRequest(req, 'gong/intel-analyze');
  if (!validateMethod(req, res, 'POST')) return;
  if (!validateRequired(req, res, ['callId'])) return;

  const { callId, title, date, callType, repName, repEmail, durationSeconds, gongUrl, transcriptText: preloadedTranscript } = req.body;

  const apiKey = validateAnthropicKey(res);
  if (!apiKey) return;

  // Use pre-loaded transcript if provided (from process-backlog, skips Gong re-fetch)
  const hasPreloaded = preloadedTranscript && preloadedTranscript.length > 50 && preloadedTranscript !== '[No transcript available for this call]';

  let transcriptText = '';
  let callAttendees = []; // [{ name, email, affiliation }] — for coached-call detection
  let claimedRow = false;
  const force = req.body?.force === true;
  // Resolve the DB client up front — used by the concurrency claim below and the persist later.
  // Cron (CRON_SECRET auth) uses the service-role client; otherwise the user session.
  const isCron = process.env.CRON_SECRET && req.headers['authorization'] === `Bearer ${process.env.CRON_SECRET}`;
  const db = isCron ? getSupabase() : createServerSupabaseClient(req, res);

  try {
    // ── Concurrency claim ────────────────────────────────────────────────────────────────
    // Two poller jobs on the same */15 cron can pick the same call. Claim it atomically before
    // the costly Gong fetch + Claude analysis so only one caller does the work — stops duplicate
    // tasks, duplicate coaching DMs, and double Haiku spend. Covers both the poller path (no row
    // exists yet → reserve via insert-on-conflict) and the imported-but-pending path (row exists
    // with analyzed_at NULL → flip it). A manual re-analyze (force) intentionally bypasses this.
    if (!force) {
      const { data: reserved } = await db.from('gong_call_analyses')
        .upsert({ gong_call_id: callId, analyzed_at: new Date().toISOString() }, { onConflict: 'gong_call_id', ignoreDuplicates: true })
        .select('gong_call_id');
      if (reserved && reserved.length > 0) {
        claimedRow = true; // brand-new call — we inserted the reservation row
      } else {
        const { data: claimed } = await db.from('gong_call_analyses')
          .update({ analyzed_at: new Date().toISOString() })
          .eq('gong_call_id', callId).is('analyzed_at', null)
          .select('gong_call_id');
        if (claimed && claimed.length > 0) {
          claimedRow = true; // existing row was pending — we flipped analyzed_at null→now
        } else {
          // Someone else already analyzed (or is analyzing) this call — return without redoing work.
          const { data: existingRow } = await db.from('gong_call_analyses')
            .select('analysis, analyzed_at').eq('gong_call_id', callId).maybeSingle();
          if (existingRow?.analyzed_at) {
            return apiSuccess(res, { callId, analysis: existingRow.analysis ?? null, persisted: true, deduped: true });
          }
          // Row vanished between checks (rare) — fall through and analyze normally.
        }
      }
    }

    if (hasPreloaded) {
      transcriptText = preloadedTranscript;
    } else {
      const credentials = validateGongCredentials(res);
      if (!credentials) return;
      const { accessKey, secretKey } = credentials;
      const gongHeaders = createGongHeaders(accessKey, secretKey);

      // Fetch call details + transcript in parallel
      const [detailsRes, transcriptRes] = await Promise.all([
        fetch(`${GONG_API_BASE}/v2/calls/extensive`, {
          method: 'POST',
          headers: gongHeaders,
          body: JSON.stringify({
            filter: { callIds: [callId] },
            contentSelector: { exposedFields: { parties: true } },
          }),
        }),
        fetch(`${GONG_API_BASE}/v2/calls/transcript`, {
          method: 'POST',
          headers: gongHeaders,
          body: JSON.stringify({ filter: { callIds: [callId] } }),
        }),
      ]);

      const detailsData = await detailsRes.json().catch(() => ({}));
      const transcriptData = await transcriptRes.json().catch(() => ({}));

      const callDetails = detailsData.calls?.[0];
      const callTranscript = transcriptData.callTranscripts?.[0];

      const speakerMap = {};
      (callDetails?.parties || []).forEach(p => {
        speakerMap[p.speakerId] = {
          name: p.name || p.emailAddress || `Speaker ${p.speakerId}`,
          affiliation: p.affiliation,
        };
      });
      // Capture attendees (internal parties) so a coach who rode along can be detected downstream.
      callAttendees = (callDetails?.parties || [])
        .filter(p => p.affiliation === 'internal')
        .map(p => ({ name: p.name || null, email: p.emailAddress || null, affiliation: p.affiliation }));

      if (callTranscript?.transcript && Array.isArray(callTranscript.transcript)) {
        callTranscript.transcript.forEach(segment => {
          const speaker = speakerMap[segment.speakerId] || { name: `Speaker ${segment.speakerId}`, affiliation: 'unknown' };
          const label = speaker.affiliation === 'internal' ? `[REP] ${speaker.name}` : `[PROSPECT] ${speaker.name}`;
          (segment.sentences || []).forEach(s => {
            // Embed the sentence timestamp (mm:ss) so downstream generators (proposal/eval doc) can
            // attribute quotes with a timestamp. Parse-tolerant superset of the old `[SPEAKER] Name:`.
            const t = Number(s.start);
            const ts = Number.isFinite(t) ? `${Math.floor(t / 60000)}:${String(Math.floor((t % 60000) / 1000)).padStart(2, '0')}` : '';
            transcriptText += `${label}${ts ? ` (${ts})` : ''}: ${s.text}\n`;
          });
        });
      }

      if (!transcriptText.trim()) {
        transcriptText = '[No transcript available for this call]';
      }
    }

    const durationMin = Math.round((durationSeconds || 0) / 60);

    const salesProcessConfig = await getSalesProcessConfig();
    const salesProcessContext = buildSalesProcessContext(salesProcessConfig);

    const analysisPrompt = `Analyze this sales call transcript for Banner (CapEx management software for commercial real estate). Extract structured insights.

${salesProcessContext}



Call: "${title || 'Untitled'}" | Type: ${callType || 'unknown'} | Duration: ${durationMin} min | Rep: ${repName || 'Unknown'}

TRANSCRIPT:
${transcriptText.slice(0, 28000)}

ICP scoring guide (Banner's ideal customer):
  9-10: CRE company managing large portfolios, CapEx-heavy, currently on spreadsheets/manual processes
  7-8: Right industry, most criteria met, minor gaps
  5-6: Partial fit — right industry but smaller or unclear CapEx focus
  3-4: Wrong vertical or not CapEx-heavy
  1-2: Clearly outside ICP

Discovery score guide (MEDDICC coverage):
  Score based on how well rep uncovered: economic buyer (who controls budget), decision process (how they evaluate and decide), timeline, quantified pain (specific $ or operational impact), champion (internal advocate identified). 10 = all five uncovered.

Pain depth score guide (1-10):
  9-10: Pain quantified (specific $ or operational impact) AND tied to a named stakeholder AND urgency established (why act now)
  7-8: Pain quantified AND stakeholder-tied, but no urgency driver yet
  5-6: Pain quantified OR stakeholder-tied (only one of the two)
  3-4: Pain acknowledged and discussed but not quantified or clearly owned
  1-2: Pain mentioned superficially or prospect deflected, no real exploration

Champion health score guide (1-10):
  9-10: Champion actively mobilizing internal resources — scheduling meetings, sharing internal docs, looping in decision-makers
  7-8: Champion clearly identified, sharing information unprompted, giving inside perspective
  5-6: Potential champion identified with some genuine engagement (asking good questions, replying promptly)
  3-4: Someone shows interest but behavior is passive — responding but not advocating
  1-2: No champion identified or champion is disengaged, skeptical, or not present on calls

Disqualification signal: Set to true if the call ended with a soft, non-committal close — phrases like "we'll send over some info", "let's circle back", "I'll think about it", "reach back out in a few weeks", or "let's keep in touch" — WITHOUT a specific next step (date, meeting, or clear action committed to by both sides). This is a flag for "we're limping along rather than qualifying or disqualifying." Set to false if a clear mutual next step was established.

Return ONLY valid JSON:
{
  "summary": "2-3 sentence summary of what happened and the outcome signal",
  "themes": ["theme1", "theme2", "theme3"],
  "objections": [{"text": "exact or paraphrased objection", "category": "pricing|timeline|technical|authority|competition|other", "rep_response": "brief description of how rep responded"}],
  "competitor_mentions": [{"name": "competitor name", "context": "brief context", "sentiment": "positive|neutral|negative"}],
  "rep_talk_ratio": 47,
  "sentiment": "positive|neutral|negative",
  "buying_signals": ["specific buying signal from the call"],
  "red_flags": ["specific concern or red flag"],
  "next_steps_mentioned": ["next step discussed in the call"],
  "no_show": false,
  "icp_score": 7,
  "icp_rationale": "one sentence on why this score — what fit or mismatch was present",
  "discovery_score": 6,
  "discovery_gaps": ["economic buyer not identified", "no timeline established"],
  "disqualification_signal": false,
  "disqualification_notes": "null if no signal, otherwise brief explanation — e.g. 'Call ended with prospect saying they'd think about it and rep agreed to follow up later with no date set'",
  "pain_depth_score": 5,
  "pain_depth_notes": "one sentence — what pain was surfaced and how well it was developed (quantified, stakeholder-tied, urgency established)",
  "champion_health_score": 5,
  "champion_health_notes": "one sentence — who the potential champion is and how engaged they are (passive interest vs actively mobilizing internally)",
  "commitments": ["Verbatim or near-verbatim rep statement where they promised to do something. Only include first-person promises starting with I'll, I will, I can, I'm going to, etc. Example: 'I'll send the deck over today'"],
  "reengagement_triggers": [{"text": "verbatim ask to reconnect at a LATER date (NOT an immediate next step) — e.g. 'let's touch base in July', 'reach back out in Q3', 'circle back next month', 'check in after the holidays'", "when": "the timeframe mentioned as a short phrase — 'July', 'in 2 weeks', 'Q3', 'next month', 'after the holidays' — or null if none stated"}],
  "meddicc": {"metrics": "quantified value/impact discussed, or null", "economic_buyer": "who controls the budget, or null", "decision_criteria": "how they will evaluate, or null", "decision_process": "steps/timeline to decide, or null", "identify_pain": "the core pain in one line, or null", "champion": "internal advocate + how engaged, or null", "competition": "alternatives being considered, or null"},
  "stakeholders": [{"name": "full name mentioned on the call", "title": "their role/title or null", "role": "Champion|Economic Buyer|Technical Buyer|User Buyer|Influencer|Blocker|Unknown", "is_champion": false}],
  "information_gaps": [{"question": "an open MEDDICC question still unanswered after this call", "category": "metrics|economic_buyer|decision_process|pain|champion|competition|timeline|other"}],
  "filler_words": {
    "um": 0,
    "uh": 0,
    "like": 0,
    "you_know": 0,
    "literally": 0,
    "basically": 0,
    "actually": 0,
    "total": 0,
    "per_minute": null
  }
}

Set "no_show" to true ONLY if the other party (the prospect or customer) never actually joined the meeting and the Banner team waited and then ended the call with no real conversation. If the other side spoke at all, or this was an internal Banner call, set it to false.

Count filler words in the rep's speech only (not the customer's). Be accurate — count every occurrence. For "like", only count conversational filler uses ("it was, like, really good"), not legitimate uses ("it looks like", "something like that"). For "per_minute", divide the total by the call duration in minutes (${durationMin} minutes); set to null if duration is 0.`;

    const rawAnalysis = await callAnthropic(apiKey, {
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 2400,
      messages: [{ role: 'user', content: analysisPrompt }],
    });

    const analysis = parseClaudeJson(rawAnalysis, {
      summary: 'Analysis unavailable',
      themes: [],
      objections: [],
      competitor_mentions: [],
      rep_talk_ratio: 50,
      sentiment: 'neutral',
      buying_signals: [],
      red_flags: [],
      next_steps_mentioned: [],
      no_show: false,
      reengagement_triggers: [],
      icp_score: null,
      icp_rationale: null,
      discovery_score: null,
      discovery_gaps: [],
      disqualification_signal: false,
      disqualification_notes: null,
      pain_depth_score: null,
      pain_depth_notes: null,
      champion_health_score: null,
      champion_health_notes: null,
      commitments: [],
      meddicc: {},
      stakeholders: [],
      information_gaps: [],
      filler_words: null,
    });

    // Auto-flag a no-show that the crude <2min rule (webhook/nightly) misses: the LLM read the transcript
    // and the counterparty never joined. Bounded to short calls (<=15m) to stay precise — a no-show is a
    // call we wait on and leave, not a long real conversation. Kept in the table but ignored from analysis.
    const isNoShowCall = analysis?.no_show === true && (durationSeconds || 0) > 0 && (durationSeconds || 0) <= 900;
    const noShowFlags = isNoShowCall ? { ignored: true, ignore_reason: 'no_show', derived_call_type: 'no_show' } : {};

    // Persist to Supabase — this is the source of truth across sessions. (db + isCron resolved up top.)
    const { error: upsertError } = await db.from('gong_call_analyses').upsert(
      {
        gong_call_id: callId,
        title: title || 'Untitled',
        call_date: date || null,
        call_type: callType || 'other',
        rep_name: repName || null,
        rep_email: repEmail || null,
        duration_seconds: durationSeconds || 0,
        gong_url: gongUrl || null,
        analysis,
        analyzed_at: new Date().toISOString(),
        transcript_text: transcriptText || null,
        derived_call_type: deriveDerivedCallType(title),
        call_category: deriveCallCategory(deriveDerivedCallType(title)),
        ...noShowFlags,
      },
      { onConflict: 'gong_call_id' }
    );

    if (upsertError) {
      console.error('intel-analyze: Supabase write failed for', callId, upsertError.message, upsertError.code, upsertError.details);
      // Claimed the row but could not persist the analysis — release so a later poll retries.
      if (claimedRow) {
        try { await db.from('gong_call_analyses').update({ analyzed_at: null }).eq('gong_call_id', callId); }
        catch (e) { console.error('[intel-analyze] claim release (upsert fail) failed for', callId, e.message); }
      }
    } else if (isNoShowCall) {
      // No-show: it's flagged ignored above and kept for the record, but it has no real content —
      // skip tasks, transcript insert, account write-back, and coaching so it stays out of the workflow.
      console.log('[intel-analyze] no-show detected — flagged ignored, skipping tasks/transcript/coaching for', callId);
    } else {
      const callCat = deriveCallCategory(deriveDerivedCallType(title));

      // Resolve the account FIRST so tasks, transcript, and coaching all share the same id
      // (and Gong tasks land on their account instead of NULL).
      let accountId = await tryMatchCallToAccount(callId, title, db);
      if (!accountId) {
        const { data: row } = await db.from('gong_call_analyses').select('account_id').eq('gong_call_id', callId).maybeSingle();
        accountId = row?.account_id || null;
      }

      // Auto-create tasks (gated inside). Awaited so the pre-generated drafts persist on serverless.
      try {
        await autoCreateTasksFromAnalysis({ callId, title, date, repEmail, repName, analysis, durationSeconds, callCategory: callCat, accountId, attendees: callAttendees, db });
      } catch (e) { console.error('[intel-analyze] autoCreateTasksFromAnalysis error:', e.message); }

      // Insert transcript, then per-call coaching DM (auto-process reps, sales calls, fresh only).
      try {
        await autoInsertTranscript({ accountId, callId, transcriptText, date, callType, analysis, gongUrl, db });
        // Write MEDDICC/stakeholders/gaps back to the account (North Star output a, §1.8/§2.2). Fires
        // for any sales call with a resolved account — this is account data, not rep-gated. Best-effort.
        if (accountId && callCat !== 'cs') { await writeBackFromAnalysis(db, accountId, analysis, callId, date); await writeAccountSignals(db, accountId, analysis, date); }
        const autoProcess = isAutoProcessRep(repEmail) || isAutoProcessRep(repName);
        const isFreshForCoaching = date && (Date.now() - new Date(date).getTime()) < AUTO_TASK_MAX_AGE_MS;
        if (autoProcess && callCat !== 'cs' && isFreshForCoaching && repEmail) {
          let accountName = null;
          if (accountId) {
            const { data: acct } = await db.from('accounts').select('name').eq('id', accountId).maybeSingle();
            accountName = acct?.name || null;
          }
          await sendCallCoachingDM({ analysis, callTitle: title, callDate: date, accountName, repEmail, gongCallId: callId });
        }
      } catch (e) { console.error('[intel-analyze] transcript+coaching chain error:', e.message); }
    }

    // Always return the analysis even if the DB write failed —
    // the UI will update in-memory and show a persistence warning if needed
    return apiSuccess(res, {
      callId,
      analysis,
      persisted: !upsertError,
      persistError: upsertError ? upsertError.message : null,
    });
  } catch (error) {
    console.error('intel-analyze error:', error);
    // Release a claim taken before the failure so the call is retried, not stuck "analyzed".
    if (claimedRow) {
      try { await db.from('gong_call_analyses').update({ analyzed_at: null }).eq('gong_call_id', callId); }
      catch (e) { console.error('[intel-analyze] claim release failed for', callId, e.message); }
    }
    return apiError(res, 500, error.message);
  }
}
