// The single definition of MEDDPICC for the deal view: the 8 elements in Banner's order,
// Banner's own definitions, why each matters, curated discovery questions, and how a deal's
// current state is aggregated from its calls.
//
// Definitions and ordering are taken verbatim from "Banner Sales Process" (James, 2026-09) —
// note Decision PROCESS precedes Decision CRITERIA, which is the reverse of the generic
// MEDDICC ordering the codebase used before.

export const MEDDPICC_ELEMENTS = [
  {
    id: 'metrics',
    label: 'Metrics',
    description: 'Measure the potential gain leading to the economic benefit of your solution vs. competition.',
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
    description: 'Identify and meet the person who has the ultimate word to release funds to purchase.',
    why: 'Deals stall without access to the person who controls the budget. They need to be convinced of the business value.',
    questions: [
      'Who ultimately signs off on investments of this size?',
      'Who controls the budget for construction and capital improvements?',
      'Is there a specific approval process for software investments?',
    ],
  },
  {
    id: 'decision_process',
    label: 'Decision Process',
    description: 'Know and influence the process defined by the client to make a purchase decision.',
    why: 'Knowing the timeline and steps prevents surprises and helps you plan resources and forecast accurately.',
    questions: [
      'What does your typical buying process look like for software?',
      'Who needs to be involved in the final decision?',
      "What's a realistic timeline for making a decision?",
    ],
  },
  {
    id: 'decision_criteria',
    label: 'Decision Criteria',
    description: 'Know and influence the criteria defined by the client to make a purchase decision.',
    why: 'Understanding their formal and informal criteria lets you position against competition and address concerns proactively.',
    questions: [
      'What factors are most important in your evaluation?',
      'Are there must-have features vs nice-to-haves?',
      "What would make this a clear 'yes' for your team?",
    ],
  },
  {
    id: 'paper_process',
    label: 'Paper Process',
    description: 'Understand how the customer places a purchase order and the steps needed for approval.',
    why: 'Late-stage deals stall in procurement and legal, not in sales. Mapping the paper path is what makes a close date real.',
    questions: [
      "Once we agree commercially, what's the path to a purchase order — procurement, legal, security review?",
      'Who owns contract review on your side, and how long does that usually take?',
      'Is there a security review or vendor onboarding process we should start in parallel?',
    ],
  },
  {
    id: 'identify_pain',
    label: 'Identify Pain',
    description: 'Identify and analyze the pains which require your solution to be relieved.',
    why: "Pain is the #1 driver of change. Without clear pain, there's no urgency and status quo wins. It has to be in their words.",
    questions: [
      "What's the biggest challenge you're facing with your current process?",
      'What happens when projects go over budget or timeline?',
      'What keeps you up at night about your CapEx program?',
    ],
  },
  {
    id: 'champion',
    label: 'Champion',
    description: 'Identify, qualify, develop and test your Champion or internal seller.',
    why: "Champions sell internally when you're not in the room. Without one, deals die in committee.",
    // Banner's bar, used verbatim in the extraction prompt so the model cannot pass off a
    // friendly contact as a champion.
    bar: 'A champion has ALL THREE: (a) influence — people listen to them, title optional; (b) a personal win — they gain if this succeeds, in career, credibility or sanity; (c) they sell for us when we are not in the room. A promoter is NOT a champion: promoters are friendly, take your calls, share info, and risk nothing. Enthusiasm ("this looks great") costs them nothing. A champion is only proven once they have spent credibility on us — shared inside intel, opened a door to power, or sold us internally.',
    questions: [
      'Who on your team is most excited about solving this problem?',
      'Who would benefit most personally if this succeeds?',
      'Would you be willing to introduce us to [power], or share how this is being discussed internally?',
    ],
  },
  {
    id: 'competition',
    label: 'Competition',
    description: 'Understand who you are competing with, their strategy, their strengths and weaknesses, and their champion.',
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
