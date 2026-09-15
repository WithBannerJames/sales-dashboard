// Account write-back — the North Star "output (a)" that was never built (PLATFORM_REVIEW §1.8/§2.2).
// The Gong engine analyzes every call but never wrote MEDDICC/stakeholders/gaps back to the account,
// so reps hand-entered them and accounts.meddicc (read by ~9 generators) was always empty. This
// persists the engine's per-call extraction onto the account. Best-effort — never throws into the
// analysis path. Merges conservatively so manual edits are never clobbered.
import { STAKEHOLDER_ROLES } from './constants';
import { AUTO_PROCESS_REPS, COACH_REPS, EXCLUDED_REPS } from './repConfig';

const VALID_ROLES = new Set(STAKEHOLDER_ROLES.map((r) => r.value));

// Never store a Banner rep / CS person as a prospect stakeholder — extraction sometimes picks up the
// person on the call. Match EXACT names only. No bare-first-name matching: a set built from first
// names would fold in common prospect names (David, Josh, Kelly, Chris…) and silently drop real
// stakeholders — including champions — that a transcript captured by first name alone. Single-token
// names are included only for the auto-process SALES reps who actually appear on these calls
// (Kristin); ambiguous CS first names are matched by their full name only. (Same set as the one-time
// stakeholder cleanup delete.)
const INTERNAL_NAMES = new Set([
  ...AUTO_PROCESS_REPS.map((r) => r.name),                 // James Lindberg, Logan King, Kristin
  ...COACH_REPS.map((r) => r.name),                        // James Lindberg
  'Mark Murphy',
  ...EXCLUDED_REPS.filter((n) => n.includes(' ')),         // multi-token CS names only (Kyle Schneider, Wendy Ford, Chris Whitney)
].map((n) => (n || '').toLowerCase().trim()));
function isInternalPerson(name) {
  return INTERNAL_NAMES.has((name || '').toLowerCase().trim());
}
// All 8 MEDDPICC elements (paper_process added 2026-09). Note this is also the
// completeness denominator in writeAccountSignals below.
const MEDDIC_KEYS = ['metrics', 'economic_buyer', 'decision_criteria', 'decision_process', 'paper_process', 'identify_pain', 'champion', 'competition'];
const isBlank = (v) => {
  const s = typeof v === 'string' ? v.trim() : v?.value ? String(v.value) : '';
  return !s || ['unknown', 'none', 'n/a', 'null'].includes(s.toLowerCase());
};

export async function writeBackFromAnalysis(db, accountId, analysis, callId = null, callDate = null) {
  if (!db || !accountId || !analysis) return;
  // Provenance stamped on any row we create, so every derived fact links back to its call (Principle 4).
  const ev = callId ? [{ call_id: String(callId), captured_at: callDate || null }] : [];
  try {
    // 1) MEDDICC → accounts.meddicc. Prefer the model's emitted meddicc, fall back to the flat
    //    fields it already produces. Only fill keys that are currently empty (manual wins).
    const emitted = analysis.meddicc || {};
    const synth = {
      identify_pain: analysis.pain_depth_notes || null,
      champion: analysis.champion_health_notes || null,
      competition: (analysis.competitor_mentions || []).map((c) => (typeof c === 'string' ? c : c?.name)).filter(Boolean).join(', ') || null,
    };
    const { data: acct } = await db.from('accounts').select('meddicc').eq('id', accountId).maybeSingle();
    const existing = (acct && acct.meddicc) || {};
    const merged = { ...existing };
    let changed = false;
    for (const k of MEDDIC_KEYS) {
      if (!isBlank(existing[k])) continue;
      const val = !isBlank(emitted[k]) ? String(emitted[k]).trim() : synth[k];
      if (val && !isBlank(val)) { merged[k] = val; changed = true; }
    }
    if (changed) await db.from('accounts').update({ meddicc: merged }).eq('id', accountId);

    // 2) Stakeholders → upsert by (account_id, name). New names inserted; known names get title/role
    //    filled only if missing (don't overwrite a human-set role).
    for (const s of (analysis.stakeholders || []).slice(0, 8)) {
      const name = (s?.name || '').trim();
      if (!name || name.length < 2) continue;
      if (isInternalPerson(name)) continue; // don't store Banner reps/CS as prospect stakeholders
      let role = VALID_ROLES.has(s.role) ? s.role : null;
      if (!role && s.is_champion) role = 'Champion'; // champion is captured via role (no is_champion column)
      const { data: ex } = await db.from('stakeholders').select('id, title, role').eq('account_id', accountId).ilike('name', name).maybeSingle();
      if (ex?.id) {
        const patch = {};
        if (!ex.title && s.title) patch.title = s.title;
        if (!ex.role && role) patch.role = role;
        if (Object.keys(patch).length) await db.from('stakeholders').update(patch).eq('id', ex.id);
      } else {
        await db.from('stakeholders').insert({
          account_id: accountId, name, title: s.title || null, role,
          role_guess: role ? role.toLowerCase().replace(/\s+/g, '_') : null,
          evidence: ev, source_call_id: callId ? String(callId) : null, first_seen_call: callId ? String(callId) : null,
        });
      }
    }

    // 3) Information gaps → insert new open questions (dedup by question text).
    const gaps = (analysis.information_gaps || []).slice(0, 6);
    if (gaps.length) {
      const { data: exGaps } = await db.from('information_gaps').select('question').eq('account_id', accountId);
      const seen = new Set((exGaps || []).map((g) => (g.question || '').toLowerCase().trim()));
      const toInsert = gaps
        .map((g) => ({ question: (typeof g === 'string' ? g : g?.question) || '', category: (typeof g === 'object' ? g?.category : null) || 'other', status: 'open', account_id: accountId, evidence: ev, source_call_id: callId ? String(callId) : null }))
        .filter((g) => g.question.length > 5 && !seen.has(g.question.toLowerCase().trim()));
      if (toInsert.length) await db.from('information_gaps').insert(toInsert);
    }
  } catch (e) {
    console.error('[accountWriteback] failed for', accountId, e.message);
  }
}

const SENTIMENT_NUM = { positive: 1, neutral: 0, negative: -1 };

// Roll each analyzed sales call into account_signals: latest sentiment/engagement/talk-ratio +
// MEDDICC completeness + a small trend series. Scalar "latest" fields only advance on the newest
// call (older backfilled calls still contribute to the trend). Best-effort — never throws.
export async function writeAccountSignals(db, accountId, analysis, callDate) {
  if (!db || !accountId || !analysis) return;
  try {
    const sentiment = SENTIMENT_NUM[String(analysis.sentiment || '').toLowerCase()] ?? null;
    const engagement = Number.isFinite(analysis.champion_health_score) ? analysis.champion_health_score : null;
    const talk = Number.isFinite(analysis.rep_talk_ratio) ? analysis.rep_talk_ratio : null;
    const at = (callDate ? new Date(callDate) : new Date()).toISOString();

    const { data: acct } = await db.from('accounts').select('meddicc').eq('id', accountId).maybeSingle();
    const m = (acct && acct.meddicc) || {};
    const completeness = MEDDIC_KEYS.filter((k) => !isBlank(m[k])).length / MEDDIC_KEYS.length;

    const { data: existing } = await db.from('account_signals').select('last_call_at, trend').eq('account_id', accountId).maybeSingle();
    const isNewer = !existing?.last_call_at || new Date(at) >= new Date(existing.last_call_at);

    const day = at.slice(0, 10);
    const trend = (Array.isArray(existing?.trend) ? existing.trend : []).filter((p) => p?.date !== day);
    trend.push({ date: day, sentiment, engagement });
    trend.sort((a, b) => (a.date < b.date ? -1 : 1));

    const row = { account_id: accountId, meddicc_completeness: completeness, trend: trend.slice(-12), updated_at: new Date().toISOString() };
    if (isNewer) { row.sentiment = sentiment; row.engagement = engagement; row.rep_talk_ratio = talk; row.last_call_at = at; }
    await db.from('account_signals').upsert(row, { onConflict: 'account_id' });
  } catch (e) {
    console.error('[accountSignals] failed for', accountId, e.message);
  }
}
