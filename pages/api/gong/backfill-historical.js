// POST /api/gong/backfill-historical
// One-time admin endpoint: imports all historical Gong calls with transcript text.
// Paginated — call repeatedly until done: true is returned (pass cursor from prior response).
// Protected by CRON_SECRET.
// Run via GitHub Actions: .github/workflows/backfill-historical.yml

import { createClient } from '@supabase/supabase-js'
import { createGongHeaders } from '../../../lib/apiUtils'
import { deriveDerivedCallType, deriveCallCategory, isInternalCall } from '../../../lib/callCategory'

const GONG_API_BASE = 'https://api.gong.io'
const BATCH_SIZE = 100

function normalizeName(s) {
  return (s || '')
    .toLowerCase()
    .replace(/banner[\s\-–—]*/gi, '')
    .replace(/[\-–—:|]/g, ' ')
    .replace(/\b(intro|demo|discovery|presentation|follow\s*up|meeting|call|new deal|year \d+)\b/gi, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function matchScore(accountName, callTitle) {
  const a = normalizeName(accountName)
  const d = normalizeName(callTitle)
  if (!a || !d) return 0
  if (a === d) return 10
  if (d.startsWith(a) || a.startsWith(d)) return 8
  if (d.includes(a) || a.includes(d)) return 6
  const aWords = new Set(a.split(' ').filter(w => w.length > 2))
  const dWords = d.split(' ').filter(w => w.length > 2)
  const overlap = dWords.filter(w => aWords.has(w)).length
  if (overlap >= 3) return 5
  if (overlap >= 2) return 3
  if (overlap === 1 && aWords.size === 1) return 2
  return 0
}

function getCallType(title) {
  const t = (title || '').toLowerCase()
  if (t.includes('intro') || t.includes('introduction')) return 'intro'
  if (t.includes('demo')) return 'demo'
  return 'solution_validation'
}

export default async function handler(req, res) {
  try {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).end()

  const secret = (process.env.CRON_SECRET || '').trim()
  if (secret && req.headers['authorization'] !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const gongAccessKey = (process.env.GONG_ACCESS_KEY || '').trim()
  const gongSecretKey = (process.env.GONG_SECRET_KEY || '').trim()
  if (!gongAccessKey || !gongSecretKey) {
    return res.status(500).json({ error: 'Gong credentials not configured' })
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  console.log('[backfill-historical] supabase url set:', !!supabaseUrl, 'service role key set:', !!supabaseKey)
  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({ error: `Missing Supabase config: url=${!!supabaseUrl} key=${!!supabaseKey}` })
  }

  const body = req.method === 'POST' ? (req.body || {}) : req.query
  const { cursor, fromDate: fromDateParam } = body

  const gongHeaders = createGongHeaders(gongAccessKey, gongSecretKey)
  const fromDate = fromDateParam
    ? new Date(fromDateParam)
    : new Date(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000)
  const toDate = new Date()

  // 1. Fetch one page of calls from Gong
  let listUrl = `${GONG_API_BASE}/v2/calls?fromDateTime=${fromDate.toISOString()}&toDateTime=${toDate.toISOString()}`
  if (cursor) listUrl += `&cursor=${encodeURIComponent(cursor)}`

  const gongGetHeaders = { Authorization: gongHeaders.Authorization }
  console.log('[backfill-historical] fetching calls list:', listUrl)
  const callsRes = await fetch(listUrl, { method: 'GET', headers: gongGetHeaders })
  if (!callsRes.ok) {
    const errText = await callsRes.text().catch(() => '')
    console.error('[backfill-historical] Gong list error:', callsRes.status, errText)
    return res.status(500).json({ error: `Gong list failed: ${callsRes.status}`, detail: errText })
  }
  const callsData = await callsRes.json().catch(() => ({}))
  const allCalls = callsData.calls || []
  const nextCursor = callsData.records?.cursor || null

  if (!allCalls.length) {
    return res.status(200).json({ imported: 0, skipped: 0, done: true, cursor: null })
  }

  // 2. Check which are already fully imported (have transcript_text stored)
  const db = createClient(supabaseUrl, supabaseKey)
  const callIds = allCalls.map(c => c.id)

  const { data: existingRows } = await db
    .from('gong_call_analyses')
    .select('gong_call_id, transcript_text, analyzed_at, account_id')
    .in('gong_call_id', callIds)

  const existingCallIds = new Set((existingRows || []).map(r => r.gong_call_id))
  const alreadyHasTranscript = new Set(
    (existingRows || [])
      .filter(r => r.transcript_text && r.transcript_text.length > 50)
      .map(r => r.gong_call_id)
  )

  const toImport = allCalls.filter(c => !alreadyHasTranscript.has(c.id)).slice(0, BATCH_SIZE)

  if (!toImport.length) {
    return res.status(200).json({
      imported: 0,
      skipped: allCalls.length,
      cursor: nextCursor,
      done: !nextCursor,
    })
  }

  // 3. Fetch user map for rep name/email
  let userMap = {}
  try {
    const usersRes = await fetch(`${GONG_API_BASE}/v2/users`, { method: 'GET', headers: gongGetHeaders })
    if (usersRes.ok) {
      const usersData = await usersRes.json()
      ;(usersData.users || []).forEach(u => {
        userMap[u.id] = {
          name: `${u.firstName || ''} ${u.lastName || ''}`.trim(),
          email: u.emailAddress,
        }
      })
    }
  } catch { /* continue without rep names */ }

  // 4. Batch-fetch party details + transcripts for this batch
  const batchIds = toImport.map(c => c.id)

  const [detailsRes, transcriptRes] = await Promise.all([
    fetch(`${GONG_API_BASE}/v2/calls/extensive`, {
      method: 'POST',
      headers: gongHeaders,
      body: JSON.stringify({
        filter: { callIds: batchIds },
        contentSelector: { exposedFields: { parties: true } },
      }),
    }),
    fetch(`${GONG_API_BASE}/v2/calls/transcript`, {
      method: 'POST',
      headers: gongHeaders,
      body: JSON.stringify({ filter: { callIds: batchIds } }),
    }),
  ])

  const detailsData = await detailsRes.json().catch(() => ({}))
  const transcriptData = await transcriptRes.json().catch(() => ({}))

  const partiesMap = {}
  ;(detailsData.calls || []).forEach(c => {
    const id = c.metaData?.id || c.id
    partiesMap[id] = c.parties || []
  })

  const transcriptMap = {}
  ;(transcriptData.callTranscripts || []).forEach(t => {
    transcriptMap[t.callId] = t.transcript || []
  })

  // 5. Load accounts for matching (paginated — the table is >1,000 rows, so a bare
  // .limit(1000) would truncate A–Z and silently drop matches for later-alphabet names).
  let accounts = []
  const ACCT_PAGE = 1000
  for (let from = 0; ; from += ACCT_PAGE) {
    const { data: page } = await db.from('accounts').select('id, name').range(from, from + ACCT_PAGE - 1)
    if (!page || !page.length) break
    accounts = accounts.concat(page)
    if (page.length < ACCT_PAGE) break
  }

  // 6. Process each call
  const newInsertRows = []
  const transcriptUpdates = [] // { callId, transcriptText }
  let imported = 0

  for (const call of toImport) {
    const parties = partiesMap[call.id] || []
    const speakerMap = {}
    parties.forEach(p => {
      speakerMap[p.speakerId] = {
        name: p.name || p.emailAddress || `Speaker ${p.speakerId}`,
        affiliation: p.affiliation,
      }
    })

    const segments = transcriptMap[call.id] || []
    let transcriptText = ''
    segments.forEach(segment => {
      const speaker = speakerMap[segment.speakerId] || { name: `Speaker ${segment.speakerId}`, affiliation: 'unknown' }
      const label = speaker.affiliation === 'Internal' || speaker.affiliation === 'internal'
        ? `[REP] ${speaker.name}`
        : `[PROSPECT] ${speaker.name}`
      ;(segment.sentences || []).forEach(s => {
        transcriptText += `${label}: ${s.text}\n`
      })
    })
    if (!transcriptText.trim()) transcriptText = '[No transcript available for this call]'

    const user = userMap[call.primaryUserId] || null

    if (existingCallIds.has(call.id)) {
      // Already in DB — update transcript_text only (don't touch analyzed_at or account_id)
      transcriptUpdates.push({ callId: call.id, transcriptText })
      imported++
      continue
    }

    // New call — find account match
    let accountId = null
    let matchConf = null
    if (accounts?.length && call.title) {
      let best = null, bestScore = 0
      for (const account of accounts) {
        const score = matchScore(account.name, call.title)
        if (score > bestScore) { bestScore = score; best = account }
      }
      if (best && bestScore >= 6) {
        accountId = best.id
        matchConf = bestScore / 10
      }
    }

    // Classify at import time (no LLM — title heuristic + participant affiliation) so the
    // backlog drain can route which calls get analyzed, and internal team meetings and
    // no-shows are tagged up front instead of waiting on analysis.
    const internal = isInternalCall(parties)
    const derivedType = internal ? 'internal' : deriveDerivedCallType(call.title)
    const category = internal ? 'internal' : deriveCallCategory(derivedType)
    const isNoShow = (call.duration || 0) > 0 && (call.duration || 0) < 120

    const row = {
      gong_call_id: call.id,
      title: call.title || 'Untitled',
      call_date: call.started || null,
      call_type: getCallType(call.title),
      derived_call_type: isNoShow ? 'no_show' : derivedType,
      call_category: category,
      rep_name: user?.name || null,
      rep_email: user?.email || null,
      duration_seconds: call.duration || 0,
      gong_url: call.url || null,
      transcript_text: transcriptText,
      analyzed_at: null,
      ignored: isNoShow,
      ignore_reason: isNoShow ? 'no_show' : null,
    }
    if (accountId) {
      row.account_id = accountId
      row.match_confidence = matchConf
      row.match_method = 'title_fuzzy_inline'
    }
    newInsertRows.push(row)
    imported++
  }

  // 7. Write to DB
  if (newInsertRows.length) {
    const { error } = await db
      .from('gong_call_analyses')
      .upsert(newInsertRows, { onConflict: 'gong_call_id' })
    if (error) {
      console.error('[backfill-historical] insert error:', error.message)
      return res.status(500).json({ error: 'DB insert failed: ' + error.message })
    }
  }

  for (const { callId, transcriptText } of transcriptUpdates) {
    await db
      .from('gong_call_analyses')
      .update({ transcript_text: transcriptText })
      .eq('gong_call_id', callId)
  }

  const skipped = allCalls.length - toImport.length
  console.log(`[backfill-historical] ${imported} imported, ${skipped} skipped (already have transcript), next cursor: ${nextCursor || 'none'}`)

  return res.status(200).json({
    imported,
    skipped,
    cursor: nextCursor,
    done: !nextCursor,
  })
  } catch (e) {
    console.error('[backfill-historical] unhandled exception:', e.message, e.stack)
    return res.status(500).json({ error: 'Unhandled exception: ' + e.message })
  }
}
