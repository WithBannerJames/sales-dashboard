// The single definition of MEDDPICC for the deal view: the 8 elements, why each matters,
// curated discovery questions, and how a deal's current state is aggregated from its calls.
// The "why"/questions content for the original 7 is lifted from the old Information Gaps tab
// (components/tabs/InformationGapsTab.jsx) so the wording stays consistent with what the
// team already read there. Paper Process is new (2026-09).

export const MEDDPICC_ELEMENTS = [
  {
    id: 'metrics',
    label: 'Metrics',
    description: 'Quantifiable measures of success',
    why: "Without quantifiable metrics, you can't build a compelling ROI case or justify the investment to economic buyers.",
    questions: [
      'What metrics do you use to measure success in your CapEx program?',
      'How much are you currently spending annually on construction/renovations?',
      'What would a 10% improvement in project costs mean for your business?',
    ],
  },
  {
    id: 'economic_buyer',
    label: 'Economic Buyer',
    description: 'Person with budget authority',
    why: 'Deals stall without access to the person who controls the budget. They need to be convinced of the business value.',
    questions: [
      'Who ultimately signs off on investments of this size?',
      'Who controls the budget for construction and capital improvements?',
      'Is there a specific approval process for software investments?',
    ],
  },
  {
    id: 'decision_criteria',
    label: 'Decision Criteria',
    description: 'Formal criteria for evaluation',
    why: 'Understanding their formal and informal criteria lets you position against competition and address concerns proactively.',
    questions: [
      'What factors are most important in your evaluation?',
      'Are there must-have features vs nice-to-haves?',
      "What would make this a clear 'yes' for your team?",
    ],
  },
  {
    id: 'decision_process',
    label: 'Decision Process',
    description: 'Steps to make a decision',
    why: 'Knowing the timeline and steps prevents surprises and helps you plan resources and forecast accurately.',
    questions: [
      'What does your typical buying process look like for software?',
      'Who needs to be involved in the final decision?',
      "What's a realistic timeline for making a decision?",
    ],
  },
  {
    id: 'paper_process',
    label: 'Paper Process',
    description: 'Procurement, legal, security review and signature path',
    why: 'Late-stage deals stall in procurement and legal, not in sales. Mapping the paper path is what makes a close date real.',
    questions: [
      "Once we agree commercially, what's the path to signature — procurement, legal, security review?",
      'Who owns contract review on your side, and how long does that usually take?',
      'Is there a security review or vendor onboarding process we should start in parallel?',
    ],
  },
  {
    id: 'identify_pain',
    label: 'Identify Pain',
    description: 'Key pain points driving change',
    why: "Pain is the #1 driver of change. Without clear pain, there's no urgency and status quo wins.",
    questions: [
      "What's the biggest challenge you're facing with your current process?",
      'What happens when projects go over budget or timeline?',
      'What keeps you up at night about your CapEx program?',
    ],
  },
  {
    id: 'champion',
    label: 'Champion',
    description: 'Internal advocate for your solution',
    why: "Champions sell internally when you're not in the room. Without one, deals die in committee.",
    questions: [
      "Who on your team is most excited about solving this problem?",
      'Who would benefit most from this solution?',
      'Is there someone who could help us navigate your organization?',
    ],
  },
  {
    id: 'competition',
    label: 'Competition',
    description: 'Alternative solutions being considered',
    why: 'Knowing the competitive landscape helps you differentiate and avoid being outsold on features or price.',
    questions: [
      'Are you evaluating other solutions?',
      'What alternatives are you considering, including doing nothing?',
      'Have you worked with similar vendors in the past?',
    ],
  },
];

export const MEDDPICC_KEYS = MEDDPICC_ELEMENTS.map((e) => e.id);

const BLANK_WORDS = new Set(['unknown', 'none', 'n/a', 'na', 'null', 'not identified', 'not mentioned', 'not discussed', 'tbd', 'unclear']);

// Extracted values arrive as either a plain string or {value}. Returns a clean string, or null.
export function readValue(raw) {
  let s = '';
  if (typeof raw === 'string') s = raw;
  else if (raw && typeof raw === 'object' && raw.value != null) s = String(raw.value);
  s = s.trim();
  if (!s) return null;
  if (BLANK_WORDS.has(s.toLowerCase())) return null;
  return s;
}

// A deal's current MEDDPICC state. `calls` must be newest-first; the account-level
// `meddicc` field wins (it carries manual edits), otherwise the most recent call that
// captured the element supplies the value and its own provenance.
export function aggregateMeddpicc(account, calls = []) {
  const acct = account?.meddicc || {};
  const elements = MEDDPICC_ELEMENTS.map((el) => {
    const fromAccount = readValue(acct[el.id]);
    if (fromAccount) {
      return { ...el, captured: true, value: fromAccount, source: 'account', sourceCall: null };
    }
    for (const c of calls) {
      const m = c?.analysis?.meddicc || c?.analysis?.meddic || {};
      const v = readValue(m[el.id]);
      if (v) {
        return {
          ...el,
          captured: true,
          value: v,
          source: 'call',
          sourceCall: { id: c.gong_call_id || null, title: c.title || null, date: c.call_date || null },
        };
      }
    }
    return { ...el, captured: false, value: null, source: null, sourceCall: null };
  });

  const capturedCount = elements.filter((e) => e.captured).length;
  return {
    elements,
    capturedCount,
    total: MEDDPICC_ELEMENTS.length,
    missing: elements.filter((e) => !e.captured).map((e) => e.id),
  };
}
