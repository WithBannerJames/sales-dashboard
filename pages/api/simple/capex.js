// GET /api/simple/capex?id=<accountId>[&refresh=1]
// What we understand about THIS customer's CapEx process, area by area.
//
// Distinct from /api/simple/gaps: that answers "is this deal qualified" (MEDDPICC). This
// answers "do we understand how they actually run CapEx" — bidding, invoicing, budgeting,
// reporting, asset tracking and the rest. James: "what I want to know is their capex process...
// what don't we understand? This will help us."
//
// Per area, when the calls support it: current process, problems, what we've discussed Banner
// doing, their stated priority, plus a relevance of high/medium/low informed by how many
// separate calls covered it ("if we've had three separate calls on bidding, that's high").
// Areas with no evidence are returned as gaps — that list is the point.
//
// Reuses the existing definitions rather than inventing a taxonomy:
//   BUSINESS_AREAS   (lib/constants.js)      — the 19 CapEx areas
//   BANNER_SOLUTIONS (lib/bannerSolutions.js) — what we normally propose per area
//
// Cached on accounts.business_areas, same freshness rules as the MEDDPICC read.
// No auth (wide-open internal page) — service-role only.

import { getSupabase } from '../../../lib/supabase';
import { callAnthropic, parseClaudeJson } from '../../../lib/apiUtils';
import { CLAUDE_MODELS, WORKING_STAGE_IDS, BUSINESS_AREAS } from '../../../lib/constants';
import { BANNER_SOLUTIONS } from '../../../lib/bannerSolutions';

export const config = { maxDuration: 300 };

// Bump to invalidate every stored read (same pattern as ANALYSIS_VERSION).
const CAPEX_VERSION = 1;
const TRANSCRIPT_BUDGET = 100000;
const RELEVANCE = new Set(['high', 'medium', 'low']);

function buildContext(calls) {
  let used = 0;
  const parts = [];
  for (const c of calls) {
    const head = `\n=== CALL: ${c.title || 'Untitled'} (${(c.call_date || '').slice(0, 10)}) ===\n`;
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

function shape(stored) {
  const by = Object.fromEntries((stored || []).map((a) => [a.id, a]));
  const covered = [];
  const notCovered = [];
  for (const area of BUSINESS_AREAS) {
    const s = by[area.id];
    if (s && RELEVANCE.has(s.relevance)) {
      covered.push({
        id: area.id,
        label: area.label,
        description: area.description,
        relevance: s.relevance,
        callsCovering: s.callsCovering ?? null,
        currentProcess: s.currentProcess || null,
        problems: s.problems || null,
        bannerDiscussed: s.bannerDiscussed || null,
        priority: s.priority || null,
        evidence: s.evidence || null,
      });
    } else {
      notCovered.push({ id: area.id, label: area.label, description: area.description });
    }
  }
  const order = { high: 0, medium: 1, low: 2 };
  covered.sort((a, b) => (order[a.relevance] - order[b.relevance]) || (b.callsCovering || 0) - (a.callsCovering || 0));
  return { covered, notCovered };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  const { id, refresh } = req.query;
  if (!id) return res.status(400).json({ error: 'id required' });

  try {
    const db = getSupabase();
    const { data: deal } = await db
      .from('accounts')
      .select('id, name, stage, parent_account_id, business_areas')
      .eq('id', id)
      .maybeSingle();
    if (!deal) return res.status(404).json({ error: 'Deal not found' });

    if (!WORKING_STAGE_IDS.includes(deal.stage)) {
      return res.status(200).json({ dealId: deal.id, status: 'not_in_scope', ...shape([]) });
    }

    const rootId = deal.parent_account_id || deal.id;
    const { data: kids } = await db.from('accounts').select('id').eq('parent_account_id', rootId);
    const familyIds = [...new Set([deal.id, rootId, ...(kids || []).map((k) => k.id)])];

    const { data: calls } = await db
      .from('gong_call_analyses')
      .select('gong_call_id, title, call_date, analysis, transcript_text')
      .in('account_id', familyIds)
      .eq('ignored', false)
      .or('call_category.is.null,call_category.neq.internal')
      .order('call_date', { ascending: false })
      .limit(40);

    const withText = (calls || []).filter((c) => (c.transcript_text || '').length > 50);
    if (!withText.length) {
      return res.status(200).json({
        dealId: deal.id,
        status: 'no_transcripts',
        message: 'No conversations with transcripts are linked to this deal yet.',
        ...shape([]),
      });
    }

    const latest = withText[0]?.call_date || '';
    const stored = deal.business_areas && !Array.isArray(deal.business_areas) ? deal.business_areas : null;
    const meta = stored?._meta || null;
    const isFresh = meta
      && meta.version === CAPEX_VERSION
      && meta.newestCall === latest
      && meta.callCount === withText.length;

    if (isFresh && !refresh) {
      return res.status(200).json({
        dealId: deal.id,
        status: 'ok',
        cached: true,
        ...shape(stored.areas),
        basedOn: { calls: meta.callCount, newestCall: meta.newestCall },
        generatedAt: meta.analyzedAt,
      });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

    const areaSpec = BUSINESS_AREAS
      .map((a) => {
        const sol = BANNER_SOLUTIONS[a.id];
        const what = sol?.length ? `\n       Banner normally offers: ${sol.slice(0, 3).join('; ')}` : '';
        return `  "${a.id}" — ${a.label}: ${a.description}${what}`;
      })
      .join('\n');

    const system = `You map how a prospect currently runs their capital-expenditure process, for Banner (CapEx management software). You report ONLY what the call transcripts support.

Rules:
- Include an area ONLY if the transcripts actually discuss it. Omit everything else — the areas you omit are treated as "we don't understand this yet", which is the most useful output.
- relevance reflects how central the area is to THIS customer and how much it has been discussed: "high" = covered substantively, typically across more than one call, or named as a priority; "medium" = discussed once with real detail; "low" = mentioned only in passing.
- callsCovering = how many DISTINCT calls discussed the area.
- Never invent a Banner capability. Only say what was actually discussed on the calls; the "Banner normally offers" notes are context for recognising the topic, not things to claim were promised.
- Keep every field to one tight sentence. No filler.
- Output JSON only, no preamble.`;

    const prompt = `Customer: ${deal.name}

CapEx areas to look for:
${areaSpec}

Return exactly this JSON shape, including only areas the transcripts actually cover:
{
  "areas": [
    {
      "id": "<area_id>",
      "relevance": "high" | "medium" | "low",
      "callsCovering": <number of distinct calls>,
      "currentProcess": "how they do it today",
      "problems": "what is broken or costly about it",
      "bannerDiscussed": "what we have actually discussed Banner doing here, or null",
      "priority": "their stated urgency for fixing it, or null",
      "evidence": "short verbatim quote from a transcript"
    }
  ]
}

TRANSCRIPTS (newest first):
${buildContext(withText)}`;

    const raw = await callAnthropic(apiKey, {
      model: CLAUDE_MODELS.SONNET,
      maxTokens: 5000,
      system,
      messages: [{ role: 'user', content: prompt }],
    });
    const parsed = parseClaudeJson(raw, {});
    if (parsed?.parseError) {
      console.error('[simple/capex] parse failed for', deal.id, parsed.parseError);
      return res.status(502).json({ error: 'Could not parse the CapEx read', detail: parsed.parseError });
    }

    const valid = new Set(BUSINESS_AREAS.map((a) => a.id));
    const areas = (Array.isArray(parsed.areas) ? parsed.areas : [])
      .filter((a) => a && valid.has(a.id) && RELEVANCE.has(a.relevance))
      .map((a) => ({
        id: a.id,
        relevance: a.relevance,
        callsCovering: Number.isFinite(a.callsCovering) ? a.callsCovering : null,
        currentProcess: a.currentProcess || null,
        problems: a.problems || null,
        bannerDiscussed: a.bannerDiscussed || null,
        priority: a.priority || null,
        evidence: a.evidence || null,
      }));

    const analyzedAt = new Date().toISOString();
    await db.from('accounts').update({
      business_areas: {
        areas,
        _meta: { version: CAPEX_VERSION, analyzedAt, newestCall: latest, callCount: withText.length },
      },
    }).eq('id', deal.id);

    return res.status(200).json({
      dealId: deal.id,
      status: 'ok',
      cached: false,
      ...shape(areas),
      basedOn: { calls: withText.length, newestCall: latest },
      generatedAt: analyzedAt,
    });
  } catch (e) {
    console.error('[simple/capex]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
