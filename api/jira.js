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

  async function jiraGet(path) {
    const r = await fetch(`${JIRA_URL}/rest/api/3${path}`, { headers: H });
    if (!r.ok) throw new Error(`Jira ${r.status}: ${(await r.text()).slice(0,200)}`);
    return r.json();
  }

  async function search(jql, fields, maxResults = 100) {
    const all = [];
    let nextPageToken = null;
    while (true) {
      const payload = { jql, fields, maxResults };
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

  // ── DIAGNÓSTICO: ver TODOS los campos del ticket TK-648 ──
  if (action === 'debugFields') {
    try {
      const r = await fetch(`${JIRA_URL}/rest/api/3/issue/TK-648?expand=names`, { headers: H });
      const data = await r.json();
      const f = data.fields || {};
      const names = data.names || {}; // mapeo customfield_XXXX → nombre legible

      // Filtrar solo customfields con valor no nulo
      const customs = {};
      for (const [k, v] of Object.entries(f)) {
        if (k.startsWith('customfield_') && v !== null && v !== undefined) {
          customs[k] = {
            name:  names[k] || k,
            value: v
          };
        }
      }
      return res.status(200).json({
        key:        data.key,
        status:     f.status?.name,
        issuetype:  f.issuetype?.name,
        components: f.components?.map(c=>c.name),
        customfields: customs
      });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // ── El resto de acciones usa estos campos ────────────────
  const FIELDS = [
    'summary','status','issuetype','assignee','reporter',
    'created','components','labels','priority',
    'customfield_10010', // requestType
    // Área Usuario — se detecta automáticamente abajo
  ];

  const AREAS = ['Operaciones','Admin. & Finanzas','TI','Torre de Control',
                 'Recursos Humanos','Marketing','Proyectos'];

  // ID del campo Area Usuario — se detectará en runtime
  let AREA_FIELD_ID = process.env.JIRA_AREA_FIELD || null;

  function extractAreaFromFields(f) {
    // Si ya conocemos el field ID úsalo directamente
    if (AREA_FIELD_ID && f[AREA_FIELD_ID]) {
      const v = f[AREA_FIELD_ID];
      if (typeof v === 'string') return v;
      if (v?.value) return v.value;
      if (v?.name)  return v.name;
      if (Array.isArray(v) && v.length) return v[0]?.value || v[0]?.name || String(v[0]);
    }
    // Búsqueda automática en todos los customfields
    for (const [k, v] of Object.entries(f)) {
      if (!k.startsWith('customfield_') || !v) continue;
      const str = typeof v === 'string' ? v
                : v?.value || v?.name || (Array.isArray(v) ? (v[0]?.value||v[0]?.name||'') : '');
      if (str && AREAS.some(a => str.includes(a))) {
        AREA_FIELD_ID = k; // cachear para próximas llamadas
        return str;
      }
    }
    if (f.components?.length) {
      const c = f.components[0]?.name || '';
      if (AREAS.some(a => c.includes(a))) return c;
    }
    return 'Sin área';
  }

  function mapStatus(s) {
    if (!s) return 'Esp. ayuda';
    const v = s.toUpperCase();
    if (v.includes('RESUELTO')  || v.includes('RESOLVED') || v.includes('DONE'))    return 'Resuelto';
    if (v.includes('CANCELADO') || v.includes('CANCELLED'))  return 'Cancelado';
    if (v.includes('ESCALADO')  || v.includes('ESCALATED'))  return 'Escalado';
    if (v.includes('ESPERANDO POR EL CLIENTE') || v.includes('WAITING FOR CUSTOMER')) return 'Esp. cliente';
    return 'Esp. ayuda';
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
      area:         extractAreaFromFields(f),
      assignee:     f.assignee?.displayName || 'Sin asignar',
      reporter:     f.reporter?.displayName || 'Desconocido',
      created:      (f.created || '').slice(0, 10),
      components:   (f.components || []).map(c => c.name),
      labels:       f.labels || []
    };
  }

  // Obtener el ID del campo Area Usuario consultando TK-648
  async function getAreaFieldId() {
    try {
      const r = await fetch(`${JIRA_URL}/rest/api/3/issue/TK-648?expand=names`, { headers: H });
      const data = await r.json();
      const f = data.fields || {};
      const names = data.names || {};
      for (const [k, nm] of Object.entries(names)) {
        if (nm && (nm.toLowerCase().includes('area') || nm.toLowerCase().includes('área'))) {
          if (f[k]) { AREA_FIELD_ID = k; return k; }
        }
      }
    } catch {}
    return null;
  }

  if (action === 'getProjectInfo') {
    try {
      await getAreaFieldId();
      const d = await jiraGet(`/project/${JIRA_PROJ}`);
      return res.status(200).json({ key: d.key, name: d.name, url: JIRA_URL, areaFieldId: AREA_FIELD_ID });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  if (action === 'getMonthTickets') {
    const { year, month } = body;
    if (!year || !month) return res.status(400).json({ error: 'Faltan: year, month' });
    await getAreaFieldId();
    if (AREA_FIELD_ID && !FIELDS.includes(AREA_FIELD_ID)) FIELDS.push(AREA_FIELD_ID);
    const p = n => String(n).padStart(2,'0');
    const y = parseInt(year,10), m = parseInt(month,10);
    const jql = `project="${JIRA_PROJ}" AND created>="${y}-${p(m)}-01" AND created<="${y}-${p(m)}-${new Date(y,m,0).getDate()}" ORDER BY created DESC`;
    try {
      return res.status(200).json({ issues: (await search(jql, FIELDS, 100)).map(fmt) });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  if (action === 'getPendingTickets') {
    await getAreaFieldId();
    if (AREA_FIELD_ID && !FIELDS.includes(AREA_FIELD_ID)) FIELDS.push(AREA_FIELD_ID);
    const jql = `project="${JIRA_PROJ}" AND status in ("Esperando por ayuda","Esperando por el cliente","Escalado") ORDER BY created ASC`;
    try {
      return res.status(200).json({ pending: (await search(jql, FIELDS, 100)).map(fmt) });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  return res.status(400).json({ error: `Acción desconocida: "${action}"` });
};
