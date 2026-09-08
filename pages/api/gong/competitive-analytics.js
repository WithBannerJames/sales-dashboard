// GET /api/gong/competitive-analytics
// Aggregates competitor mentions across all analyzed calls, cross-referenced with
// deal outcomes (won/lost accounts) to show win rate by competitor and competitive signals.

import { createServerSupabaseClient, getSupabase } from '../../../lib/supabase';
import { apiError, apiSuccess, logRequest } from '../../../lib/apiUtils';

export default async function handler(req, res) {
  logRequest(req, 'gong/competitive-analytics');
  if (req.method !== 'GET') return apiError(res, 405, 'GET only');

  const auth = createServerSupabaseClient(req, res);
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return apiError(res, 401, 'Unauthorized');

  const db = getSupabase();

  // Pull all analyzed calls with competitor data, plus account outcomes
  const [callsRes, accountsRes] = await Promise.all([
    db.from('gong_call_analyses')
      .select('account_id, call_date, analysis')
      .not('analyzed_at', 'is', null)
      .not('ignored', 'is', true)
      .or('call_category.is.null,call_category.not.in.(cs,internal)')
      .not('analysis->competitor_mentions', 'is', null),
    db.from('accounts').select('id, name, stage, debrief'),
  ]);

  const calls = callsRes.data || [];
  const accounts = accountsRes.data || [];

  // Build outcome map: accountId → 'won' | 'lost' | 'active'
  const outcomeMap = {};
  for (const a of accounts) {
    if (a.stage === 'closed_won') outcomeMap[a.id] = 'won';
    else if (a.stage === 'closed_lost') outcomeMap[a.id] = 'lost';
    else if (a.stage === 'inactive_sdr_follow_up' || a.stage === 'inactive_ae_follow_up') outcomeMap[a.id] = 'inactive'; // dead/dormant → excluded from win rate AND active (never an opportunity)
    else outcomeMap[a.id] = 'active';
  }

  // Aggregate competitor data
  const competitorMap = {};

  for (const call of calls) {
    const mentions = call.analysis?.competitor_mentions || [];
    if (!mentions.length) continue;

    const outcome = call.account_id ? (outcomeMap[call.account_id] || 'unknown') : 'unknown';

    for (const m of mentions) {
      const name = (m.name || '').trim();
      if (!name || name.length < 2) continue;

      if (!competitorMap[name]) {
        competitorMap[name] = {
          name,
          totalMentions: 0,
          accounts: new Set(),
          wonAccounts: new Set(),
          lostAccounts: new Set(),
          activeAccounts: new Set(),
          sentiments: { positive: 0, neutral: 0, negative: 0 },
          contexts: [],
          objectionPatterns: [],
        };
      }

      const c = competitorMap[name];
      c.totalMentions++;
      if (call.account_id) {
        c.accounts.add(call.account_id);
        if (outcome === 'won') c.wonAccounts.add(call.account_id);
        else if (outcome === 'lost') c.lostAccounts.add(call.account_id);
        else if (outcome === 'active') c.activeAccounts.add(call.account_id);
      }

      const sentiment = m.sentiment || 'neutral';
      c.sentiments[sentiment] = (c.sentiments[sentiment] || 0) + 1;

      if (m.context && c.contexts.length < 10) {
        c.contexts.push({
          text: m.context,
          date: call.call_date,
          outcome,
          sentiment,
        });
      }
    }

    // Also grab competition objections
    const objections = (call.analysis?.objections || []).filter(o => o.category === 'competition');
    for (const obj of objections) {
      // Try to match to a competitor
      for (const [name, data] of Object.entries(competitorMap)) {
        if (obj.text?.toLowerCase().includes(name.toLowerCase())) {
          data.objectionPatterns.push({
            text: obj.text,
            repResponse: obj.rep_response,
            date: call.call_date,
            outcome,
          });
          break;
        }
      }
    }
  }

  // Serialize and compute win rates
  const competitors = Object.values(competitorMap)
    .filter(c => c.accounts.size >= 1)
    .map(c => {
      const wonCount = c.wonAccounts.size;
      const lostCount = c.lostAccounts.size;
      const totalClosed = wonCount + lostCount;
      const winRate = totalClosed > 0 ? Math.round((wonCount / totalClosed) * 100) : null;

      // Dominant sentiment
      const sentMax = Math.max(c.sentiments.positive, c.sentiments.neutral, c.sentiments.negative);
      const overallSentiment = sentMax === c.sentiments.positive ? 'positive'
        : sentMax === c.sentiments.negative ? 'negative' : 'neutral';

      return {
        name: c.name,
        totalMentions: c.totalMentions,
        dealsWithMention: c.accounts.size,
        wonDeals: wonCount,
        lostDeals: lostCount,
        activeDeals: c.activeAccounts.size,
        winRate,
        overallSentiment,
        sentiments: c.sentiments,
        recentContexts: c.contexts.slice(0, 5),
        objectionPatterns: c.objectionPatterns.slice(0, 3),
      };
    })
    .sort((a, b) => b.totalMentions - a.totalMentions);

  // Overall competitive stats
  const totalCompetitiveDeals = new Set(
    calls
      .filter(c => (c.analysis?.competitor_mentions || []).length > 0)
      .map(c => c.account_id)
      .filter(Boolean)
  ).size;

  return apiSuccess(res, {
    competitors,
    totalCompetitiveDeals,
    totalCompetitors: competitors.length,
    generatedAt: new Date().toISOString(),
  });
}
