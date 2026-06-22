// ═══════════════════════════════════════════════════════════
//  api/agent.js  —  Agente IA para Mesa de Ayuda
//  Resuelve casos recurrentes usando Claude API
//  Integrado con historial de Jira
// ═══════════════════════════════════════════════════════════
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const JIRA_EMAIL    = process.env.JIRA_EMAIL;
  const JIRA_TOKEN    = process.env.JIRA_TOKEN;
  const JIRA_URL      = process.env.JIRA_URL || 'https://efletexia.atlassian.net';
  const JIRA_PROJ     = process.env.JIRA_PROJECT_KEY || 'TK';

  if (!ANTHROPIC_KEY) {
    return res.status(500).json({ error: 'Falta ANTHROPIC_API_KEY en variables de entorno' });
  }

  const body   = req.method === 'POST' ? (req.body || {}) : (req.query || {});
  const action = body.action;

  // ── Auth Jira ──────────────────────────────────────────
  const jiraAuth = Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');
  const jiraH = {
    'Authorization': `Basic ${jiraAuth}`,
    'Accept':        'application/json',
    'Content-Type':  'application/json'
  };

  // ── Buscar tickets similares en Jira ───────────────────
  async function findSimilarTickets(query) {
    if (!JIRA_EMAIL || !JIRA_TOKEN) return [];
    try {
      const jql = `project="${JIRA_PROJ}" AND summary~"${query.replace(/"/g,'')}" AND status="Resuelto" ORDER BY created DESC`;
      const payload = {
        jql,
        fields: ['summary','status','description','comment','resolution','customfield_10393'],
        maxResults: 5
      };
      const r = await fetch(`${JIRA_URL}/rest/api/3/search/jql`, {
        method: 'POST', headers: jiraH, body: JSON.stringify(payload)
      });
      if (!r.ok) return [];
      const data = await r.json();
      return (data.issues || []).map(iss => {
        const f = iss.fields || {};
        // Extraer último comentario de resolución
        const comments = f.comment?.comments || [];
        const lastComment = comments[comments.length - 1]?.body?.content?.[0]?.content?.[0]?.text || '';
        return {
          key:         iss.key,
          summary:     f.summary || '',
          resolution:  f.resolution?.name || 'Resuelto',
          lastComment: lastComment.slice(0, 300)
        };
      });
    } catch { return []; }
  }

  // ── Llamar a Claude ────────────────────────────────────
  async function callClaude(messages, system) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-6',
        max_tokens: 1000,
        system,
        messages
      })
    });
    if (!r.ok) throw new Error(`Claude API ${r.status}: ${await r.text()}`);
    const data = await r.json();
    return data.content.filter(b => b.type === 'text').map(b => b.text).join('');
  }

  // ══════════════════════════════════════════════════════
  //  ACCIÓN: chat — conversación con el agente
  // ══════════════════════════════════════════════════════
  if (action === 'chat') {
    const { messages, ticketContext } = body;
    if (!messages?.length) return res.status(400).json({ error: 'Falta messages' });

    const userMsg = messages[messages.length - 1]?.content || '';

    // Buscar tickets similares resueltos en Jira
    const similar = await findSimilarTickets(userMsg.slice(0, 50));
    const similarContext = similar.length
      ? `\nTickets similares resueltos en Jira:\n${similar.map(t =>
          `- ${t.key}: "${t.summary}" → ${t.resolution}${t.lastComment ? ` | Solución: ${t.lastComment}` : ''}`
        ).join('\n')}`
      : '';

    const system = `Eres el Agente IA de Mesa de Ayuda de Efletexia, especialista en soporte técnico de las aplicaciones de la empresa.

Tu rol es ayudar a resolver tickets de soporte técnico de forma rápida y efectiva.

APLICACIONES QUE SOPORTAS:
- Aplicacion T1: Sistema principal de gestión de transporte y logística
- Aplicacion T2: Sistema secundario de operaciones
- Torre de Control: Monitoreo y control de operaciones en tiempo real
- OPL: Sistema de gestión de pedidos y referencias
- Ruteador: Sistema de ruteo de transportistas

ÁREAS USUARIAS:
- Operaciones: Gestión de transportistas, cargas, rutas
- Admin. & Finanzas: Facturación, prefacturas, pagos
- TI: Infraestructura, accesos, configuraciones
- Torre de Control: Monitoreo en tiempo real
- Recursos Humanos: Gestión de personal
- Marketing: Campañas y comunicaciones
- Proyectos: Desarrollo e implementación

TIPOS DE CASOS FRECUENTES:
1. Liberación de pedidos: Verificar estado en OPL, revisar aprobaciones pendientes
2. Referencias a eliminar: Acceder a gestión de referencias, filtrar por número, aplicar eliminación
3. Cambios de placa: Módulo de transportistas → editar vehículo → actualizar placa
4. Diferencias de monto: Revisar prefactura vs factura, verificar tarifas configuradas
5. Accesos bloqueados: Verificar usuario en directorio, restablecer contraseña o permisos
6. Duplicación de registros: Identificar registro duplicado, consolidar o eliminar el erróneo
7. Fallas de aplicación: Limpiar caché, verificar conexión, reiniciar sesión

INSTRUCCIONES:
- Responde en español, de forma clara y paso a paso
- Si identificas el tipo de caso, da los pasos exactos de solución
- Si necesitas más información, pregunta específicamente qué datos faltan
- Menciona el ticket de Jira relacionado si encuentras uno similar resuelto
- Sé conciso: máximo 300 palabras por respuesta
- Si el caso requiere escalamiento, indícalo claramente
${ticketContext ? `\nCONTEXTO DEL TICKET ACTUAL:\n${ticketContext}` : ''}
${similarContext}`;

    try {
      const response = await callClaude(messages, system);
      return res.status(200).json({ response, similar });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ══════════════════════════════════════════════════════
  //  ACCIÓN: suggestSolution — solución rápida para un ticket
  // ══════════════════════════════════════════════════════
  if (action === 'suggestSolution') {
    const { ticketKey, summary, area, requesttype, issuetype } = body;
    if (!summary) return res.status(400).json({ error: 'Falta summary' });

    const similar = await findSimilarTickets(summary.slice(0, 60));

    const prompt = `Analiza este ticket de soporte y sugiere la solución más probable:

TICKET: ${ticketKey || 'N/A'}
RESUMEN: ${summary}
ÁREA USUARIA: ${area || 'No especificada'}
TIPO DE SOLICITUD: ${requesttype || issuetype || 'No especificado'}
TIPO: ${issuetype || 'No especificado'}

${similar.length ? `TICKETS SIMILARES RESUELTOS:
${similar.map(t => `- ${t.key}: "${t.summary}" → ${t.lastComment || t.resolution}`).join('\n')}` : ''}

Proporciona:
1. DIAGNÓSTICO: Qué tipo de problema es (1-2 oraciones)
2. SOLUCIÓN PASO A PASO: Pasos concretos para resolver (máximo 5 pasos)
3. TIEMPO ESTIMADO: Cuánto debería tomar resolverlo
4. ESCALAMIENTO: Si debe escalar y a quién`;

    try {
      const response = await callClaude(
        [{ role: 'user', content: prompt }],
        'Eres un experto en soporte técnico de Efletexia. Responde en español de forma concisa y práctica.'
      );
      return res.status(200).json({ solution: response, similar });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ══════════════════════════════════════════════════════
  //  ACCIÓN: analyzeRecurrent — análisis de casos recurrentes
  // ══════════════════════════════════════════════════════
  if (action === 'analyzeRecurrent') {
    const { recurrentCases } = body;
    if (!recurrentCases?.length) return res.status(400).json({ error: 'Falta recurrentCases' });

    const casesText = recurrentCases
      .slice(0, 10)
      .map(([name, count]) => `- "${name}": ${count} ocurrencias`)
      .join('\n');

    const prompt = `Analiza estos casos recurrentes de la Mesa de Ayuda de Efletexia y proporciona un plan de acción:

CASOS MÁS RECURRENTES:
${casesText}

Proporciona:
1. PATRÓN IDENTIFICADO: Qué causa raíz tienen en común
2. TOP 3 PRIORIDADES: Los casos que más impacto tienen y cómo resolverlos definitivamente
3. SOLUCIONES PREVENTIVAS: Qué cambios en procesos o sistemas evitarían estos casos
4. AUTOMATIZACIONES SUGERIDAS: Qué se podría automatizar para reducir tickets
5. KPI ESPERADO: Estimación de reducción de tickets si se implementan las mejoras`;

    try {
      const response = await callClaude(
        [{ role: 'user', content: prompt }],
        'Eres un consultor experto en optimización de mesas de ayuda. Responde en español con análisis profundo y recomendaciones prácticas.'
      );
      return res.status(200).json({ analysis: response });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(400).json({ error: `Acción desconocida: "${action}"` });
};
