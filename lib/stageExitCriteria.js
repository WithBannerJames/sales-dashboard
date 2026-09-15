// Banner's actual sales process, from "Banner Sales Process" (James, 2026-09).
//
// This REPLACED a much more elaborate 5-7-item-per-stage checklist that used to live in
// components/tabs/OverviewTab.jsx. That list was invented, not the real process.
//
// Note the order: Active Pursuit comes BEFORE Qualification (Active Pursuit = confirm pain and
// fit and prove a champion; Qualification = expand the conversation). That inverts
// ACTIVE_STAGE_ORDER in lib/constants.js, which the legacy modules still use. This file is
// the source of truth for the deal view.
//
// Active Pursuit is fully specified. The other four carry the one-line version from James's
// summary sheet and will be filled in as he writes them.

export const STAGE_PROCESS = {
  active_pursuit: {
    label: 'Active Pursuit',
    order: 1,
    goal: 'Confirm pain and fit, and prove a champion',
    goals: [
      'Confirm real pain, in their words (MEDDPICC: I)',
      'Confirm fit: $5M+ capex, or more than one active draw at a time',
      'Find a Champion (MEDDPICC: C)',
    ],
    actions: [
      'Run the intro',
      'Test the promoter: every touch ends with one ask that costs them something',
      'Raise the bar each time: replies → shares intel → brings people → opens the door to power',
      'Two failed tests: find another door — "who else lives with this?"',
      'No deal sits without a dated next step',
    ],
    dos: ['Track commitments, not sentiment'],
    donts: ['Keep working one contact when the deal has other doors'],
    // Forward: all three must be true to move to Qualify.
    criteria: [
      { id: 'pain_confirmed', label: 'Pain confirmed, in their words' },
      { id: 'fit_confirmed', label: 'Fit confirmed: $5M+ capex, or more than one active draw' },
      { id: 'champion_proven', label: 'Champion proven: spent credibility on us — shared inside intel, opened a door to power, or sold us internally' },
    ],
    killWhen: [
      'No pain, or no fit',
      '3 calls or 30 days without a promoter stepping up',
    ],
    outcomes: 'Advance (champion proven → Qualify) · Progress (pain + fit + a dated next step, stays here) · Exit (close it)',
    guidance: 'A promoter is not a champion. Judge champion status only on credibility actually spent, never on enthusiasm.',
  },
  qualifying: {
    label: 'Qualification',
    order: 2,
    goal: 'Expand the conversation',
    criteria: [
      { id: 'eval_plan_agreed', label: 'Agreed to an evaluation plan' },
      { id: 'exec_sponsor_aware', label: 'Exec sponsor is aware of the evaluation' },
    ],
  },
  solution_validation: {
    label: 'Solution Validation',
    order: 3,
    goal: 'Evaluation plan',
    criteria: [
      { id: 'eval_plan_final', label: 'Evaluation plan finalised, with time booked to present to the exec sponsor' },
    ],
  },
  proposal: {
    label: 'Proposal',
    order: 4,
    goal: 'Present to the exec sponsor',
    criteria: [
      { id: 'proposal_sent', label: 'Proposal sent' },
    ],
  },
  legal: {
    label: 'Legal',
    order: 5,
    goal: 'Get verbal and start paperwork',
    criteria: [
      { id: 'signed_contract', label: 'Signed contract' },
    ],
  },
  // Banner-only stage with no HubSpot id and currently no deals in it.
  demo: { label: 'Demo', order: 6, goal: null, criteria: [] },
};

// Call playbooks. Captured from the process doc; not yet surfaced in the UI.
export const RUN_SHEETS = {
  intro: {
    stage: 'active_pursuit',
    title: 'Intros',
    prep: {
      heading: 'Prep — 15 min, time-boxed',
      items: [
        'Portfolio scan: units, properties, asset types, active/planned projects',
        'Threshold hypothesis: do they clear $5M capex or more than one active draw?',
        'Write one line: "You took this call because ___"',
        'Three discovery questions written down',
        'HubSpot: deal in Active Pursuit, contact + company complete',
        'Confirm attendees and send an agenda 24 hrs out',
      ],
      dos: ['Stop at 15 minutes'],
      donts: ['Build custom decks', 'Skip the threshold check'],
    },
    call: {
      heading: 'Call — 30 min (2 / 15 / 8 / 5)',
      items: [
        'Frame: agenda + "if this makes sense, we\'ll book the next step before we hang up"',
        'Discover: current process → where it breaks → what it costs → who feels it',
        'Position: echo back the main 1-3 points you heard, then propose one of the three paths',
        'If demoing: one feature to one pain point, with a question after each',
        'Close: book the next meeting live, name the attendees it needs',
      ],
      dos: ['Talk less than 40%', 'Capture their exact words', 'Protect the last 5 minutes — if discovery runs long, cut Position, never the Close'],
      donts: ['Full demo on call one', "Quote pricing before they've said the pain out loud", 'Accept "send me info" without a date attached'],
    },
    followUp: {
      heading: 'Follow-up — same day, within 4 business hours',
      items: [
        'Send the 5-line recap; it doubles as the deal note via Gong → HubSpot sync',
        'Update HubSpot: stage if warranted, next step = verb + date',
        'Score two MEDDPICC letters: I (pain) and C (champion candidate)',
        'No reply in 48 hrs: one nudge, then pick up the phone. Silence after on-call enthusiasm is champion data',
        'Add every call attendee as a contact on the HubSpot deal — multithreading starts with the records',
      ],
      dos: ['End with one confirmation ask', 'Write it so your champion can forward it internally'],
      donts: ['Attach a novel', 'Count "sent recap" as a next step — the calendar date is the next step'],
    },
  },
};

export function criteriaForStage(stage) {
  return STAGE_PROCESS[stage]?.criteria || [];
}

export function goalForStage(stage) {
  return STAGE_PROCESS[stage]?.goal || null;
}

export function stageProcessLabel(stage) {
  return STAGE_PROCESS[stage]?.label || stage;
}

export function stageDetail(stage) {
  const s = STAGE_PROCESS[stage];
  if (!s) return null;
  return {
    label: s.label,
    goal: s.goal || null,
    goals: s.goals || [],
    actions: s.actions || [],
    killWhen: s.killWhen || [],
    outcomes: s.outcomes || null,
    guidance: s.guidance || null,
  };
}

// Display order for the deal view, following Banner's process rather than the legacy constant.
export const PROCESS_STAGE_ORDER = Object.entries(STAGE_PROCESS)
  .sort((a, b) => a[1].order - b[1].order)
  .map(([id]) => id);
