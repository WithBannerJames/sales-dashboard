import { createServerSupabaseClient, getSupabase } from '../../../lib/supabase'
import { logRequest } from '../../../lib/apiUtils'
import { isLowSignalStep, isRepOwnedStep, dedupSteps, normStep, tokenOverlap } from '../../../lib/taskNoise'

// Stable content id so a dismissal (persisted in localStorage) keeps pointing at the same item even
// as the feed's composition changes between sessions. djb2 over "callId|normalizedText".
function stableId(callId, text) {
  const s = `${callId}|${normStep(text)}`
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return `${callId}_${(h >>> 0).toString(36)}`
}

export default async function handler(req, res) {
  logRequest(req, 'tasks/call-commitments')
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const authClient = createServerSupabaseClient(req, res)
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return res.status(401).json({ error: 'Unauthorized' })

  const db = getSupabase()
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

  const { data: calls } = await db
    .from('gong_call_analyses')
    .select('id, title, call_date, analysis, account_id, call_category')
    .eq('rep_email', user.email)
    .gte('call_date', sevenDaysAgo)
    .not('analyzed_at', 'is', null)
    .order('call_date', { ascending: false })
    .limit(10)

  if (!calls?.length) return res.status(200).json({ commitments: [] })

  // Fetch account names for matched accounts
  const accountIds = [...new Set(calls.map(c => c.account_id).filter(Boolean))]
  let accountMap = {}
  if (accountIds.length) {
    const { data: accounts } = await db.from('accounts').select('id, name').in('id', accountIds)
    if (accounts) accounts.forEach(a => { accountMap[a.id] = a.name })
  }

  // Existing Gong-sourced tasks — dedup on token overlap, not exact title (auto-task titles are
  // truncated/prefixed, so exact-match let already-added items re-surface).
  const { data: existingTasks } = await db
    .from('tasks')
    .select('title')
    .eq('owner_id', user.id)
    .in('source_type', ['gong_next_step', 'gong_commitment'])
    .is('dismissed_at', null)
  const existingTokenSets = (existingTasks || []).map(t => new Set(normStep(t.title).split(' ').filter(w => w.length > 2)))
  const alreadyHasTask = (text) => {
    const toks = new Set(normStep(text).split(' ').filter(w => w.length > 2))
    return existingTokenSets.some(prev => tokenOverlap(toks, prev) >= 0.6)
  }

  const commitments = []

  for (const call of calls) {
    if (call.call_category === 'cs' || call.call_category === 'internal') continue // CS + internal calls don't drive rep tasks
    const a = call.analysis || {}
    const callDate = call.call_date?.split('T')[0]
    const callTitle = call.title || 'Untitled call'
    const accountName = accountMap[call.account_id] || null

    // Commitments are always the rep's; next steps must be rep-owned. Then drop low-signal filler
    // and near-duplicates within the call — the same gates the auto-create pipeline uses.
    const raw = [
      ...(Array.isArray(a.commitments) ? a.commitments : []).map(c => ({ text: c, type: 'commitment' })),
      ...(Array.isArray(a.next_steps_mentioned) ? a.next_steps_mentioned : []).filter(isRepOwnedStep).map(s => ({ text: s, type: 'next_step' })),
    ].filter(it => it.text && typeof it.text === 'string' && !isLowSignalStep(it.text))

    const seenTokens = []
    for (const item of raw) {
      const toks = new Set(normStep(item.text).split(' ').filter(w => w.length > 2))
      if (!toks.size) continue
      if (seenTokens.some(prev => tokenOverlap(toks, prev) >= 0.8)) continue // in-call dup
      if (alreadyHasTask(item.text)) continue // already a task
      seenTokens.push(toks)
      commitments.push({
        id: stableId(call.id, item.text),
        callId: call.id,
        callTitle,
        callDate,
        accountId: call.account_id || null,
        accountName,
        text: item.text,
        type: item.type,
      })
    }
  }

  return res.status(200).json({ commitments: commitments.slice(0, 12) })
}
