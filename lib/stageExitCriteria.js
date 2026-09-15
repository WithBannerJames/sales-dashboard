// Banner's actual sales process, per James (2026-09) — the goal of each stage and what has to
// be true to leave it, in the simplest terms.
//
// This REPLACED a much more elaborate 5-7-item-per-stage checklist that used to live in
// components/tabs/OverviewTab.jsx. That list was invented, not the real process.
//
// Note the order: Active Pursuit comes BEFORE Qualification here (Active Pursuit = get the
// meeting booked; Qualification = expand the conversation once you're in). That inverts
// ACTIVE_STAGE_ORDER in lib/constants.js, which the legacy modules still use. This file is
// the source of truth for the deal view.

export const STAGE_PROCESS = {
  active_pursuit: {
    label: 'Active Pursuit',
    order: 1,
    goal: 'Book a meeting',
    criteria: [
      { id: 'champion', label: 'Champion identified' },
    ],
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

export function criteriaForStage(stage) {
  return STAGE_PROCESS[stage]?.criteria || [];
}

export function goalForStage(stage) {
  return STAGE_PROCESS[stage]?.goal || null;
}

export function stageProcessLabel(stage) {
  return STAGE_PROCESS[stage]?.label || stage;
}

// Display order for the deal view, following Banner's process rather than the legacy constant.
export const PROCESS_STAGE_ORDER = Object.entries(STAGE_PROCESS)
  .sort((a, b) => a[1].order - b[1].order)
  .map(([id]) => id);
