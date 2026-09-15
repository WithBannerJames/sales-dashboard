// POST /api/roadmap-auth  { password }
// Gates the roadmap. The password is checked here rather than in the page so neither it nor
// the roadmap content ends up in the client bundle. Override with ROADMAP_PASSWORD in Vercel.

const PASSWORD = process.env.ROADMAP_PASSWORD || 'Hashbrown86';

// Everything shelved by the 2026-09 reset. The code is all still in the repo — reviving a
// module means removing its redirect in next.config.js and putting it back in the nav.
const PREVIOUS_FEATURES = [
  {
    group: 'AE deal workflow',
    items: [
      { name: 'Account Pipeline', route: '/modules/account-pipeline', note: 'The old per-account workspace (Overview / Activity / Stakeholders / Intel / CS Handover). Superseded by this deal page.' },
      { name: 'Today', route: '/modules/today', note: 'Role-aware daily focus page — different view for AE, SDR and manager.' },
      { name: 'Tasks', route: '/modules/tasks', note: 'Task list with AI-generated actions, per-task "Work in Claude" chat, and a folded-in Requests tab. The largest page in the app.' },
      { name: 'Call Queue', route: '/modules/call-queue', note: 'Ranked who-to-call-today list by ICP fit and overdue-ness, with AI-drafted openers.' },
      { name: 'Sales Processes', route: '/modules/sales-processes', note: 'Editable ICP, discovery framework, MEDDICC requirements and stage-exit criteria that fed every AI prompt.' },
    ],
  },
  {
    group: 'SDR and prospecting',
    items: [
      { name: 'Prospecting', route: '/modules/prospecting', note: 'Named-account pursuit tracker plus Apollo people search.' },
      { name: 'Account Pursuit', route: '/modules/pursuit', note: 'Top-50 named-account tracker with touch logging. localStorage-backed.' },
      { name: 'Outbound Engine', route: '/modules/outbound-engine', note: 'Company research board showing % prospected and who is ready for outreach.' },
      { name: 'Campaigns', route: '/modules/campaigns', note: 'Load batches of accounts into named reengagement / vertical / expansion campaigns.' },
    ],
  },
  {
    group: 'Manager and analytics',
    items: [
      { name: 'Analytics index', route: '/modules/sales-reports', note: 'Landing grid for every report dashboard.' },
      { name: 'Call Intelligence', route: '/modules/sales-reports/call-intelligence', note: 'Every analysed call: objection patterns, talk ratios, competitor mentions, ICP/discovery scores, AI chat.' },
      { name: 'Command Center', route: '/modules/sales-reports/command-center', note: 'Revenue vs goal, live activity feed, AI "what is working this week".' },
      { name: 'CEO Dashboard', route: '/modules/sales-reports/ceo-dashboard', note: 'Open and weighted pipeline in dollars, quarter forecast, win rate, top deals.' },
      { name: 'Team Dashboard', route: '/modules/sales-reports/team-dashboard', note: 'Pipeline by stage, per-rep scorecards with AI call-quality scores, at-risk deals.' },
      { name: 'Call Registry', route: '/modules/sales-reports/call-registry', note: 'Searchable table of every Gong call. The only surface that filtered by call category.' },
      { name: 'Activity Leaderboard', route: '/modules/sales-reports/activity-leaderboard', note: 'Per-rep ranking of calls, connects and meetings booked.' },
      { name: 'Lead Intelligence', route: '/modules/sales-reports/lead-intelligence', note: 'Multi-year lead funnel from the master tracking Google Sheet.' },
      { name: 'Pipeline Overview', route: '/modules/pipeline-overview', note: 'Manager roll-up: pipeline confidence, per-rep breakdown, stale deals.' },
      { name: 'Bottleneck Tracker', route: '/modules/bottleneck', note: 'Stage-conversion funnel showing where deals stall, with stall alerts.' },
      { name: 'Stage Analytics', route: '/modules/stage-analytics', note: 'Time-in-stage and deal-velocity analysis.' },
      { name: 'ROI Tracker', route: '/modules/roi-tracker', note: 'Initiatives plus cost, attributing pipeline and revenue since start date.' },
    ],
  },
  {
    group: 'Coaching',
    items: [
      { name: 'Rep Coaching', route: '/modules/coaching', note: 'AI coaching cards and meeting-quality trend per rep, from call analysis.' },
      { name: 'Coaching Lab', route: '/modules/coaching-lab', note: 'Best-call library, weakest-dimension practice drills, advance-or-kill queue.' },
    ],
  },
  {
    group: 'Content',
    items: [
      { name: 'Content Studio', route: '/modules/content', note: 'Generates follow-up emails, business cases and RFP answers from real call transcripts. Includes the proposal / eval-doc generator.' },
    ],
  },
  {
    group: 'Admin and data quality',
    items: [
      { name: 'Settings', route: '/modules/settings', note: 'Email signature, Slack ID, rep type, team editor, pipeline weights, integrations health.' },
      { name: 'Users & Roles', route: '/modules/users', note: 'Assign access role and rep type. Admin only.' },
      { name: 'Data Quality', route: '/modules/data-quality', note: 'Account dedup/merge, low-confidence call matching, alias management.' },
      { name: 'Data Validation', route: '/modules/sales-reports/data-validation', note: 'Review queue for unmatched leads, duplicate accounts, missing fields.' },
      { name: 'HubSpot Audit Log', route: '/modules/sales-reports/hubspot-audit', note: 'Every write the dashboard made to HubSpot.' },
      { name: 'All Modules', route: '/modules', note: 'Grid index of every module.' },
    ],
  },
  {
    group: 'Other',
    items: [
      { name: 'Work Requests', route: '/modules/work-requests', note: 'Submit a design or sales-engineering request with the account context attached.' },
      { name: 'Playbooks', route: '/modules/playbooks', note: 'Pre/post-call checklists that auto-create tasks at an hour offset from a meeting.' },
    ],
  },
  {
    group: 'Background jobs paused',
    items: [
      { name: '11 Slack notification crons', route: 'vercel.json', note: 'Daily digest, deal pulse, risk alerts, expiry alerts, SDR activity, rep pulse, rep check-in, weekly brief, weekly task audit, reengagement picks, nightly deal insights. One line each to restore.' },
      { name: 'cleanup-inactive-users', route: 'vercel.json', note: 'DISABLED ON PURPOSE. Deleted auth users inactive 6+ months and cascaded to accounts and tasks. With sign-in off it was a data-destruction timer. Do not restore without rethinking it.' },
      { name: 'prep-tasks', route: 'vercel.json', note: 'Calendar-driven pre-call tasks. Was already dormant, and needs per-user Google OAuth which sign-off removed.' },
    ],
  },
];

const NEXT_UP = [
  { name: 'Per-stage process detail', note: 'James is supplying the full definition for each stage (Active Pursuit first). lib/stageExitCriteria.js is shaped to take it.' },
  { name: 'Link the 628 unmatched calls', note: '628 of 4,125 analysed calls have no account_id, so their deals show no conversations. Titles like "Banner - Sentral: Intro" are clearly matchable; run /api/hubspot/match-calls. The batch titled only "Banner Introduction Call -" needs participant-email matching instead.' },
  { name: 'Backfill 1,557 historical Gong calls', note: 'All of 2023 and early 2024 plus 283 recent CS-rep calls were never imported. The code is written and committed (4fd2b54) but never deployed. Import + tag is free; analysis is ~1 Haiku call each.' },
  { name: 'Backfill owner names', note: 'Fixed at the source — sync-deals now reads the owner directory live from HubSpot instead of a hardcoded 6-person map, which is why 344 deals had no owner. The next nightly sync fills them in.' },
  { name: 'Re-analyse the call corpus for MEDDPICC', note: 'Only ~184 of 4,125 calls carry a meddicc object at all. The deal view works around this by extracting per deal from transcripts, but per-call analysis is still thin for anything outside a live stage.' },
];

const KNOWN_ISSUES = [
  { name: 'Unmapped HubSpot stages default to Qualifying', note: 'sync-deals falls back to "qualifying" for any stage id not in STAGE_MAP, which is why our qualifying bucket (63) is far larger than the HubSpot board (23).' },
  { name: 'Information-gap categories never reach the MEDDICC grouping', note: 'The writeback sets `category` but the old UI groups on `meddicc_category`, so every AI gap landed in "Business Process". The AI enum also omits decision_criteria and emits `pain` instead of `identify_pain`.' },
  { name: 'Three divergent deal-risk formulas', note: 'score-deal-risk writes accounts.risk_score (intended source) while deal-risk-alerts and intel-risk each recompute something different.' },
  { name: 'information_gaps.blocks_stage is unused', note: 'The column that would tie a gap to the stage it blocks exists and is never written or read.' },
  { name: 'Supabase CLI access still broken', note: 'The work account migration left the CLI 403ing and the local service-role key invalid, so no new tables can be migrated. That is why the deal analysis is stored on accounts.meddicc._meta rather than its own table.' },
];

export default function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { password } = req.body || {};
  if (!password || String(password) !== PASSWORD) {
    return res.status(401).json({ error: 'Incorrect password' });
  }
  return res.status(200).json({
    ok: true,
    previousFeatures: PREVIOUS_FEATURES,
    nextUp: NEXT_UP,
    knownIssues: KNOWN_ISSUES,
    shelvedOn: '2026-09-15',
  });
}
