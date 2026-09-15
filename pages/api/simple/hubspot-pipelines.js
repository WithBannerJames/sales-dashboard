// GET /api/simple/hubspot-pipelines
// Read-only diagnostic: every deal pipeline in HubSpot, its stages, and how many deals sit in
// each. Exists because sync-deals filters on a single hardcoded pipeline id (SALES_PIPELINE_ID
// = 663206213), so any deal living in another pipeline silently vanishes from our data and
// freezes at its last-known stage — that is what happened to MAA, which is in "Deals One".
//
// Secured by CRON_SECRET (the HubSpot key is server-side only).

const HS = 'https://api.hubapi.com';

export default async function handler(req, res) {
  const secret = (process.env.CRON_SECRET || '').trim();
  if (!secret) return res.status(503).json({ error: 'CRON_SECRET not configured' });
  if (req.headers['authorization'] !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' });

  const key = (process.env.HUBSPOT_API_KEY || '').trim();
  if (!key) return res.status(500).json({ error: 'HUBSPOT_API_KEY not configured' });
  const auth = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

  // ?dealId= looks one deal up directly, live and then archived. HubSpot's search API hides
  // archived records, so a deal that was deleted looks identical to one that never existed —
  // this is how we tell "moved pipeline" from "archived" from "hard deleted".
  const { dealId } = req.query;
  if (dealId) {
    const props = 'dealname,dealstage,pipeline,closedate,amount,hs_lastmodifieddate,hs_is_closed';
    const out = {};
    for (const archived of [false, true]) {
      try {
        const r = await fetch(`${HS}/crm/v3/objects/deals/${dealId}?properties=${props}&archived=${archived}`, { headers: auth });
        out[archived ? 'archived' : 'live'] = r.ok
          ? { found: true, ...(await r.json()) }
          : { found: false, status: r.status };
      } catch (e) {
        out[archived ? 'archived' : 'live'] = { found: false, error: e.message };
      }
    }
    return res.status(200).json({ dealId, ...out });
  }

  try {
    const r = await fetch(`${HS}/crm/v3/pipelines/deals`, { headers: auth });
    if (!r.ok) return res.status(502).json({ error: `pipelines fetch failed: ${r.status}` });
    const { results = [] } = await r.json();

    const pipelines = [];
    for (const p of results) {
      // One search per pipeline, limit 1 — we only want `total`.
      let total = null;
      try {
        const c = await fetch(`${HS}/crm/v3/objects/deals/search`, {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({
            filterGroups: [{ filters: [{ propertyName: 'pipeline', operator: 'EQ', value: p.id }] }],
            limit: 1,
          }),
        });
        if (c.ok) total = (await c.json()).total ?? null;
      } catch { /* leave null */ }

      pipelines.push({
        id: p.id,
        label: p.label,
        dealCount: total,
        isOurSyncTarget: p.id === '663206213',
        stages: (p.stages || [])
          .sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0))
          .map((s) => ({
            id: s.id,
            label: s.label,
            closed: s.metadata?.isClosed === 'true' || s.metadata?.isClosed === true,
            probability: s.metadata?.probability ?? null,
          })),
      });
    }

    return res.status(200).json({
      syncCurrentlyCovers: '663206213',
      pipelines: pipelines.sort((a, b) => (b.dealCount || 0) - (a.dealCount || 0)),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
