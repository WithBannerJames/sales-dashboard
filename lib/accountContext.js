// Shared account-context builder. The account chat endpoint is the richest-grounded surface
// (calls, tasks, stakeholders, gaps, notes, aggregated MEDDIC, memory, sales process) but was
// read-only; the write-capable GlobalAssistant saw only a one-line account summary and thus
// hallucinated on task/call/MEDDICC questions (PLATFORM_REVIEW §1.9/§9). This centralizes the
// grounding so both can share it. Returns { account, contextText } (contextText is the data block,
// caller supplies the system framing). db = service-role client.
import { getSalesProcessConfig } from './salesProcess';

export async function buildAccountContext(db, accountId) {
  if (!accountId) return { account: null, contextText: '' };

  const [accountRes, callsRes, tasksRes, stakeholdersRes, gapsRes, notesRes, processConfig, memoriesRes] = await Promise.all([
    db.from('accounts').select('id, name, stage, deal_value, owner_name, hubspot_deal_id, vertical, ownership_type, meddicc').eq('id', accountId).single(),
    db.from('gong_call_analyses').select('gong_call_id, title, analysis, analyzed_at, call_category').eq('account_id', accountId).not('analysis', 'is', null).or('call_category.is.null,call_category.not.in.(cs,internal)').order('analyzed_at', { ascending: false }).limit(15),
    db.from('tasks').select('id, title, status, due_date, source_type, dismissed_at').eq('account_id', accountId).is('dismissed_at', null).in('status', ['open', 'in_progress']).limit(20),
    db.from('stakeholders').select('name, title, role, email').eq('account_id', accountId).limit(15),
    db.from('information_gaps').select('question, category, status').eq('account_id', accountId).eq('status', 'open').limit(10),
    db.from('notes').select('content, created_at').eq('account_id', accountId).order('created_at', { ascending: false }).limit(5),
    getSalesProcessConfig(),
    db.from('account_memory').select('type, content').eq('account_id', accountId).eq('is_active', true).order('created_at', { ascending: false }).limit(5).then(r => r, () => ({ data: [] })),
  ]);

  const account = accountRes.data;
  if (!account) return { account: null, contextText: '' };

  const calls = callsRes.data || [];
  const tasks = tasksRes.data || [];
  const stakeholders = stakeholdersRes.data || [];
  const gaps = gapsRes.data || [];
  const notes = notesRes.data || [];
  const memories = memoriesRes.data || [];

  const stakeholderLines = stakeholders.length
    ? stakeholders.map(s => `- ${[s.name, s.title, s.role, s.role === 'Champion' ? '[Champion]' : ''].filter(Boolean).join(' | ')}`).join('\n')
    : '- No stakeholders on record';
  const taskLines = tasks.length
    ? tasks.map(t => `- [${t.status}] ${t.title}${t.due_date ? ` (due ${t.due_date.slice(0, 10)})` : ''}`).join('\n')
    : '- No open tasks';
  const gapLines = gaps.length ? gaps.map(g => `- [${g.category || 'general'}] ${g.question}`).join('\n') : '- None';
  const noteLines = notes.length ? notes.map(n => `- (${n.created_at?.slice(0, 10)}) ${(n.content || '').slice(0, 250)}`).join('\n') : '- No notes';

  // MEDDICC: prefer the account-level field (once the write-back populates it), else aggregate from calls.
  const meddicKeys = ['metrics', 'economic_buyer', 'decision_criteria', 'decision_process', 'paper_process', 'identify_pain', 'champion', 'competition'];
  const acctMeddic = account.meddicc || {};
  const meddicLines = meddicKeys.map(key => {
    const label = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    let val = null;
    const am = acctMeddic[key];
    if (am && typeof am === 'string' && am.trim()) val = am.trim();
    else if (am && typeof am === 'object' && am.value) val = String(am.value);
    if (!val) {
      for (const c of calls) {
        const m = (c.analysis?.meddic || c.analysis?.meddicc || {})[key];
        if (m && typeof m === 'string' && m.trim() && !['unknown', 'none'].includes(m.toLowerCase())) { val = m.trim(); break; }
      }
    }
    return `  ${label}: ${val || 'Not captured'}`;
  }).join('\n');

  const callLines = calls.map((c, i) => {
    const a = c.analysis || {};
    return `Call ${i + 1} (${c.analyzed_at?.slice(0, 10) || '?'}) "${c.title || 'untitled'}":
  Summary: ${(a.summary || 'No summary').slice(0, 300)}
  Buying signals: ${(a.buying_signals || []).slice(0, 2).join('; ') || 'None'}
  Red flags: ${(a.red_flags || []).slice(0, 2).join('; ') || 'None'}
  Next steps: ${(a.next_steps_mentioned || []).slice(0, 3).join('; ') || 'None'}
  ICP ${a.icp_score ?? '?'}/10 · Discovery ${a.discovery_score ?? '?'}/10`;
  }).join('\n\n');

  let salesProcessSnippet = '';
  if (processConfig) {
    const stage = account.stage || 'unknown';
    const exit = processConfig.stage_exit_criteria || '';
    const m = exit.match(new RegExp(`${stage}[^\\n]*:[\\s\\S]{0,400}`, 'i'));
    salesProcessSnippet = `SALES PROCESS: exit criteria (${stage}): ${(m ? m[0] : exit).slice(0, 350)}\nICP: ${(processConfig.icp_definition || '').slice(0, 250)}`;
  }

  const memoryText = memories.length ? `\nSAVED INSIGHTS:\n${memories.map(m => `[${m.type}] ${m.content}`).join('\n')}` : '';

  const contextText = `ACCOUNT: ${account.name} | Stage: ${account.stage || '?'} | Value: ${account.deal_value ? '$' + Number(account.deal_value).toLocaleString() : '?'} | Owner: ${account.owner_name || '?'} | Vertical: ${account.vertical || '?'}

STAKEHOLDERS (${stakeholders.length}):
${stakeholderLines}

OPEN TASKS (${tasks.length}):
${taskLines}

OPEN INFORMATION GAPS (${gaps.length}):
${gapLines}

RECENT NOTES:
${noteLines}

MEDDIC:
${meddicLines}

CALL HISTORY (${calls.length} analyzed):
${callLines || 'No analyzed calls yet.'}

${salesProcessSnippet}${memoryText}`;

  return { account, contextText };
}
