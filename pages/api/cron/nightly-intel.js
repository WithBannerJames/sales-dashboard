// GET /api/cron/nightly-intel
// Nightly job: imports all new Gong calls then analyzes James's unanalyzed calls.
//
// Two-phase approach prevents lost calls when analysis fails:
//   Phase 1 — Import: store ALL new calls (any rep) with analyzed_at=null.
//             No_show calls (< 2 min) are immediately marked ignored.
//   Phase 2 — Analyze: call intel-analyze for each unanalyzed James Lindberg call.
//             Intel-analyze handles transcript fetch + Claude analysis + DB update.
//
// process-backlog cron handles analysis for non-James calls in the background.

import { createGongHeaders } from '../../../lib/apiUtils';
import { getSupabase } from '../../../lib/supabase';
import { isExcludedRep } from '../../../lib/repConfig';

const GONG_API_BASE = 'https://api.gong.io';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const secret = process.env.CRON_SECRET;
  if (secret && req.headers['authorization'] !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const gongAccessKey = process.env.GONG_ACCESS_KEY;
  const gongSecretKey = process.env.GONG_SECRET_KEY;
  if (!gongAccessKey || !gongSecretKey) {
    return res.status(500).json({ error: 'Gong credentials not configured' });
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }

  const gongHeaders = createGongHeaders(gongAccessKey, gongSecretKey);

  // Quick mode (?quick=1): short lookback for frequent intraday runs
  const isQuick = req.query.quick === '1';
  // 150 days covers the 90-day nightly window plus buffer for backfill gaps
  const lookbackHours = isQuick ? 8 : 150 * 24;
  const analyzeCap = isQuick ? 10 : 150;

  const toDate = new Date();
  const fromDate = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);

  // ── Fetch Gong users ──────────────────────────────────────────────────────────
  let userMap = {};
  try {
    const usersRes = await fetch(`${GONG_API_BASE}/v2/users`, { method: 'GET', headers: gongHeaders });
    if (usersRes.ok) {
      const usersData = await usersRes.json();
      (usersData.users || []).forEach(u => {
        const name = `${u.firstName || ''} ${u.lastName || ''}`.trim();
        userMap[u.id] = { name, email: u.emailAddress };
      });
    }
  } catch { /* continue */ }

  // ── Fetch all calls in window (all reps) ─────────────────────────────────────
  // Gong paginates oldest-first, so recent calls appear on later pages.
  // We run TWO sweeps: the long window for historical gaps, and a short 90-day
  // window (matching list-calls, provably returns recent calls) as a safety net.
  async function fetchGongCalls(from, to, label) {
    const calls = [];
    let cur = null;
    let pages = 0;
    try {
      do {
        let url = `${GONG_API_BASE}/v2/calls?fromDateTime=${from.toISOString()}&toDateTime=${to.toISOString()}`;
        if (cur) url += `&cursor=${encodeURIComponent(cur)}`;
        if (pages > 0) await new Promise(r => setTimeout(r, 150));
        const resp = await fetch(url, { method: 'GET', headers: gongHeaders });
        if (!resp.ok) break;
        const data = await resp.json();
        calls.push(...(data.calls || []));
        cur = data.records?.cursor || null;
        pages++;
      } while (cur && pages < 100);
    } catch { /* continue with what we have */ }
    console.log(`[nightly-intel] ${label}: fetched ${calls.length} calls in ${pages} pages`);
    return calls;
  }

  // Long window: catches historical gaps
  const longCalls = await fetchGongCalls(fromDate, toDate, '150d sweep');
  // Short window: guarantees recent calls are captured (Gong oldest-first pagination can bury these)
  const recentFrom = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const recentCalls = await fetchGongCalls(recentFrom, toDate, '90d sweep');

  // Merge, deduplicate by Gong call ID
  const longCallIds = new Set(longCalls.map(c => c.id));
  const seenIds = new Set(longCallIds);
  const allCalls = [...longCalls];
  const supplementalOnly = [];
  for (const call of recentCalls) {
    if (!seenIds.has(call.id)) {
      allCalls.push(call);
      seenIds.add(call.id);
      supplementalOnly.push(call);
    }
  }

  // Alert if supplemental sweep caught calls the main sweep missed — signals pagination degradation
  if (supplementalOnly.length > 0) {
    const slackToken = process.env.SLACK_BOT_TOKEN;
    const managerChannel = process.env.SLACK_MANAGER_CHANNEL || 'D02PGNHTR53';
    if (slackToken) {
      const titles = supplementalOnly.slice(0, 5).map(c => `• ${c.title || 'Untitled'}`).join('\n');
      const more = supplementalOnly.length > 5 ? `\n+${supplementalOnly.length - 5} more` : '';
      await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { Authorization: `Bearer ${slackToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel: managerChannel,
          text: `⚠️ Nightly intel: main sweep missed ${supplementalOnly.length} call(s) — caught by supplemental sweep. Gong pagination may be degraded.\n${titles}${more}`,
        }),
      }).catch(() => {});
    }
    console.log(`[nightly-intel] WARN: supplemental sweep rescued ${supplementalOnly.length} calls missed by main sweep`);
  }

  if (!allCalls.length) {
    return res.status(200).json({ imported: 0, analyzed: 0, message: 'No calls in window' });
  }

  const db = getSupabase();
  const gongCallIds = allCalls.map(c => c.id);

  // Check which calls are already in the DB (any state)
  const { data: existingRows } = await db
    .from('gong_call_analyses')
    .select('gong_call_id, analyzed_at, ignored')
    .in('gong_call_id', gongCallIds);

  const existingMap = new Map((existingRows || []).map(r => [r.gong_call_id, r]));

  // ── Phase 1: Import new calls ─────────────────────────────────────────────────
  // Governance: excluded (CS / non-sales) reps never enter the system at all.
  const newCalls = allCalls
    .filter(c => !existingMap.has(c.id))
    .filter(c => {
      const user = userMap[c.primaryUserId];
      // CS reps are imported and analysed too (2026-09-18) — their calls carry the customer
      // knowledge. They are tagged call_category='cs' at analysis, which is what keeps them out
      // of sales metrics.
      return true;
    });
  let imported = 0;

  if (newCalls.length > 0) {
    const rows = newCalls.map(call => {
      const user = userMap[call.primaryUserId] || null;
      const durationSeconds = call.duration || 0;
      const isNoShow = durationSeconds < 120;
      return {
        gong_call_id: call.id,
        title: call.title || 'Untitled',
        call_date: call.started || null,
        duration_seconds: durationSeconds,
        rep_name: user?.name || null,
        rep_email: user?.email || null,
        gong_url: call.url || null,
        analyzed_at: null,
        ignored: isNoShow,
        ignore_reason: isNoShow ? 'no_show' : null,
      };
    });

    // Batch insert in chunks of 100
    for (let i = 0; i < rows.length; i += 100) {
      const { error } = await db
        .from('gong_call_analyses')
        .upsert(rows.slice(i, i + 100), { onConflict: 'gong_call_id', ignoreDuplicates: true });
      if (!error) imported += rows.slice(i, i + 100).length;
    }
    console.log(`[nightly-intel] imported ${imported} new calls`);
  }

  // ── Phase 2: Analyze James's unanalyzed calls ─────────────────────────────────
  // Re-query to include newly imported rows
  const { data: pendingRows } = await db
    .from('gong_call_analyses')
    .select('gong_call_id, analyzed_at, ignored')
    .in('gong_call_id', gongCallIds);

  const doneIds = new Set((pendingRows || []).filter(r => r.analyzed_at || r.ignored).map(r => r.gong_call_id));

  const toAnalyze = allCalls
    .filter(call => !doneIds.has(call.id))
    .filter(call => {
      const user = userMap[call.primaryUserId];
      // CS reps are imported and analysed too (2026-09-18) — their calls carry the customer
      // knowledge. They are tagged call_category='cs' at analysis, which is what keeps them out
      // of sales metrics.
      return true;
    })
    .slice(0, analyzeCap);

  const baseUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'http://localhost:3000';

  const results = { analyzed: 0, failed: 0 };

  const getCallType = (title) => {
    const t = (title || '').toLowerCase();
    if (t.includes('intro') || t.includes('introduction')) return 'intro';
    if (t.includes('demo')) return 'demo';
    return 'solution_validation';
  };

  for (const call of toAnalyze) {
    const user = userMap[call.primaryUserId] || null;
    try {
      const r = await fetch(`${baseUrl}/api/gong/intel-analyze`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${secret}`,
        },
        body: JSON.stringify({
          callId: call.id,
          title: call.title || 'Untitled',
          date: call.started || null,
          callType: getCallType(call.title),
          repName: user?.name || null,
          repEmail: user?.email || null,
          durationSeconds: call.duration || 0,
          gongUrl: call.url || null,
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (data.analysis) {
        results.analyzed++;
        console.log(`[nightly-intel] analyzed: ${call.title}`);
      } else {
        results.failed++;
        console.error(`[nightly-intel] failed: ${call.title}`, data.error);
      }
    } catch (e) {
      results.failed++;
      console.error(`[nightly-intel] error on ${call.title}:`, e.message);
    }
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`[nightly-intel] done: ${imported} imported, ${results.analyzed} analyzed, ${results.failed} failed`);
  return res.status(200).json({
    imported,
    ...results,
    total: allCalls.length,
    queued: toAnalyze.length,
  });
}
