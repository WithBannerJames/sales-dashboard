// Shared call classification helpers.
// Category is a pure title-keyword heuristic (no LLM), so it can be computed at
// import time — before analysis — which lets the backfill route which calls get
// analyzed. Internal detection is participant-based (Banner-only calls).
// Used by pages/api/gong/intel-analyze.js and pages/api/gong/backfill-historical.js.

export function deriveDerivedCallType(title) {
  if (!title) return 'unknown';
  const t = title.toLowerCase();
  if (/\bimplementation\b|\bonboarding\b|\bgo.?live\b/.test(t)) return 'implementation';
  if (/\btraining\b/.test(t)) return 'training';
  if (/\bintro\b|\bintroduction\b/.test(t)) return 'intro';
  if (/\bdemo\b/.test(t)) return 'demo';
  if (/\bqbr\b|\bbusiness review\b|\bcustomer success\b|\boffice hours\b|\bweekly\b|\bbiweekly\b|\bmonthly\b|\bquarterly\b|\bcadence\b|\bcheck.?in\b|\bsync\b/.test(t)) return 'customer_success';
  if (/\bpilot\b|\bpoc\b|\bevaluation\b|\bdiscovery\b|\bscoping\b|\bpricing\b|\bproposal\b|\blegal\b|\bcontract\b|\bmsa\b/.test(t)) return 'solution_validation';
  return 'other';
}

export function deriveCallCategory(derivedType) {
  if (['implementation', 'training', 'customer_success'].includes(derivedType)) return 'cs';
  if (['intro', 'demo', 'solution_validation', 'other'].includes(derivedType)) return 'sales';
  return 'unknown';
}

// Convenience: title straight to a category.
export function categoryFromTitle(title) {
  return deriveCallCategory(deriveDerivedCallType(title));
}

// A call with participants that are ALL Banner-internal (no external/prospect party)
// is an internal meeting — Monday kickoff, AE review, pipeline review, etc.
// Conservative: an empty party list or any non-'internal' affiliation (including
// 'unknown') is NOT treated as internal, so a real prospect call is never mislabeled.
export function isInternalCall(parties) {
  const list = Array.isArray(parties) ? parties : [];
  if (!list.length) return false;
  return list.every(p => String(p?.affiliation || '').toLowerCase() === 'internal');
}
