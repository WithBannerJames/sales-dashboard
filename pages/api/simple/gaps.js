// GET /api/simple/gaps?id=<accountId>[&refresh=1]
// The gap engine. Reads a deal's stored Gong transcripts out of Supabase and extracts all 8
// MEDDPICC elements with a verbatim evidence quote, plus an assessment of the current stage's
// exit criteria. Zero data entry by design.
//
// Why this exists rather than just reading gong_call_analyses.analysis.meddicc: only ~184 of
// 4,125 analysed calls carry a meddicc object at all (most were analysed before that
// extraction existed), so across the 79 live deals metrics was 0/79 and paper_process 0/79.
// The information is in the transcripts; it had never been pulled out.
//
// Scope + freshness (James, 2026-09):
//   * Only deals in a working stage are analysed (WORKING_STAGE_IDS). Dead/closed deals never are.
//   * A deal is re-analysed when it ENTERS a working stage — including a deal that left and came
//     back. Detected by comparing the stored analysis timestamp against the most recent
//     account_stage_history entry INTO the current stage, so an out-and-back-in round trip is
//     caught even though the stage name is unchanged.
//   * Also re-analysed when a new conversation lands.
//
// The result is persisted on accounts.meddicc: the 8 values fill blanks only (a manual or
// earlier value always wins), and the full read — evidence quotes, stage-exit assessment,
// provenance — is stored under the reserved `_meta` key so reopening a deal is instant.
// `_meta` is safe there: every consumer looks up known MEDDPICC keys, none iterate blindly.
//
// No auth (wide-open internal page) — service-role reads/writes only.

import { getSupabase } from '../../../lib/supabase';
import { callAnthropic, parseClaudeJson } from '../../../lib/apiUtils';
import { CLAUDE_MODELS, WORKING_STAGE_IDS } from '../../../lib/constants';
import { MEDDPICC_ELEMENTS, MEDDPICC_KEYS, readValue, ANALYSIS_VERSION } from '../../../lib/meddpicc';
import { criteriaForStage, stageDetail } from '../../../lib/stageExitCriteria';
import { AUTO_PROCESS_REPS, COACH_REPS, EXCLUDED_REPS } from '../../../lib/repConfig';

// Banner's own people. They are the sellers, so they can never satisfy a MEDDPICC element —
// a real extraction named "Kristin Wanner (Banner rep)" as a customer champion.
// Multi-token names only: bare first names like "Josh" or "Amber" would match real prospects,
// the same trap lib/accountWriteback.js already had to fix.
const INTERNAL_PEOPLE = [...new Set([
  ...AUTO_PROCESS_REPS.map((r) => r.name),
  ...COACH_REPS.map((r) => r.name),
  ...EXCLUDED_REPS,
  'Mark Murphy',
  'Kristin Wanner',
].filter((n) => n && n.includes(' ')))];

export const config = { maxDuration: 300 };

const TRANSCRIPT_BUDGET = 100000; // chars of full transcript; older calls fall back to summaries

function buildContext(calls) {
  let used = 0;
  const parts = [];
  for (const c of calls) {
    const head = `\n=== CALL: ${c.title || 'Untitled'} (${(c.call_date || '').slice(0, 10)}, rep: ${c.rep_name || 'unknown'}) ===\n`;
    const t = c.transcript_text || '';
    if (t.length > 50 && used < TRANSCRIPT_BUDGET) {
      const room = TRANSCRIPT_BUDGET - used;
      const body = t.length <= room ? t : `${t.slice(0, room)}\n[transcript truncated]`;
      parts.push(head + body);
      used += body.length;
    } else {
      const s = c.analysis?.summary;
      parts.push(`${head}[transcript not included] ${s ? `Summary: ${s}` : 'No summary available.'}`);
    }
  }
  return parts.join('\n');
}

// Merge a stored lean result back onto the current element definitions, so labels, rationale
// and suggested questions always come from lib/meddpicc rather than a stale snapshot.
function hydrate(lean = []) {
  const by = Object.fromEntries(lean.map((e) => [e.id, e]));
  return MEDDPICC_ELEMENTS.map((el) => {
    const s = by[el.id];
    return {
      ...el,
      captured: !!s?.captured,
      value: s?.value || null,
      shortfall: s?.shortfall || null,
      evidence: s?.evidence || null,
      sourceCall: s?.sourceCall || null,
    };
  });
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  const { id, refresh } = req.query;
  if (!id) return res.status(400).json({ error: 'id required' });

  try {
    const db = getSupabase();

    const { data: deal } = await db
      .from('accounts')
      .select('id, name, stage, parent_account_id, meddicc')
      .eq('id', id)
      .maybeSingle();
    if (!deal) return res.status(404).json({ error: 'Deal not found' });

    // Scope: dead and closed deals are never analysed.
    if (!WORKING_STAGE_IDS.includes(deal.stage)) {
      return res.status(200).json({
        dealId: deal.id,
        status: 'not_in_scope',
        message: `Deal analysis only runs for live stages. This deal is ${deal.stage}.`,
        elements: hydrate([]),
        capturedCount: 0,
        total: MEDDPICC_KEYS.length,
        stageExit: [],
      });
    }

    const rootId = deal.parent_account_id || deal.id;
    const { data: kids } = await db.from('accounts').select('id').eq('parent_account_id', rootId);
    const familyIds = [...new Set([deal.id, rootId, ...(kids || []).map((k) => k.id)])];

    const { data: calls } = await db
      .from('gong_call_analyses')
      .select('gong_call_id, title, rep_name, call_date, analysis, transcript_text')
      .in('account_id', familyIds)
      .eq('ignored', false)
      // Deliberately NOT requiring analyzed_at. This read does its own pass over
      // transcript_text, so a call only needs a stored transcript to count. That makes CS
      // conversations usable here without spending a Haiku analysis on each one — the
      // per-call analysis is for the conversation list, not for this.
      .or('call_category.is.null,call_category.neq.internal')
      .order('call_date', { ascending: false })
      .limit(40);

    const withText = (calls || []).filter((c) => (c.transcript_text || '').length > 50);
    if (!withText.length) {
      return res.status(200).json({
        dealId: deal.id,
        status: 'no_transcripts',
        message: 'No conversations with transcripts are linked to this deal yet.',
        elements: hydrate([]),
        capturedCount: 0,
        total: MEDDPICC_KEYS.length,
        stageExit: criteriaForStage(deal.stage).map((c) => ({ ...c, met: false, note: 'No call record to assess against.' })),
      });
    }

    // When did this deal most recently ENTER its current stage?
    const { data: entries } = await db
      .from('account_stage_history')
      .select('changed_at')
      .eq('account_id', deal.id)
      .eq('to_stage', deal.stage)
      .order('changed_at', { ascending: false })
      .limit(1);
    const stageEnteredAt = entries?.[0]?.changed_at || null;

    const latest = withText[0]?.call_date || '';
    const meta = deal.meddicc?._meta || null;
    const isFresh =
      meta &&
      meta.newestCall === latest &&
      meta.callCount === withText.length &&
      meta.version === ANALYSIS_VERSION &&
      meta.stage === deal.stage &&
      (!stageEnteredAt || new Date(meta.analyzedAt) >= new Date(stageEnteredAt));

    if (isFresh && !refresh) {
      return res.status(200).json({
        dealId: deal.id,
        status: 'ok',
        cached: true,
        elements: hydrate(meta.elements),
        capturedCount: (meta.elements || []).filter((e) => e.captured).length,
        total: MEDDPICC_KEYS.length,
        stageExit: criteriaForStage(deal.stage).map((c) => {
          const a = (meta.stageExit || []).find((x) => x.id === c.id);
          return { ...c, met: !!a?.met, note: a?.note || null };
        }),
        recommendation: meta.recommendation || null,
        stage: stageDetail(deal.stage),
        basedOn: { calls: meta.callCount, newestCall: meta.newestCall },
        generatedAt: meta.analyzedAt,
      });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

    const criteria = criteriaForStage(deal.stage);
    const detail = stageDetail(deal.stage);

    // Elements carry Banner's own definitions; `bar` (currently Champion) is the explicit
    // standard the model must hold a claim to.
    const elementSpec = MEDDPICC_ELEMENTS
      .map((e) => `  "${e.id}": ${e.label} — ${e.description}${e.bar ? `\n      STANDARD: ${e.bar}` : ''}`)
      .join('\n');
    const criteriaSpec = criteria.length
      ? criteria.map((c) => `  "${c.id}": ${c.label}`).join('\n')
      : '  (no criteria defined for this stage)';
    const killSpec = detail?.killWhen?.length
      ? `\nThis deal should be CLOSED OUT when any of these is true:\n${detail.killWhen.map((k) => `  - ${k}`).join('\n')}`
      : '';
    const goalSpec = detail?.goal ? `\nGoal of this stage: ${detail.goal}` : '';
    const guidanceSpec = detail?.guidance ? `\nJudging guidance: ${detail.guidance}` : '';

    const system = `You audit B2B sales deals for Banner, a CapEx management software company. You read call transcripts and report ONLY what the transcripts actually support.

Rules:
- Every element carries an explicit "met" boolean. Set met=true ONLY if the transcripts positively establish it. If it is absent, partial, or fails the element's STANDARD, set met=false.
- When met=false, "value" must state in one line what is missing or why it falls short. NEVER describe a shortfall while claiming met=true.
- When met=true you MUST include a short verbatim quote as evidence and the exact call title it came from.
- Be strict. "They mentioned budget exists" is not an Economic Buyer unless a specific person with budget authority is named.
- Where an element carries a STANDARD, hold the claim to that standard exactly. Enthusiasm is not evidence.
- Banner's own people are the SELLERS, never the customer's champion, economic buyer or stakeholder. Never name any of these as an element: ${INTERNAL_PEOPLE.join(', ')}.
- Your stage_exit assessment and your elements must agree. If you judge the champion criterion unmet, champion.met must be false.
- Output JSON only, no preamble.`;

    const prompt = `Deal: ${deal.name} — current stage: ${detail?.label || deal.stage}${goalSpec}${guidanceSpec}

Extract the 8 MEDDPICC elements:
${elementSpec}

Assess this stage's exit criteria — all must be true for the deal to move forward:
${criteriaSpec}${killSpec}

Return exactly this JSON shape:
{
  "meddpicc": {
    "<element_id>": { "met": true|false, "value": "what is established, or what is missing", "evidence": "verbatim quote (only when met=true)", "call": "exact call title (only when met=true)" }
  },
  "stage_exit": [ { "id": "<criterion_id>", "met": true|false, "note": "one short line citing why" } ],
  "recommendation": { "verdict": "advance" | "progress" | "exit", "reason": "one short line" }
}

"advance" only if every exit criterion is met. "exit" if a close-out condition above is true. Otherwise "progress".

TRANSCRIPTS (newest first):
${buildContext(withText)}`;

    const raw = await callAnthropic(apiKey, {
      model: CLAUDE_MODELS.SONNET,
      maxTokens: 4000,
      system,
      messages: [{ role: 'user', content: prompt }],
    });
    const parsed = parseClaudeJson(raw, {});
    if (parsed?.parseError) {
      console.error('[simple/gaps] parse failed for', deal.id, parsed.parseError);
      return res.status(502).json({ error: 'Could not parse the gap analysis', detail: parsed.parseError });
    }

    const extracted = parsed.meddpicc || {};
    const knownTitles = new Set(withText.map((c) => c.title));

    const elements = MEDDPICC_ELEMENTS.map((el) => {
      const hit = extracted[el.id];
      const value = hit ? readValue(hit.value) : null;
      // An element counts only when the model explicitly says it is met. Previously any prose
      // counted as captured, so "X is a promoter, not a champion" scored as a captured Champion
      // and inflated every deal's total.
      const claimed = !!hit && hit.met === true && !!value;
      // Banner's own people can never satisfy an element — they are the sellers.
      const namesInternal = value ? INTERNAL_PEOPLE.some((n) => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(value)) : false;
      const captured = claimed && !namesInternal;
      if (!captured) {
        return {
          ...el,
          captured: false,
          // Keep the model's reasoning — it says what is missing, which is the useful part.
          value: null,
          shortfall: value && !namesInternal ? value : null,
          evidence: null,
          sourceCall: null,
        };
      }
      return {
        ...el,
        captured: true,
        value,
        shortfall: null,
        evidence: readValue(hit.evidence),
        // Only trust a call attribution that matches a real call on this deal.
        sourceCall: hit.call && knownTitles.has(hit.call) ? hit.call : null,
      };
    });

    const assessed = Array.isArray(parsed.stage_exit) ? parsed.stage_exit : [];
    const stageExit = criteria.map((c) => {
      const a = assessed.find((x) => x.id === c.id);
      return { ...c, met: !!a?.met, note: readValue(a?.note) || null };
    });

    const rec = parsed.recommendation && ['advance', 'progress', 'exit'].includes(parsed.recommendation.verdict)
      ? { verdict: parsed.recommendation.verdict, reason: readValue(parsed.recommendation.reason) || null }
      : null;

    const analyzedAt = new Date().toISOString();
    const lean = elements.map((e) => ({
      id: e.id, captured: e.captured, value: e.value, shortfall: e.shortfall, evidence: e.evidence, sourceCall: e.sourceCall,
    }));

    // Persist: values fill blanks only; the rich read goes under _meta.
    // The analysis is authoritative, not fill-blanks-only. It used to only fill empty keys, so
    // when the scoring rules tightened, run 1's inflated values survived and kept the deal list
    // showing 8/8 while this endpoint said 3/8. Nothing writes these keys by hand — there is no
    // manual edit path — so the current analysis always wins, and an element that is no longer
    // met is cleared rather than left behind.
    const current = deal.meddicc || {};
    const merged = { ...current };
    let wrote = 0;
    for (const e of elements) {
      const next = e.captured ? e.value : null;
      if (readValue(current[e.id]) !== next) wrote++;
      merged[e.id] = next;
    }
    merged._meta = {
      analyzedAt,
      version: ANALYSIS_VERSION,
      stage: deal.stage,
      newestCall: latest,
      callCount: withText.length,
      elements: lean,
      stageExit: stageExit.map((s) => ({ id: s.id, met: s.met, note: s.note })),
      recommendation: rec,
    };
    const { error: upErr } = await db.from('accounts').update({ meddicc: merged }).eq('id', deal.id);
    if (upErr) console.error('[simple/gaps] writeback failed', upErr.message);

    return res.status(200).json({
      dealId: deal.id,
      status: 'ok',
      cached: false,
      elements,
      capturedCount: elements.filter((e) => e.captured).length,
      total: MEDDPICC_KEYS.length,
      stageExit,
      recommendation: rec,
      stage: detail,
      basedOn: { calls: withText.length, newestCall: latest },
      newValuesWritten: wrote,
      generatedAt: analyzedAt,
    });
  } catch (e) {
    console.error('[simple/gaps]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
