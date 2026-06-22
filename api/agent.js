// ═══════════════════════════════════════════════════════════
//  api/agent.js  —  Agente IA Mesa de Ayuda · Efletexia
//  Soporta: Google Gemini (gratis) | Groq/Llama (gratis) | OpenAI
//  Configura UNA de estas variables en Vercel:
//    GEMINI_API_KEY   → Google Gemini (gratis)
//    GROQ_API_KEY     → Groq / Llama 3 (gratis)
//    OPENAI_API_KEY   → OpenAI GPT (pago)
// ═══════════════════════════════════════════════════════════
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── Detectar qué proveedor está configurado ──────────────
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  const GROQ_KEY   = process.env.GROQ_API_KEY;
  const OPENAI_KEY = process.env.OPENAI_API_KEY;

  const PROVIDER = GEMINI_KEY ? 'gemini' : GROQ_KEY ? 'groq' : OPENAI_KEY ? 'openai' : null;

  if (!PROVIDER) {
    return res.status(500).json({
      error: 'No hay API Key configurada. Agrega GEMINI_API_KEY, GROQ_API_KEY u OPENAI_API_KEY en Vercel.'
    });
  }

  // ── Jira (para buscar tickets similares) ─────────────────
  const JIRA_EMAIL = process.env.JIRA_EMAIL;
  const JIRA_TOKEN = process.env.JIRA_TOKEN;
  const JIRA_URL   = process.env.JIRA_URL || 'https://efletexia.atlassian.net';
  const JIRA_PROJ  = process.env.JIRA_PROJECT_KEY || 'TK';

  const body   = req.method === 'POST' ? (req.body || {}) : (req.query || {});
  const action = body.action;

  // ══════════════════════════════════════════════════════════
  //  LLAMADAS A LOS DISTINTOS PROVEEDORES DE IA
  // ══════════════════════════════════════════════════════════

  async function callGemini(prompt, system) {
    const fullPrompt = system ? `${system}\n\n${prompt}` : prompt;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: fullPrompt }] }],
        generationConfig: { maxOutputTokens: 1000, temperature: 0.7 }
      })
    });
    if (!r.ok) throw new Error(`Gemini ${r.status}: ${await r.text()}`);
    const data = await r.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }

  async function callGeminiChat(messages, system) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`;
    const contents = messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    }));
    if (system) {
      contents.unshift({ role: 'user', parts: [{ text: system }] });
      contents.splice(1, 0, { role: 'model', parts: [{ text: 'Entendido. Estoy listo para ayudar.' }] });
    }
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        generationConfig: { maxOutputTokens: 1000, temperature: 0.7 }
      })
    });
    if (!r.ok) throw new Error(`Gemini ${r.status}: ${await r.text()}`);
    const data = await r.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }

  async function callGroq(messages, system) {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${GROQ_KEY}`
      },
      body: JSON.stringify({
        model: 'llama-3.1-70b-versatile',
        messages: [
          { role: 'system', content: system || 'Eres un asistente de mesa de ayuda.' },
          ...messages
        ],
        max_tokens: 1000,
        temperature: 0.7
      })
    });
    if (!r.ok) throw new Error(`Groq ${r.status}: ${await r.text()}`);
    const data = await r.json();
    return data.choices?.[0]?.message?.content || '';
  }

  async function callOpenAI(messages, system) {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${OPENAI_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: system || 'Eres un asistente de mesa de ayuda.' },
          ...messages
        ],
        max_tokens: 1000,
        temperature: 0.7
      })
    });
    if (!r.ok) throw new Error(`OpenAI ${r.status}: ${await r.text()}`);
    const data = await r.json();
    return data.choices?.[0]?.message?.content || '';
  }

  // Función unificada que llama al proveedor activo
  async function callAI(messages, system) {
    if (PROVIDER === 'gemini') return callGeminiChat(messages, system);
    if (PROVIDER === 'groq')   return callGroq(messages, system);
    if (PROVIDER === 'openai') return callOpenAI(messages, system);
    throw new Error('Proveedor no soportado');
  }

  async function callAISimple(prompt, system) {
    if (PROVIDER === 'gemini') return callGemini(prompt, system);
    return callAI([{ role: 'user', content: prompt }], system);
  }

  // ══════════════════════════════════════════════════════════
  //  BÚSQUEDA EN JIRA
  // ══════════════════════════════════════════════════════════
  async function findSimilarTickets(query) {
    if (!JIRA_EMAIL || !JIRA_TOKEN) return [];
    try {
      const jiraAuth = Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');
      const H = {
        'Authorization': `Basic ${jiraAuth}`,
        'Accept':        'application/json',
        'Content-Type':  'application/json'
      };
      const jql = `project="${JIRA_PROJ}" AND summary~"${query.replace(/"/g,'').slice(0,40)}" AND status="Resuelto" ORDER BY created DESC`;
      const r = await fetch(`${JIRA_URL}/rest/api/3/search/jql`, {
        method: 'POST', headers: H,
        body: JSON.stringify({ jql, fields: ['summary','resolution','comment'], maxResults: 5 })
      });
      if (!r.ok) return [];
      const data = await r.json();
      return (data.issues || []).map(iss => {
        const f = iss.fields || {};
        const comments = f.comment?.comments || [];
        const lastComment = comments[comments.length-1]?.body?.content?.[0]?.content?.[0]?.text || '';
        return { key: iss.key, summary: f.summary||'', lastComment: lastComment.slice(0,200) };
      });
    } catch { return []; }
  }

  // ══════════════════════════════════════════════════════════
  //  SYSTEM PROMPT del agente
  // ══════════════════════════════════════════════════════════
  const SYSTEM = `Eres el Agente IA de Mesa de Ayuda de Efletexia. Eres un experto en soporte técnico.

APLICACIONES:
- Aplicacion T1: Sistema principal de gestión de transporte y logística
- Aplicacion T2: Sistema secundario de operaciones  
- Torre de Control: Monitoreo en tiempo real
- OPL: Gestión de pedidos y referencias
- Ruteador: Sistema de ruteo de transportistas

ÁREAS: Operaciones, Admin. & Finanzas, TI, Torre de Control, Recursos Humanos, Marketing, Proyectos

CASOS FRECUENTES Y SOLUCIONES:
1. Liberación de pedidos → OPL → Aprobaciones pendientes → Aprobar o rechazar manualmente
2. Referencias a eliminar → OPL → Gestión de referencias → Filtrar → Eliminar
3. Cambio de placa → Módulo transportistas → Editar vehículo → Actualizar placa
4. Diferencia de monto → Revisar prefactura vs tarifa configurada → Ajustar en administración
5. Acceso bloqueado → Verificar usuario → Restablecer contraseña → Revisar permisos
6. Duplicación de registros → Identificar duplicado → Consolidar o eliminar el erróneo
7. Falla de aplicación → Limpiar caché → Cerrar y abrir sesión → Verificar conexión

REGLAS:
- Responde siempre en español
- Sé conciso y práctico (máximo 250 palabras)
- Da pasos numerados cuando expliques una solución
- Si el caso requiere escalamiento dilo claramente
- Menciona el módulo exacto donde hacer los cambios`;

  // ══════════════════════════════════════════════════════════
  //  ACCIÓN: info — qué proveedor está activo
  // ══════════════════════════════════════════════════════════
  if (action === 'info') {
    return res.status(200).json({ provider: PROVIDER });
  }

  // ══════════════════════════════════════════════════════════
  //  ACCIÓN: chat
  // ══════════════════════════════════════════════════════════
  if (action === 'chat') {
    const { messages } = body;
    if (!messages?.length) return res.status(400).json({ error: 'Falta messages' });
    const userMsg = messages[messages.length-1]?.content || '';
    const similar = await findSimilarTickets(userMsg.slice(0,50));
    const extraCtx = similar.length
      ? `\n\nTickets similares resueltos en Jira:\n${similar.map(t=>`- ${t.key}: "${t.summary}"${t.lastComment?' → '+t.lastComment:''}`).join('\n')}`
      : '';
    try {
      const lastMessages = messages.slice(-8);
      lastMessages[lastMessages.length-1] = {
        ...lastMessages[lastMessages.length-1],
        content: lastMessages[lastMessages.length-1].content + extraCtx
      };
      const response = await callAI(lastMessages, SYSTEM);
      return res.status(200).json({ response, similar, provider: PROVIDER });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // ══════════════════════════════════════════════════════════
  //  ACCIÓN: suggestSolution
  // ══════════════════════════════════════════════════════════
  if (action === 'suggestSolution') {
    const { ticketKey, summary, area, requesttype, issuetype } = body;
    if (!summary) return res.status(400).json({ error: 'Falta summary' });
    const similar = await findSimilarTickets(summary.slice(0,60));
    const prompt = `Analiza este ticket y sugiere solución:

TICKET: ${ticketKey||'N/A'} | ÁREA: ${area||'N/A'} | TIPO: ${issuetype||requesttype||'N/A'}
DESCRIPCIÓN: ${summary}
${similar.length?`\nTICKETS SIMILARES RESUELTOS:\n${similar.map(t=>`- ${t.key}: "${t.summary}"${t.lastComment?' → '+t.lastComment:''}`).join('\n')}`:''}

Responde con:
1. DIAGNÓSTICO (1 oración)
2. SOLUCIÓN PASO A PASO (máx 5 pasos)
3. TIEMPO ESTIMADO
4. ESCALAR A: (si aplica)`;
    try {
      const solution = await callAISimple(prompt, SYSTEM);
      return res.status(200).json({ solution, similar, provider: PROVIDER });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // ══════════════════════════════════════════════════════════
  //  ACCIÓN: analyzeRecurrent
  // ══════════════════════════════════════════════════════════
  if (action === 'analyzeRecurrent') {
    const { recurrentCases } = body;
    if (!recurrentCases?.length) return res.status(400).json({ error: 'Falta recurrentCases' });
    const prompt = `Analiza estos casos recurrentes de Mesa de Ayuda de Efletexia:

${recurrentCases.slice(0,10).map(([n,c])=>`- "${n}": ${c} veces`).join('\n')}

Proporciona:
1. CAUSA RAÍZ COMÚN
2. TOP 3 ACCIONES INMEDIATAS para reducir tickets
3. SOLUCIONES PREVENTIVAS (cambios en procesos/sistemas)
4. QUÉ AUTOMATIZAR para eliminar estos tickets
5. REDUCCIÓN ESTIMADA si se implementan las mejoras (%)`;
    try {
      const analysis = await callAISimple(prompt, SYSTEM);
      return res.status(200).json({ analysis, provider: PROVIDER });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  return res.status(400).json({ error: `Acción desconocida: "${action}"` });
};
