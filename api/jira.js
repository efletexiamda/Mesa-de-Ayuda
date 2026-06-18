// ═══════════════════════════════════════════════════════════
//  api/jira.js  —  Vercel Serverless Function (CommonJS)
//  Consulta Jira Service Management DIRECTAMENTE con API Token
//  Sin dependencia de Claude API ni ninguna IA externa
// ═══════════════════════════════════════════════════════════
module.exports = async function handler(req, res) {

  // ── CORS ──────────────────────────────────────────────────
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── CONFIGURACIÓN ─────────────────────────────────────────
  const JIRA_EMAIL = process.env.JIRA_EMAIL;
  const JIRA_TOKEN = process.env.JIRA_TOKEN;
  const JIRA_URL   = process.env.JIRA_URL   || 'https://efletexia.atlassian.net';
  const JIRA_PROJ  = process.env.JIRA_PROJECT_KEY || 'TK';

  if (!JIRA_EMAIL || !JIRA_TOKEN) {
    return res.status(500).json({
      error: 'Faltan variables de entorno: JIRA_EMAIL y JIRA_TOKEN'
    });
  }

  // ── AUTH HEADER ───────────────────────────────────────────
  const auth = Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');
  const headers = {
    'Authorization': `Basic ${auth}`,
    'Accept':        'application/json',
    'Content-Type':  'application/json'
  };

  // ── PARÁMETROS ────────────────────────────────────────────
  const body   = req.method === 'POST' ? (req.body || {}) : (req.query || {});
  const action = body.action;

  // ── HELPER: llamar a Jira REST API ────────────────────────
  async function jiraGet(path) {
    const r = await fetch(`${JIRA_URL}/rest/api/3${path}`, { headers });
    if (!r.ok) {
      const txt = await r.text();
      throw new Error(`Jira API ${r.status}: ${txt.slice(0, 300)}`);
    }
    return r.json();
  }

  // ── HELPER: buscar issues con JQL ─────────────────────────
  async function searchJQL(jql, fields, maxResults = 100) {
    const allIssues = [];
    let startAt = 0;

    while (true) {
      const r = await fetch(`${JIRA_URL}/rest/api/3/search`, {
        method:  'POST',
        headers,
        body: JSON.stringify({ jql, fields, maxResults, startAt })
      });
      if (!r.ok) {
        const txt = await r.text();
        throw new Error(`Jira search ${r.status}: ${txt.slice(0, 300)}`);
      }
      const data = await r.json();
      allIssues.push(...(data.issues || []));

      if (allIssues.length >= data.total || !data.issues?.length) break;
      startAt += data.issues.length;
      if (allIssues.length >= 500) break; // límite de seguridad
    }

    return allIssues;
  }

  // ── HELPER: formatear issue ───────────────────────────────
  function formatIssue(iss) {
    const f = iss.fields || {};
    return {
      key:         iss.key,
      summary:     f.summary || '',
      status:      f.status?.name || '',
      issuetype:   f.issuetype?.name || '',
      requesttype: f.customfield_10010?.requestType?.name || f.issuetype?.name || '',
      assignee:    f.assignee?.displayName || 'Sin asignar',
      reporter:    f.reporter?.displayName || 'Desconocido',
      created:     (f.created || '').slice(0, 10),
      components:  (f.components || []).map(c => c.name),
      labels:      f.labels || [],
      priority:    f.priority?.name || ''
    };
  }

  const FIELDS = [
    'summary', 'status', 'issuetype', 'assignee', 'reporter',
    'created', 'components', 'labels', 'priority',
    'customfield_10010' // requestType en JSM
  ];

  // ══════════════════════════════════════════════════════════
  //  ACCIÓN: test — verificar conexión
  // ══════════════════════════════════════════════════════════
  if (action === 'test') {
    try {
      const data = await jiraGet('/myself');
      return res.status(200).json({
        ok: true,
        user: data.displayName,
        email: data.emailAddress
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ══════════════════════════════════════════════════════════
  //  ACCIÓN: getMonthTickets
  //  Todos los tickets de un mes del proyecto Mesa de Ayuda
  // ══════════════════════════════════════════════════════════
  if (action === 'getMonthTickets') {
    const { year, month } = body;
    if (!year || !month)
      return res.status(400).json({ error: 'Faltan: year, month' });

    const pad  = n => String(n).padStart(2, '0');
    const y    = parseInt(year,  10);
    const m    = parseInt(month, 10);
    const from = `${y}-${pad(m)}-01`;
    const to   = `${y}-${pad(m)}-${new Date(y, m, 0).getDate()}`;
    const jql  = `project = "${JIRA_PROJ}" AND created >= "${from}" AND created <= "${to}" ORDER BY created DESC`;

    try {
      const issues = await searchJQL(jql, FIELDS);
      return res.status(200).json({ issues: issues.map(formatIssue) });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ══════════════════════════════════════════════════════════
  //  ACCIÓN: getPendingTickets
  //  Tickets activos que requieren atención
  // ══════════════════════════════════════════════════════════
  if (action === 'getPendingTickets') {
    const jql = `project = "${JIRA_PROJ}" AND statusCategory != Done ORDER BY created ASC`;

    try {
      const issues = await searchJQL(jql, FIELDS, 100);
      return res.status(200).json({ pending: issues.map(formatIssue) });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ══════════════════════════════════════════════════════════
  //  ACCIÓN: getProjectInfo
  //  Información del proyecto
  // ══════════════════════════════════════════════════════════
  if (action === 'getProjectInfo') {
    try {
      const data = await jiraGet(`/project/${JIRA_PROJ}`);
      return res.status(200).json({
        key:  data.key,
        name: data.name,
        url:  JIRA_URL
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(400).json({ error: `Acción desconocida: "${action}"` });
};
