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

  const AREA_FIELD    = 'customfield_10393'; // Area Usuario
  const APPTYPE_FIELD = 'customfield_10360'; // Tipo de Aplicación
  const PART_FIELD    = 'customfield_10279'; // Participantes de la solicitud

  const FIELDS = [
    'summary','status','issuetype','assignee','reporter',
    'created','components','labels','priority',
    'customfield_10010', // Tipo de solicitud
    AREA_FIELD,
    APPTYPE_FIELD,
    PART_FIELD
  ];

  async function jiraGet(path) {
    const r = await fetch(`${JIRA_URL}/rest/api/3${path}`, { headers: H });
    if (!r.ok) throw new Error(`Jira ${r.status}: ${(await r.text()).slice(0,200)}`);
    return r.json();
  }

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

  function mapStatus(s) {
    if (!s) return 'Esp. ayuda';
    const v = s.toUpperCase();
    if (v.includes('RESUELTO')  || v.includes('RESOLVED') || v.includes('DONE'))      return 'Resuelto';
    if (v.includes('CANCELADO') || v.includes('CANCELLED') || v.includes('CANCELED')) return 'Cancelado';
    if (v.includes('ESCALADO')  || v.includes('ESCALATED'))                            return 'Escalado';
    if (v.includes('ESPERANDO POR EL CLIENTE') || v.includes('WAITING FOR CUSTOMER')) return 'Esp. cliente';
    return 'Esp. ayuda';
  }

  function getArea(f) {
    const raw = f[AREA_FIELD];
    if (!raw) return 'Sin área';
    if (typeof raw === 'string') return raw;
    if (raw.value) return raw.value;
    if (raw.name)  return raw.name;
    if (Array.isArray(raw) && raw.length) return raw[0]?.value || raw[0]?.name || 'Sin área';
    return 'Sin área';
  }

  function getAppType(f) {
    const raw = f[APPTYPE_FIELD];
    if (!raw) return 'Sin app';
    if (typeof raw === 'string') return raw;
    if (raw.value) return raw.value;
    if (raw.name)  return raw.name;
    return 'Sin app';
  }

  function getParticipants(f) {
    const raw = f[PART_FIELD];
    if (!raw || !Array.isArray(raw)) return [];
    return raw.map(p => p.displayName || p.name || '').filter(Boolean);
  }

  function fmt(iss) {
    const f = iss.fields || {};
    return {
      key:          iss.key,
      summary:      f.summary || '',
      status:       f.status?.name || '',
      statusMapped: mapStatus(f.status?.name),
      issuetype:    f.issuetype?.name || '',
      requesttype:  f.customfield_10010?.requestType?.name || f.issuetype?.name || '',
      area:         getArea(f),
      apptype:      getAppType(f),
      participants: getParticipants(f),
      assignee:     f.assignee?.displayName || 'Sin asignar',
      reporter:     f.reporter?.displayName || 'Desconocido',
      created:      (f.created || '').slice(0, 10),
      components:   (f.components || []).map(c => c.name),
      labels:       f.labels || []
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

  if (action === 'getPendingTickets') {
    const jql = `project="${JIRA_PROJ}" AND status in ("Esperando por ayuda","Esperando por el cliente","Escalado") ORDER BY created ASC`;
    try {
      return res.status(200).json({ pending: (await search(jql,100)).map(fmt) });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  return res.status(400).json({ error: `Acción desconocida: "${action}"` });
};
