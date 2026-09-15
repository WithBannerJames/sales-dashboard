/**
 * Application constants and definitions
 */

// Claude model ids — single source of truth. When a model retires, change it HERE.
// SONNET: complex generation. HAIKU: fast extraction.
export const CLAUDE_MODELS = {
  SONNET: 'claude-sonnet-4-6',
  HAIKU: 'claude-haiku-4-5-20251001',
};

// Brand colors — from the 2026 client deck. See BRAND_GUIDE.md. Coral is the ONE accent.
export const BRAND_COLORS = {
  coral: '#EE5340',
  coralHover: '#E23F2B',
  coralTint: '#FDECE9',
  navy: '#16202E',
  ink: '#1F2A37',
  slate: '#6B7580',
  canvas: '#E9EEEF',
  white: '#FFFFFF',
  hairline: '#ECEEF1',
  success: '#2FBF71',
  info: '#3B82F6',
  danger: '#DC3545',
};

// The 12 Verticals
export const VERTICALS = [
  { id: 'multifamily', label: 'Multifamily' },
  { id: 'builder_developer', label: 'Builder/Developer' },
  { id: 'iwl', label: 'I/W/L', description: 'Industrial/Warehousing/Logistics' },
  { id: 'senior', label: 'Senior' },
  { id: 'student', label: 'Student' },
  { id: 'hospitality', label: 'Hospitality' },
  { id: 'healthcare_medical', label: 'Healthcare/Medical' },
  { id: 'office', label: 'Office' },
  { id: 'retail', label: 'Retail' },
  { id: 'corporate', label: 'Corporate' },
  { id: 'government', label: 'Government' },
  { id: 'mixed_use', label: 'Mixed Use' },
];

// Ownership Types
export const OWNERSHIP_TYPES = [
  { id: 'own', label: 'Own' },
  { id: 'own_and_manage', label: 'Own & Manage' },
  { id: 'third_party_manage', label: '3rd Party Manage' },
];

// ─── Stage definitions — single source of truth ────────────────────────────
// Labels match HubSpot stage names exactly.
// "Pre Pursuit" in HubSpot maps to inactive_sdr_follow_up and will eventually
// be removed from HubSpot, at which point this mapping becomes 1:1.

export const STAGE_LABELS = {
  qualifying:              'Qualify',
  intro_scheduled:         'Intro Scheduled',
  active_pursuit:          'Active Pursuit',
  demo:                    'Demo',
  solution_validation:     'Solution Validation',
  proposal:                'Proposal',
  legal:                   'Legal',
  inactive_sdr_follow_up:  'Inactive SDR Follow Up',
  inactive_ae_follow_up:   'Inactive AE Follow Up',
  closed_won:              'Closed Won',
  closed_lost:             'Closed Lost',
}

// Active pipeline stages in order (excludes inactive and closed)
export const ACTIVE_STAGE_ORDER = [
  'qualifying',
  'intro_scheduled',
  'active_pursuit',
  'demo',
  'solution_validation',
  'proposal',
  'legal',
]

export const INACTIVE_STAGE_IDS = ['inactive_sdr_follow_up', 'inactive_ae_follow_up']
export const CLOSED_STAGE_IDS = ['closed_won', 'closed_lost']

// TRACKING / REPORTING ONLY (CEO rule 2026-07): inactive_* are dead/dormant deals migrating to
// closed_lost over time. They are excluded from ACTIVE pipeline (not live) and from WIN RATE (they
// never got past active pursuit → not real opportunities; win rate = closed_won vs closed_lost only,
// see metrics.winRate). isLostForTracking marks the "dead" set (0 deal confidence). NEVER use for
// navigation, display, ordering, or DB writes — those keep INACTIVE_STAGE_IDS/CLOSED_STAGE_IDS so
// inactive accounts stay browsable/workable until James migrates them.
export const LOST_STAGE_IDS = ['closed_lost', ...INACTIVE_STAGE_IDS]
export const isLostForTracking = (stage) => LOST_STAGE_IDS.includes(stage)

// Full ordered list (active → inactive → closed)
export const ALL_STAGE_ORDER = [
  ...ACTIVE_STAGE_ORDER,
  ...INACTIVE_STAGE_IDS,
  ...CLOSED_STAGE_IDS,
]

// Single stage color system (see BRAND_GUIDE.md "stage colors — define once").
// Each active stage is a distinct hue so the pipeline is scannable at a glance; proposal carries
// brand coral (the hot moment), legal navy (nearly closed), closed_won green. closed_lost is a soft
// rose (distinct but never alarm-red, per brand); the dormant inactive_* buckets stay muted grey.
// Badge = tailwind bg/text classes. This is the ONLY place stage colors are defined.
export const STAGE_COLORS = {
  qualifying:              'bg-slate-100 text-slate-700',
  intro_scheduled:         'bg-sky-100 text-sky-700',
  active_pursuit:          'bg-blue-100 text-blue-700',
  demo:                    'bg-indigo-100 text-indigo-700',
  solution_validation:     'bg-violet-100 text-violet-700',
  proposal:                'bg-coral-100 text-coral-700',
  legal:                   'bg-navy text-white',
  inactive_sdr_follow_up:  'bg-slate-100 text-slate-400',
  inactive_ae_follow_up:   'bg-slate-200 text-slate-500',
  closed_won:              'bg-emerald-100 text-emerald-700',
  closed_lost:             'bg-rose-100 text-rose-600',
}

// Hex ramp for charts/bars — same single system so every funnel/stage bar matches the badges.
export const STAGE_HEX = {
  qualifying:              '#64748B',
  intro_scheduled:         '#0EA5E9',
  active_pursuit:          '#3B82F6',
  demo:                    '#6366F1',
  solution_validation:     '#8B5CF6',
  proposal:                '#EE5340',
  legal:                   '#16202E',
  inactive_sdr_follow_up:  '#CBD5E1',
  inactive_ae_follow_up:   '#94A3B8',
  closed_won:              '#10B981',
  closed_lost:             '#F43F5E',
}

// Canonical helpers so every surface renders stages identically.
export const stageLabel = (id) => STAGE_LABELS[id] || (id || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
export const stageBadgeClass = (id) => STAGE_COLORS[id] || 'bg-slate-100 text-slate-500'
export const stageHex = (id) => STAGE_HEX[id] || '#94A3B8'

// Win probability per stage — used by pipeline confidence score.
// Admin-editable via Settings (admin-only section).
export const STAGE_PROBABILITY = {
  qualifying: 5,
  intro_scheduled: 10,
  active_pursuit: 20,
  demo: 35,
  solution_validation: 55,
  proposal: 70,
  legal: 85,
  closed_won: 100,
  closed_lost: 0,
  inactive_sdr_follow_up: 0,
  inactive_ae_follow_up: 0,
}

// Task priority display
export const PRIORITY_COLORS = {
  1: 'text-red-600 bg-red-50 border-red-200',
  2: 'text-amber-600 bg-amber-50 border-amber-200',
  3: 'text-gray-500 bg-gray-50 border-gray-200',
}
export const PRIORITY_LABELS = { 1: 'High', 2: 'Med', 3: 'Low' }

// Legacy STAGES array — kept for backward compat with account pipeline tabs
export const STAGES = [
  { id: 'qualifying',          label: STAGE_LABELS.qualifying,          order: 1, color: 'gray' },
  { id: 'intro_scheduled',     label: STAGE_LABELS.intro_scheduled,     order: 2, color: 'sky' },
  { id: 'active_pursuit',      label: STAGE_LABELS.active_pursuit,      order: 3, color: 'blue' },
  { id: 'demo',                label: STAGE_LABELS.demo,                order: 4, color: 'purple' },
  { id: 'solution_validation', label: STAGE_LABELS.solution_validation, order: 5, color: 'orange' },
  { id: 'proposal',            label: STAGE_LABELS.proposal,            order: 6, color: 'yellow' },
  { id: 'legal',               label: STAGE_LABELS.legal,               order: 7, color: 'pink' },
  { id: 'closed_won',          label: STAGE_LABELS.closed_won,          order: 8, color: 'green' },
  { id: 'closed_lost',         label: STAGE_LABELS.closed_lost,         order: 9, color: 'red' },
];

// Core metrics (apply to all verticals)
export const CORE_METRICS = [
  { id: 'annual_construction_spend', label: 'Annual Construction Spend', type: 'currency', unit: '$' },
  { id: 'num_properties', label: 'Number of Properties', type: 'number', unit: 'properties' },
];

// Vertical-specific metrics
export const VERTICAL_METRICS = {
  multifamily: [
    { id: 'num_units', label: 'Number of Units', type: 'number', unit: 'units' },
    { id: 'unit_renos_per_year', label: 'Unit Renos per Year', type: 'number', unit: 'renos' },
    { id: 'avg_rent', label: 'Average Rent', type: 'currency', unit: '$/month' },
  ],
  builder_developer: [
    { id: 'num_projects', label: 'Number of Projects', type: 'number', unit: 'projects' },
  ],
  iwl: [
    { id: 'sqft_portfolio', label: 'Portfolio Sq Ft', type: 'number', unit: 'sq ft' },
  ],
  senior: [
    { id: 'num_units', label: 'Number of Units', type: 'number', unit: 'units' },
    { id: 'num_beds', label: 'Number of Beds', type: 'number', unit: 'beds' },
  ],
  student: [
    { id: 'num_units', label: 'Number of Units', type: 'number', unit: 'units' },
    { id: 'num_beds', label: 'Number of Beds', type: 'number', unit: 'beds' },
  ],
  hospitality: [
    { id: 'num_rooms', label: 'Number of Rooms', type: 'number', unit: 'rooms' },
  ],
  healthcare_medical: [
    { id: 'sqft_portfolio', label: 'Portfolio Sq Ft', type: 'number', unit: 'sq ft' },
  ],
  office: [
    { id: 'sqft_portfolio', label: 'Portfolio Sq Ft', type: 'number', unit: 'sq ft' },
  ],
  retail: [
    { id: 'sqft_portfolio', label: 'Portfolio Sq Ft', type: 'number', unit: 'sq ft' },
  ],
  corporate: [],
  government: [],
  mixed_use: [
    { id: 'num_units', label: 'Number of Units', type: 'number', unit: 'units' },
    { id: 'sqft_portfolio', label: 'Portfolio Sq Ft', type: 'number', unit: 'sq ft' },
  ],
};

// Third-party manager metrics (added when ownership = third_party_manage)
export const THIRD_PARTY_METRICS = [
  { id: 'num_clients', label: 'Number of Clients', type: 'number', unit: 'clients' },
];

// Helper to get all metrics for a vertical + ownership type
export const getMetricsForAccount = (vertical, ownershipType) => {
  const metrics = [...CORE_METRICS];

  if (vertical && VERTICAL_METRICS[vertical]) {
    metrics.push(...VERTICAL_METRICS[vertical]);
  }

  if (ownershipType === 'third_party_manage') {
    metrics.push(...THIRD_PARTY_METRICS);
  }

  return metrics;
};

// Legacy KEY_METRICS for backward compatibility
export const KEY_METRICS = [
  { id: 'annual_construction_spend', label: 'Annual Construction Spend', type: 'currency', unit: '$' },
  { id: 'num_properties', label: 'Number of Properties', type: 'number', unit: 'properties' },
  { id: 'num_units', label: 'Number of Units', type: 'number', unit: 'units' },
  { id: 'unit_renos_per_year', label: 'Unit Renos per Year', type: 'number', unit: 'renos' },
  { id: 'avg_rent', label: 'Average Rent', type: 'currency', unit: '$/month' },
  { id: 'num_projects', label: 'Number of Projects', type: 'number', unit: 'projects' },
  { id: 'sqft_portfolio', label: 'Portfolio Sq Ft', type: 'number', unit: 'sq ft' },
  { id: 'num_clients', label: 'Number of Clients', type: 'number', unit: 'clients' },
  { id: 'cm_fee_rate', label: 'CM Fee Rate', type: 'percent', unit: '%' },
  { id: 'num_ftes', label: 'Number of FTEs', type: 'number', unit: 'FTEs' },
];

// The 19 CapEx Business Areas for evaluation
// Note: priority is no longer hardcoded, it's derived from transcript analysis
export const BUSINESS_AREAS = [
  { id: 'budgeting', label: 'Budgeting', description: 'Site walks, budget creation, capital planning' },
  { id: 'cost_tracking', label: 'Cost Tracking', description: 'Budget tracking, forecasting, financial reporting' },
  { id: 'project_tracking', label: 'Project Tracking', description: 'Source of truth, trackers, project status' },
  { id: 'project_design', label: 'Project Design', description: 'Scope documents, bid templates, specs' },
  { id: 'bidding', label: 'Bidding', description: 'RFP process, bid leveling, vendor selection' },
  { id: 'rfa_process', label: 'RFA Process', description: 'Adding unbudgeted projects, request for approval workflow', aliases: ['adding unbudgeted projects', 'project approval', 'scope additions', 'request for authorization'] },
  { id: 'contracting', label: 'Contracting', description: 'Contract creation, signatures, tracking' },
  { id: 'project_management', label: 'Project Management', description: 'Scheduling, tasks, updates, meeting minutes' },
  { id: 'invoicing', label: 'Invoicing', description: 'Invoice submission, review, approval, payment' },
  { id: 'cost_control', label: 'Cost Control', description: 'Budget management, variance tracking, spend optimization' },
  { id: 'cm_fees', label: 'CM Fees', description: 'Construction management fee tracking and projection', applicableWhen: 'third_party_manage' },
  { id: 'change_orders', label: 'Change Orders', description: 'Change order submission and approval' },
  { id: 'project_closeout', label: 'Project Close Out', description: 'Close out process and documentation' },
  { id: 'reporting', label: 'Reporting', description: 'Reports, analytics, dashboards' },
  { id: 'unit_renos', label: 'Unit Renos', description: 'Unit renovation tracking and workflow' },
  { id: 'warranties', label: 'Warranties', description: 'Warranty tracking, expiration dates, claims' },
  { id: 'data_loading', label: 'Data Loading', description: 'Data entry, imports, system updates' },
  { id: 'due_diligence', label: 'Due Diligence', description: 'Acquisition DD process and budgeting' },
  { id: 'asset_tracking', label: 'Asset Tracking', description: 'Asset inventory, warranties, conditions' },
];

// MEDDPICC Sales Methodology Categories. Paper Process was added 2026-09 — late-stage
// deals stall in procurement/legal, and folding that into Decision Process hid it.
export const MEDDICC = {
  metrics: { id: 'metrics', label: 'Metrics', description: 'Quantifiable measures of success', order: 1 },
  economic_buyer: { id: 'economic_buyer', label: 'Economic Buyer', description: 'Person with budget authority', order: 2 },
  decision_criteria: { id: 'decision_criteria', label: 'Decision Criteria', description: 'Formal criteria for evaluation', order: 3 },
  decision_process: { id: 'decision_process', label: 'Decision Process', description: 'Steps to make a decision', order: 4 },
  paper_process: { id: 'paper_process', label: 'Paper Process', description: 'Procurement, legal, security review and signature path', order: 5 },
  identify_pain: { id: 'identify_pain', label: 'Identify Pain', description: 'Key pain points driving change', order: 6 },
  champion: { id: 'champion', label: 'Champion', description: 'Internal advocate for your solution', order: 7 },
  competition: { id: 'competition', label: 'Competition', description: 'Alternative solutions being considered', order: 8 },
};

// NOTE: the MEDDICC object above is legacy, kept for the shelved modules that still import it.
// The source of truth for the deal view is lib/meddpicc.js — it carries Banner's own
// definitions and ordering (Decision Process before Decision Criteria) plus the Champion bar.

// The live deal stages an AE works — matches the HubSpot board (Qualify, Active Pursuit,
// Solution Validation, Proposal, Legal; `demo` is a Banner-only stage with no HubSpot id and
// is currently empty). These are the stages shown by default and the ONLY ones we run deal
// analysis for; everything else (inactive_*, closed_won, closed_lost incl. HubSpot "Churned")
// is dead and hidden by default.
export const WORKING_STAGE_IDS = ['qualifying', 'active_pursuit', 'demo', 'solution_validation', 'proposal', 'legal'];

// Stakeholder roles (MEDDICC-aligned)
export const STAKEHOLDER_ROLES = [
  { value: 'Champion', label: 'Champion', color: 'green', meddicc: 'champion' },
  { value: 'Economic Buyer', label: 'Economic Buyer', color: 'blue', meddicc: 'economic_buyer' },
  { value: 'Technical Buyer', label: 'Technical Buyer', color: 'purple', meddicc: null },
  { value: 'User Buyer', label: 'User Buyer', color: 'cyan', meddicc: null },
  { value: 'Influencer', label: 'Influencer', color: 'orange', meddicc: null },
  { value: 'Blocker', label: 'Blocker', color: 'red', meddicc: null },
  { value: 'Unknown', label: 'Unknown', color: 'gray', meddicc: null },
];

// Stakeholder departments (common in CapEx orgs)
export const DEPARTMENTS = [
  'Construction Services',
  'Construction Management',
  'Asset Management',
  'Operations',
  'Finance',
  'IT',
  'Procurement',
  'Executive',
  'Regional Leadership',
  'Site Management',
  'Interiors',
  'Other',
];

// Role badge color mapping
export const getRoleBadgeClasses = (role) => {
  switch (role) {
    case 'Champion':
      return 'bg-green-100 text-green-800';
    case 'Economic Buyer':
      return 'bg-blue-100 text-blue-800';
    case 'Technical Buyer':
      return 'bg-purple-100 text-purple-800';
    case 'User Buyer':
      return 'bg-cyan-100 text-cyan-800';
    case 'Influencer':
      return 'bg-orange-100 text-orange-800';
    case 'Blocker':
      return 'bg-red-100 text-red-800';
    default:
      return 'bg-gray-100 text-gray-800';
  }
};

// Tab definitions — collapsed 10 -> 4 (Phase 2). Activity folds in Transcripts; Stakeholders folds in
// People; Intel folds in Current State + Gaps. Content -> Overview list + Content Studio; Chat -> the
// AI Assistant side-panel; Journey -> Activity timeline. CS Handover stays, closed-won only.
export const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'activity', label: 'Activity' },
  { id: 'stakeholders', label: 'Stakeholders' },
  { id: 'intel', label: 'Intel' },
  { id: 'cs_handover', label: 'CS Handover', closedWonOnly: true },
];

// Note categories
export const NOTE_CATEGORIES = [
  'General',
  'Budget',
  'Timeline',
  'Fees',
  'Technical',
  'Competition',
];

// Call types for transcripts
export const CALL_TYPES = [
  { id: 'intro', label: 'Intro Call', color: 'bg-blue-100 text-blue-700' },
  { id: 'discovery', label: 'Discovery', color: 'bg-purple-100 text-purple-700' },
  { id: 'demo', label: 'Demo', color: 'bg-green-100 text-green-700' },
  { id: 'pricing', label: 'Pricing', color: 'bg-amber-100 text-amber-700' },
  { id: 'negotiation', label: 'Negotiation', color: 'bg-orange-100 text-orange-700' },
  { id: 'follow_up', label: 'Follow-up', color: 'bg-gray-100 text-gray-700' },
  { id: 'other', label: 'Other', color: 'bg-gray-100 text-gray-700' },
];

// Call feedback scoring rubric
export const CALL_SCORE_RUBRIC = {
  discovery_depth: {
    label: 'Discovery Depth',
    description: 'How well did the rep uncover pain points, current processes, and business context?',
    levels: {
      1: 'No discovery questions asked',
      2: 'Surface-level questions only',
      3: 'Good breadth but limited depth',
      4: 'Strong discovery with follow-up questions',
      5: 'Exceptional - uncovered key insights and quantified impact',
    },
  },
  value_articulation: {
    label: 'Value Articulation',
    description: 'How effectively did the rep connect Banner capabilities to prospect needs?',
    levels: {
      1: 'Feature dumping with no connection to needs',
      2: 'Generic value props not tailored to prospect',
      3: 'Some connection to stated needs',
      4: 'Clear value tied to specific pain points',
      5: 'Compelling ROI story with quantified benefits',
    },
  },
  objection_handling: {
    label: 'Objection Handling',
    description: 'How well did the rep address concerns and objections?',
    levels: {
      1: 'Ignored or dismissed objections',
      2: 'Acknowledged but did not address',
      3: 'Basic response without validation',
      4: 'Validated concern and provided solid response',
      5: 'Turned objection into opportunity, gained commitment',
    },
  },
  next_steps: {
    label: 'Next Steps Secured',
    description: 'Did the rep secure clear, committed next steps?',
    levels: {
      1: 'No next steps discussed',
      2: 'Vague "we\'ll be in touch"',
      3: 'Next step identified but not committed',
      4: 'Specific next step with date/time',
      5: 'Multiple stakeholders committed, calendar invite sent',
    },
  },
  talk_ratio: {
    label: 'Talk Ratio',
    description: 'What percentage of the call did the rep talk vs listen?',
    levels: {
      1: '>80% rep talking',
      2: '70-80% rep talking',
      3: '50-70% rep talking',
      4: '40-50% rep talking',
      5: '<40% rep talking (prospect-led conversation)',
    },
  },
};

// Empty business area state template
export const createEmptyBusinessAreaState = () => {
  return BUSINESS_AREAS.reduce((acc, area) => {
    acc[area.id] = {
      currentState: [], // Array of {bullet: string, sourceCalls: [transcriptId], addedDate: string}
      opportunities: [], // Array of {bullet: string, sourceCalls: [transcriptId], addedDate: string}
      quotes: [], // Array of strings (kept as simple strings for now)
      confidence: 'none',
      priority: null, // Will be derived from transcript analysis, not hardcoded
      irrelevant: false,
      irrelevantReason: null,
      lastUpdated: null,
      conflicts: [], // Array of {description: string, call1: {id, statement}, call2: {id, statement}}
    };
    return acc;
  }, {});
};

// Empty MEDDICC state template
export const createEmptyMeddiccState = () => {
  return Object.keys(MEDDICC).reduce((acc, key) => {
    acc[key] = {
      status: 'unknown',
      notes: [],
      confidence: 'none',
      lastUpdated: null,
    };
    return acc;
  }, {});
};

// Calculate deal health score (0-100)
export const calculateDealHealth = (account) => {
  if (!account) return 0;

  let score = 0;
  const weights = {
    stage: 20,
    gaps: 20,
    champion: 15,
    economicBuyer: 15,
    activity: 15,
    metrics: 15,
  };

  // Stage progression (20 points)
  const stageOrder = STAGES.find(s => s.id === account.stage)?.order || 1;
  score += (stageOrder / 5) * weights.stage; // Max at proposal stage

  // Gaps resolved (20 points)
  const gaps = account.informationGaps || [];
  const resolvedGaps = gaps.filter(g => g.status === 'resolved').length;
  const totalGaps = gaps.length || 1;
  score += (resolvedGaps / totalGaps) * weights.gaps;

  // Champion identified (15 points)
  const stakeholders = account.stakeholders || [];
  const hasChampion = stakeholders.some(s => s.role === 'Champion');
  score += hasChampion ? weights.champion : 0;

  // Economic Buyer identified (15 points)
  const hasEB = stakeholders.some(s => s.role === 'Economic Buyer');
  score += hasEB ? weights.economicBuyer : 0;

  // Recent activity (15 points)
  const lastTranscript = account.transcripts?.[account.transcripts.length - 1];
  if (lastTranscript) {
    const daysSince = Math.floor((Date.now() - new Date(lastTranscript.addedAt)) / (1000 * 60 * 60 * 24));
    if (daysSince <= 7) score += weights.activity;
    else if (daysSince <= 14) score += weights.activity * 0.7;
    else if (daysSince <= 30) score += weights.activity * 0.4;
  }

  // Metrics captured (15 points)
  const metrics = account.metrics || {};
  const capturedMetrics = Object.values(metrics).filter(m => m?.value != null).length;
  const minMetrics = 3; // Expect at least 3 key metrics
  score += Math.min(capturedMetrics / minMetrics, 1) * weights.metrics;

  return Math.round(score);
};

// Get health score color
export const getHealthScoreColor = (score) => {
  if (score >= 70) return 'text-green-600';
  if (score >= 40) return 'text-yellow-600';
  return 'text-red-600';
};

export const getHealthScoreBg = (score) => {
  if (score >= 70) return 'bg-green-100';
  if (score >= 40) return 'bg-yellow-100';
  return 'bg-red-100';
};
