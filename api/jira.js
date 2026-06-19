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

  // Traer TODOS los campos para identificar el campo de área usuaria
  const FIELDS = [
    'summary','status','issuetype','assignee','reporter',
    'created','components','labels','priority',
    'customfield_10010', // requestType (tipo de solicitud)
    'customfield_10014', // posible campo área
    'customfield_10020', // posible campo área
    'customfield_10056', // posible campo área
    'customfield_10057', // posible campo área
    'customfield_10058', // posible campo área
    'customfield_10060', // posible campo área
    'customfield_10061', // posible campo área
    'customfield_10062', // posible campo área
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

  // Áreas usuarias reales
  const AREAS = ['Operaciones','Admin. & Finanzas','TI','Torre de Control',
                 'Recursos Humanos','Marketing','Proyectos'];

  function extractArea(f) {
    // Buscar en todos los customfields el valor que coincida con las áreas reales
    for (const key of Object.keys(f)) {
      if (!key.startsWith('customfield_')) continue;
      const val = f[key];
      if (!val) continue;
      // Si es string directo
      if (typeof val === 'string' && AREAS.some(a => val.includes(a))) return val;
      // Si es objeto con value
      if (val?.value && AREAS.some(a => val.value.includes(a))) return val.value;
      // Si es array
      if (Array.isArray(val)) {
        for (const item of val) {
          if (typeof item === 'string' && AREAS.some(a => item.includes(a))) return item;
          if (item?.value && AREAS.some(a => item.value.includes(a))) return item.value;
          if (item?.name  && AREAS.some(a => item.name.includes(a)))  return item.name;
        }
      }
    }
    // Buscar en components
    if (f.components?.length) {
      const comp = f.components[0]?.name || '';
      if (AREAS.some(a => comp.includes(a))) return comp;
    }
    return null;
  }

  function mapStatus(s) {
    if (!s) return 'Esp. ayuda';
    const v = s.toUpperCase();
    if (v.includes('RESUELTO')  || v.includes('RESOLVED') || v.includes('DONE'))    return 'Resuelto';
    if (v.includes('CANCELADO') || v.includes('CANCELLED') || v.includes('CANCELED')) return 'Cancelado';
    if (v.includes('ESCALADO')  || v.includes('ESCALATED'))  return 'Escalado';
    if (v.includes('ESPERANDO POR EL CLIENTE') || v.includes('WAITING FOR CUSTOMER')) return 'Esp. cliente';
    return 'Esp. ayuda';
  }

  function fmt(iss) {
    const f = iss.fields || {};
    const areaUsuaria = extractArea(f) || 'Sin área';
    const requestType = f.customfield_10010?.requestType?.name || f.issuetype?.name || '';

    return {
      key:          iss.key,
      summary:      f.summary || '',
      status:       f.status?.name || '',
      statusMapped: mapStatus(f.status?.name),
      issuetype:    f.issuetype?.name || '',
      requesttype:  requestType,      // Tipo de solicitud (lo que se pedía)
      area:         areaUsuaria,      // Área usuaria real (Operaciones, TI, etc.)
      assignee:     f.assignee?.displayName || 'Sin asignar',
      reporter:     f.reporter?.displayName || 'Desconocido',
      created:      (f.created || '').slice(0, 10),
      components:   (f.components || []).map(c => c.name),
      labels:       f.labels || [],
      // Debug: exportar todos los customfields para identificar el campo correcto
      _customfields: Object.fromEntries(
        Object.entries(f)
          .filter(([k]) => k.startsWith('customfield_'))
          .map(([k,v]) => [k, v])
      )
    };
  }

  if (action === 'getProjectInfo') {
    try {
      const d = await jiraGet(`/project/${JIRA_PROJ}`);
      return res.status(200).json({ key: d.key, name: d.name, url: JIRA_URL });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // Acción de diagnóstico: ver campos de un ticket real
  if (action === 'debugFields') {
    try {
      const jql = `project="${JIRA_PROJ}" ORDER BY created DESC`;
      const issues = await search(jql, 1);
      if (!issues.length) return res.status(200).json({ msg: 'No hay issues' });
      const f = issues[0].fields || {};
      const customs = Object.fromEntries(
        Object.entries(f)
          .filter(([k,v]) => k.startsWith('customfield_') && v !== null)
          .map(([k,v]) => [k, v])
      );
      return res.status(200).json({
        key: issues[0].key,
        status: f.status?.name,
        issuetype: f.issuetype?.name,
        requestType: f.customfield_10010?.requestType?.name,
        components: f.components?.map(c=>c.name),
        customfields: customs
      });
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
