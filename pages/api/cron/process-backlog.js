// POST /api/cron/process-backlog
// Processes calls in gong_call_analyses that have metadata but no analysis yet.
// Runs every 30 min via GitHub Actions until the backlog is clear.
// Protected by CRON_SECRET.

import { getSupabase } from '../../../lib/supabase'
import { isExcludedRep } from '../../../lib/repConfig'

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end()
  const secret = process.env.CRON_SECRET
  if (secret && req.headers['authorization'] !== `Bearer ${secret}`) return res.status(401).end()

  const db = getSupabase()
  const baseUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'http://localhost:3000'

  // Priority stages: active deals get analyzed before the general backlog
  const PRIORITY_STAGES = ['legal', 'proposal', 'solution_validation', 'demo', 'active_pursuit', 'intro_scheduled']

  // Fetch accounts in active stages for priority join
  const { data: priorityAccounts } = await db
    .from('accounts')
    .select('id')
    .in('stage', PRIORITY_STAGES)

  const priorityAccountIds = (priorityAccounts || []).map(a => a.id)

  const BATCH = 30
  let backlog = []

  // Slot 1: up to BATCH calls from active-stage accounts (most recent first)
  if (priorityAccountIds.length > 0) {
    const { data: priorityCalls } = await db
      .from('gong_call_analyses')
      .select('gong_call_id, title, call_date, call_type, rep_name, rep_email, duration_seconds, gong_url, transcript_text')
      .is('analyzed_at', null)
      .eq('ignored', false)
      .not('gong_call_id', 'is', null)
      .or('call_category.is.null,call_category.not.in.(cs,internal)')
      .in('account_id', priorityAccountIds)
      .order('call_date', { ascending: false })
      .limit(BATCH)
    backlog = priorityCalls || []
  }

  // Slot 2: fill remaining slots from general backlog (any account, most recent)
  if (backlog.length < BATCH) {
    const exclude = new Set(backlog.map(c => c.gong_call_id))
    const { data: general } = await db
      .from('gong_call_analyses')
      .select('gong_call_id, title, call_date, call_type, rep_name, rep_email, duration_seconds, gong_url, transcript_text')
      .is('analyzed_at', null)
      .eq('ignored', false)
      .not('gong_call_id', 'is', null)
      .or('call_category.is.null,call_category.not.in.(cs,internal)')
      .order('call_date', { ascending: false })
      .limit(BATCH * 3) // over-fetch so we can dedupe
    const fill = (general || []).filter(c => !exclude.has(c.gong_call_id)).slice(0, BATCH - backlog.length)
    backlog = [...backlog, ...fill]
  }

  // Governance: never analyze excluded (CS / non-sales) reps' calls.
  // CS reps' calls are analysed too since 2026-09-18 — they hold the customer knowledge. The
  // 'cs' tag applied at analysis, not a filter here, is what keeps them out of sales metrics.

  if (!backlog?.length) {
    const { count } = await db
      .from('gong_call_analyses')
      .select('id', { count: 'exact', head: true })
      .is('analyzed_at', null)
      .eq('ignored', false)
      .or('call_category.is.null,call_category.not.in.(cs,internal)')
    return res.status(200).json({ processed: 0, remaining: count || 0, message: 'Nothing to process' })
  }

  let processed = 0
  let failed = 0

  // Process in concurrent batches of 5 — each Claude call ~20s, so 5 concurrent = 75 calls in ~300s
  const CONCURRENCY = 5
  for (let i = 0; i < backlog.length; i += CONCURRENCY) {
    const chunk = backlog.slice(i, i + CONCURRENCY)
    await Promise.all(chunk.map(async (call) => {
      try {
        const r = await fetch(`${baseUrl}/api/gong/intel-analyze`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
          body: JSON.stringify({
            callId: call.gong_call_id,
            title: call.title,
            date: call.call_date,
            callType: call.call_type,
            repName: call.rep_name,
            repEmail: call.rep_email,
            durationSeconds: call.duration_seconds,
            gongUrl: call.gong_url,
            transcriptText: call.transcript_text || null,
          }),
        })
        const d = await r.json().catch(() => ({}))
        if (d.analysis) {
          processed++
          console.log(`[process-backlog] analyzed: ${call.title}`)
        } else {
          failed++
          console.error(`[process-backlog] failed: ${call.title}`, d.error)
        }
      } catch (e) {
        failed++
        console.error(`[process-backlog] error on ${call.gong_call_id}:`, e.message)
      }
    }))
    // Brief pause between batches to avoid overwhelming Anthropic rate limits
    if (i + CONCURRENCY < backlog.length) {
      await new Promise(r => setTimeout(r, 500))
    }
  }

  const { count: remaining } = await db
    .from('gong_call_analyses')
    .select('id', { count: 'exact', head: true })
    .is('analyzed_at', null)
    .eq('ignored', false)
    .or('call_category.is.null,call_category.not.in.(cs,internal)')

  console.log(`[process-backlog] done: ${processed} analyzed, ${failed} failed, ${remaining || 0} remaining`)
  return res.status(200).json({ processed, failed, remaining: remaining || 0 })
}
