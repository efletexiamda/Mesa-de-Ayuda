module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const JIRA_EMAIL = process.env.JIRA_EMAIL;
  const JIRA_TOKEN = process.env.JIRA_TOKEN;
  const JIRA_URL   = process.env.JIRA_URL   || 'https://efletexia.atlassian.net';
  const JIRA_PROJ  = process.env.JIRA_PROJECT_KEY || 'TK';

  if (!JIRA_EMAIL || !JIRA_TOKEN) {
    return res.status(500).json({ error: 'Faltan variables: JIRA_EMAIL y JIRA_TOKEN' });
  }

  const auth = Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');
  const H = {
    'Authorization': `Basic ${auth}`,
    'Accept':        'application/json',
    'Content-Type':  'application/json'
  };

  const body   = req.method === 'POST' ? (req.body || {}) : (req.query || {});
  const action = body.action;

  const FIELDS = ['summary','status','issuetype','assignee','reporter',
                  'created','components','labels','priority','customfield_10010'];

  async function jiraGet(path) {
    const r = await fetch(`${JIRA_URL}/rest/api/3${path}`, { headers: H });
    if (!r.ok) throw new Error(`Jira ${r.status}: ${(await r.text()).slice(0,200)}`);
    return r.json();
  }

  // Nueva API Jira Cloud con nextPageToken
  async function search(jql, maxResults = 100) {
    const all = [];
    let nextPageToken = null;
    while (true) {
      const payload = { jql, fields: FIELDS, maxResults };
      if (nextPageToken) payload.nextPageToken = nextPageToken;
      const r = await fetch(`${JIRA_URL}/rest/api/3/search/jql`, {
        method: 'POST', headers: H, body: JSON.stringify(payload)
      });
      if (!r.ok) throw new Error(`Jira search ${r.status}: ${(await r.text()).slice(0,300)}`);
      const data   = await r.json();
      const issues = data.issues || [];
      all.push(...issues);
      nextPageToken = data.nextPageToken || null;
      if (!nextPageToken || issues.length === 0 || all.length >= 500) break;
    }
    return all;
  }

  // Mapeo exacto de estados reales de Jira Mesa de Ayuda
  function mapStatus(statusName) {
    if (!statusName) return 'Esperando por ayuda';
    const s = statusName.toUpperCase();
    if (s.includes('RESUELTO')  || s.includes('RESOLVED') || s.includes('DONE') || s.includes('CLOSED')) return 'Resuelto';
    if (s.includes('CANCELADO') || s.includes('CANCELLED') || s.includes('CANCELED')) return 'Cancelado';
    if (s.includes('ESCALADO')  || s.includes('ESCALATED')) return 'Escalado';
    if (s.includes('ESPERANDO POR EL CLIENTE') || s.includes('WAITING FOR CUSTOMER')) return 'Esp. cliente';
    return 'Esp. ayuda'; // ESPERANDO POR AYUDA y cualquier otro
  }

  function fmt(iss) {
    const f = iss.fields || {};
    return {
      key:         iss.key,
      summary:     f.summary || '',
      status:      f.status?.name || '',
      statusMapped: mapStatus(f.status?.name),
      issuetype:   f.issuetype?.name || '',
      requesttype: f.customfield_10010?.requestType?.name || f.issuetype?.name || '',
      assignee:    f.assignee?.displayName || 'Sin asignar',
      reporter:    f.reporter?.displayName || 'Desconocido',
      created:     (f.created || '').slice(0, 10),
      components:  (f.components || []).map(c => c.name),
      labels:      f.labels || []
    };
  }

  if (action === 'getProjectInfo') {
    try {
      const d = await jiraGet(`/project/${JIRA_PROJ}`);
      return res.status(200).json({ key: d.key, name: d.name, url: JIRA_URL });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  if (action === 'getMonthTickets') {
    const { year, month } = body;
    if (!year || !month) return res.status(400).json({ error: 'Faltan: year, month' });
    const p = n => String(n).padStart(2,'0');
    const y = parseInt(year,10), m = parseInt(month,10);
    const jql = `project="${JIRA_PROJ}" AND created>="${y}-${p(m)}-01" AND created<="${y}-${p(m)}-${new Date(y,m,0).getDate()}" ORDER BY created DESC`;
    try {
      return res.status(200).json({ issues: (await search(jql,100)).map(fmt) });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // Pendientes: estados activos exactos de Mesa de Ayuda
  if (action === 'getPendingTickets') {
    const jql = `project="${JIRA_PROJ}" AND status in ("Esperando por ayuda","Esperando por el cliente","Escalado") ORDER BY created ASC`;
    try {
      return res.status(200).json({ pending: (await search(jql,100)).map(fmt) });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  return res.status(400).json({ error: `Acción desconocida: "${action}"` });
};
