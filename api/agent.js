// ═══════════════════════════════════════════════════════════
//  api/agent.js  —  Agente IA Mesa de Ayuda · Efletexia
//  Consulta Jira en tiempo real + IA para respuestas
//  Soporta: Groq (gratis) | Gemini (gratis) | OpenAI
// ═══════════════════════════════════════════════════════════
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const GROQ_KEY   = process.env.GROQ_API_KEY;
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  const PROVIDER   = GROQ_KEY ? 'groq' : GEMINI_KEY ? 'gemini' : OPENAI_KEY ? 'openai' : null;

  const JIRA_EMAIL = process.env.JIRA_EMAIL;
  const JIRA_TOKEN = process.env.JIRA_TOKEN;
  const JIRA_URL   = process.env.JIRA_URL || 'https://efletexia.atlassian.net';
  const JIRA_PROJ  = process.env.JIRA_PROJECT_KEY || 'TK';

  if (!PROVIDER) {
    return res.status(500).json({ error: 'No hay API Key configurada. Agrega GROQ_API_KEY en Vercel.' });
  }

  const body   = req.method === 'POST' ? (req.body || {}) : (req.query || {});
  const action = body.action;

  // ── Auth Jira ──────────────────────────────────────────
  const jiraAuth = Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');
  const JH = {
    'Authorization': `Basic ${jiraAuth}`,
    'Accept':        'application/json',
    'Content-Type':  'application/json'
  };

  // ══════════════════════════════════════════════════════
  //  JIRA: obtener ticket específico con TODOS sus datos
  // ══════════════════════════════════════════════════════
  async function getTicket(key) {
    try {
      const r = await fetch(`${JIRA_URL}/rest/api/3/issue/${key}?expand=renderedFields`, { headers: JH });
      if (!r.ok) return null;
      const d = await r.json();
      const f = d.fields || {};
      // Extraer comentarios
      const comments = (f.comment?.comments || []).map(c => ({
        author: c.author?.displayName || 'Desconocido',
        date:   (c.created || '').slice(0,10),
        text:   extractText(c.body)
      }));
      return {
        key:         d.key,
        summary:     f.summary || '',
        status:      f.status?.name || '',
        issuetype:   f.issuetype?.name || '',
        assignee:    f.assignee?.displayName || 'Sin asignar',
        reporter:    f.reporter?.displayName || '',
        created:     (f.created || '').slice(0,10),
        priority:    f.priority?.name || '',
        area:        f.customfield_10393?.value || '',
        apptype:     f.customfield_10360?.value || '',
        requesttype: f.customfield_10010?.requestType?.name || '',
        description: extractText(f.description),
        comments,
        resolution:  f.resolution?.name || '',
        resolutionDate: (f.resolutiondate || '').slice(0,10)
      };
    } catch { return null; }
  }

  // ══════════════════════════════════════════════════════
  //  JIRA: buscar tickets por JQL
  // ══════════════════════════════════════════════════════
  async function searchJira(jql, maxResults = 10) {
    try {
      const fields = ['summary','status','issuetype','assignee','reporter','created',
                      'priority','customfield_10393','customfield_10360','customfield_10010',
                      'description','comment','resolution'];
      const r = await fetch(`${JIRA_URL}/rest/api/3/search/jql`, {
        method: 'POST', headers: JH,
        body: JSON.stringify({ jql, fields, maxResults })
      });
      if (!r.ok) return [];
      const data = await r.json();
      return (data.issues || []).map(iss => {
        const f = iss.fields || {};
        const comments = (f.comment?.comments || []).map(c => ({
          author: c.author?.displayName || '',
          text:   extractText(c.body)
        }));
        return {
          key:         iss.key,
          summary:     f.summary || '',
          status:      f.status?.name || '',
          issuetype:   f.issuetype?.name || '',
          assignee:    f.assignee?.displayName || 'Sin asignar',
          reporter:    f.reporter?.displayName || '',
          created:     (f.created || '').slice(0,10),
          area:        f.customfield_10393?.value || '',
          apptype:     f.customfield_10360?.value || '',
          requesttype: f.customfield_10010?.requestType?.name || '',
          description: extractText(f.description),
          comments,
          resolution:  f.resolution?.name || ''
        };
      });
    } catch { return []; }
  }

  // Extraer texto plano del formato ADF de Jira
  function extractText(node) {
    if (!node) return '';
    if (typeof node === 'string') return node;
    if (node.type === 'text') return node.text || '';
    if (node.content) return node.content.map(extractText).join(' ');
    return '';
  }

  // ══════════════════════════════════════════════════════
  //  DETECTAR intención del usuario
  // ══════════════════════════════════════════════════════
  function detectIntent(msg) {
    const m = msg.toUpperCase();
    // Buscar clave de ticket TK-XXX
    const ticketMatch = msg.match(/TK-\d+/i);
    if (ticketMatch) return { type: 'ticket', key: ticketMatch[0].toUpperCase() };
    // Buscar número solo
    const numMatch = msg.match(/\b(\d{3,4})\b/);
    if (numMatch) return { type: 'ticket', key: `TK-${numMatch[1]}` };
    // Estado de tickets pendientes
    if (m.includes('PENDIENTE') || m.includes('ABIERTO') || m.includes('ACTIVO')) return { type: 'pending' };
    // Tickets escalados
    if (m.includes('ESCALAD')) return { type: 'escalated' };
    // Tickets de una persona
    const personMatch = msg.match(/tickets?\s+de\s+([A-Za-záéíóúñÁÉÍÓÚÑ\s]+)/i);
    if (personMatch) return { type: 'byPerson', name: personMatch[1].trim() };
    // Tickets recurrentes
    if (m.includes('RECURRENTE') || m.includes('REPETID')) return { type: 'recurrent' };
    // Búsqueda general
    if (m.includes('BUSCA') || m.includes('ENCONTRA') || m.includes('MOSTRA')) return { type: 'search', query: msg };
    return { type: 'general' };
  }

  // ══════════════════════════════════════════════════════
  //  CONSTRUIR CONTEXTO DE JIRA para el mensaje
  // ══════════════════════════════════════════════════════
  async function buildJiraContext(userMsg) {
    const intent = detectIntent(userMsg);
    let context = '';

    if (intent.type === 'ticket') {
      const ticket = await getTicket(intent.key);
      if (ticket) {
        context = `\n\n=== DATOS REALES DEL TICKET ${ticket.key} ===
Resumen: ${ticket.summary}
Estado: ${ticket.status}
Tipo: ${ticket.issuetype}
Área Usuario: ${ticket.area || 'No especificada'}
Tipo de Aplicación: ${ticket.apptype || 'No especificada'}
Tipo de Solicitud: ${ticket.requesttype || 'No especificada'}
Asignado a: ${ticket.assignee}
Informador: ${ticket.reporter}
Creado: ${ticket.created}
Prioridad: ${ticket.priority}
${ticket.description ? `Descripción: ${ticket.description.slice(0,400)}` : ''}
${ticket.resolution ? `Resolución: ${ticket.resolution} (${ticket.resolutionDate})` : ''}
${ticket.comments.length ? `\nComentarios (${ticket.comments.length}):\n${ticket.comments.slice(-3).map(c=>`- ${c.author} (${c.date}): ${c.text.slice(0,150)}`).join('\n')}` : 'Sin comentarios'}
=== FIN DATOS TICKET ===`;
      } else {
        context = `\n\nNota: El ticket ${intent.key} no fue encontrado en Jira o no existe.`;
      }
    }

    if (intent.type === 'pending') {
      const tickets = await searchJira(
        `project="${JIRA_PROJ}" AND status in ("Esperando por ayuda","Esperando por el cliente","Escalado") ORDER BY created ASC`,
        15
      );
      if (tickets.length) {
        context = `\n\n=== TICKETS PENDIENTES ACTUALES (${tickets.length}) ===\n` +
          tickets.map(t => `- ${t.key} | ${t.status} | ${t.area||'Sin área'} | ${t.reporter} → ${t.summary.slice(0,60)}`).join('\n') +
          '\n=== FIN ===';
      }
    }

    if (intent.type === 'escalated') {
      const tickets = await searchJira(
        `project="${JIRA_PROJ}" AND status="Escalado" ORDER BY created ASC`, 10
      );
      if (tickets.length) {
        context = `\n\n=== TICKETS ESCALADOS (${tickets.length}) ===\n` +
          tickets.map(t => `- ${t.key} | Asignado: ${t.assignee} | ${t.reporter} → ${t.summary.slice(0,60)}`).join('\n') +
          '\n=== FIN ===';
      }
    }

    if (intent.type === 'byPerson') {
      const tickets = await searchJira(
        `project="${JIRA_PROJ}" AND (assignee="${intent.name}" OR reporter~"${intent.name}") ORDER BY created DESC`,
        10
      );
      if (tickets.length) {
        context = `\n\n=== TICKETS DE ${intent.name.toUpperCase()} ===\n` +
          tickets.map(t => `- ${t.key} | ${t.status} | ${t.summary.slice(0,60)}`).join('\n') +
          '\n=== FIN ===';
      }
    }

    if (intent.type === 'search') {
      const tickets = await searchJira(
        `project="${JIRA_PROJ}" AND summary~"${intent.query.replace(/"/g,'').slice(0,40)}" ORDER BY created DESC`,
        8
      );
      if (tickets.length) {
        context = `\n\n=== TICKETS ENCONTRADOS ===\n` +
          tickets.map(t => `- ${t.key} | ${t.status} | ${t.summary.slice(0,70)}`).join('\n') +
          '\n=== FIN ===';
      }
    }

    return context;
  }

  // ══════════════════════════════════════════════════════
  //  LLAMADAS A IA
  // ══════════════════════════════════════════════════════
  async function callGroq(messages, system) {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${GROQ_KEY}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role:'system', content: system }, ...messages],
        max_tokens: 1000, temperature: 0.5
      })
    });
    if (!r.ok) throw new Error(`Groq ${r.status}: ${await r.text()}`);
    const d = await r.json();
    return d.choices?.[0]?.message?.content || '';
  }

  async function callGemini(messages, system) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`;
    const contents = [
      { role:'user',  parts:[{text: system}] },
      { role:'model', parts:[{text:'Entendido, estoy listo para ayudar.'}] },
      ...messages.map(m=>({ role: m.role==='assistant'?'model':'user', parts:[{text:m.content}] }))
    ];
    const r = await fetch(url, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ contents, generationConfig:{ maxOutputTokens:1000, temperature:0.5 } })
    });
    if (!r.ok) throw new Error(`Gemini ${r.status}: ${await r.text()}`);
    const d = await r.json();
    return d.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }

  async function callOpenAI(messages, system) {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':`Bearer ${OPENAI_KEY}`},
      body: JSON.stringify({
        model:'gpt-4o-mini',
        messages:[{role:'system',content:system},...messages],
        max_tokens:1000, temperature:0.5
      })
    });
    if (!r.ok) throw new Error(`OpenAI ${r.status}: ${await r.text()}`);
    const d = await r.json();
    return d.choices?.[0]?.message?.content || '';
  }

  async function callAI(messages, system) {
    if (PROVIDER==='groq')   return callGroq(messages, system);
    if (PROVIDER==='gemini') return callGemini(messages, system);
    if (PROVIDER==='openai') return callOpenAI(messages, system);
    throw new Error('Sin proveedor');
  }

  // ══════════════════════════════════════════════════════
  //  SYSTEM PROMPT
  // ══════════════════════════════════════════════════════
  const SYSTEM = `Eres el Agente IA de Mesa de Ayuda de Efletexia con ACCESO DIRECTO a Jira en tiempo real.

IMPORTANTE:
- Cuando te pregunten por un ticket (ej: TK-641), ya tienes sus datos reales en el contexto
- Responde SIEMPRE en base a los datos reales de Jira que se incluyen en el mensaje
- NUNCA digas que no tienes acceso a la información — sí la tienes
- Responde paso a paso, un paso a la vez, de forma clara y numerada
- Máximo 300 palabras por respuesta
- Usa los datos del ticket para dar contexto específico

APLICACIONES: Aplicacion T1 (logística), Aplicacion T2 (operaciones), Torre de Control, OPL (pedidos), Ruteador
ÁREAS: Operaciones, Admin. & Finanzas, TI, Torre de Control, Recursos Humanos, Marketing, Proyectos
ESTADOS: Esperando por ayuda, Esperando por el cliente, Escalado, Resuelto, Cancelado

SOLUCIONES COMUNES:
1. Liberar pedido → OPL → Aprobaciones → Aprobar/Rechazar
2. Eliminar referencia → OPL → Gestión de referencias → Filtrar → Eliminar  
3. Cambio de placa → Módulo transportistas → Editar vehículo → Actualizar
4. Diferencia de monto → Revisar prefactura vs tarifa → Ajustar en administración
5. Acceso bloqueado → Directorio → Restablecer contraseña → Verificar permisos
6. App lenta/caída → Limpiar caché → Cerrar sesión → Reiniciar → Verificar conexión`;

  // ══════════════════════════════════════════════════════
  //  ACCIÓN: info
  // ══════════════════════════════════════════════════════
  if (action === 'info') {
    return res.status(200).json({ provider: PROVIDER });
  }

  // ══════════════════════════════════════════════════════
  //  ACCIÓN: chat — con acceso real a Jira
  // ══════════════════════════════════════════════════════
  if (action === 'chat') {
    const { messages } = body;
    if (!messages?.length) return res.status(400).json({ error: 'Falta messages' });

    const userMsg   = messages[messages.length-1]?.content || '';
    const jiraCtx   = await buildJiraContext(userMsg);

    // Inyectar contexto de Jira en el último mensaje
    const augmented = [...messages];
    if (jiraCtx) {
      augmented[augmented.length-1] = {
        ...augmented[augmented.length-1],
        content: augmented[augmented.length-1].content + jiraCtx
      };
    }

    try {
      const response = await callAI(augmented.slice(-10), SYSTEM);
      return res.status(200).json({ response, provider: PROVIDER });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ══════════════════════════════════════════════════════
  //  ACCIÓN: suggestSolution
  // ══════════════════════════════════════════════════════
  if (action === 'suggestSolution') {
    const { ticketKey, summary, area, requesttype, issuetype } = body;
    if (!summary) return res.status(400).json({ error: 'Falta summary' });

    // Obtener datos reales del ticket si hay clave
    let ticketData = '';
    if (ticketKey) {
      const t = await getTicket(ticketKey);
      if (t) {
        ticketData = `\nDATOS REALES DEL TICKET:\nEstado: ${t.status}\nDescripción: ${t.description?.slice(0,300)}\nComentarios: ${t.comments.slice(-2).map(c=>`${c.author}: ${c.text.slice(0,100)}`).join(' | ')}`;
      }
    }

    // Buscar tickets similares resueltos
    const similar = await searchJira(
      `project="${JIRA_PROJ}" AND summary~"${summary.replace(/"/g,'').slice(0,40)}" AND status="Resuelto" ORDER BY created DESC`,
      5
    );

    const prompt = `Ticket ${ticketKey||'N/A'} — ${summary}
Área: ${area||'N/A'} | Tipo: ${issuetype||requesttype||'N/A'}
${ticketData}
${similar.length?`\nTICKETS SIMILARES RESUELTOS:\n${similar.map(t=>`- ${t.key}: ${t.summary} → ${t.resolution||'Resuelto'} | ${t.comments[t.comments.length-1]?.text?.slice(0,100)||''}`).join('\n')}`:''}

Responde con pasos numerados:
1. DIAGNÓSTICO (1 oración)
2. PASO 1:
3. PASO 2:
4. PASO 3: (si aplica)
5. TIEMPO ESTIMADO:
6. ESCALAR A: (solo si es necesario)`;

    try {
      const solution = await callAI([{role:'user',content:prompt}], SYSTEM);
      return res.status(200).json({ solution, similar, provider: PROVIDER });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ══════════════════════════════════════════════════════
  //  ACCIÓN: analyzeRecurrent
  // ══════════════════════════════════════════════════════
  if (action === 'analyzeRecurrent') {
    const { recurrentCases } = body;
    if (!recurrentCases?.length) return res.status(400).json({ error: 'Falta recurrentCases' });

    const prompt = `Casos recurrentes Mesa de Ayuda Efletexia:\n${recurrentCases.slice(0,10).map(([n,c])=>`- "${n}": ${c} veces`).join('\n')}

Responde con pasos numerados:
1. CAUSA RAÍZ COMÚN:
2. ACCIÓN INMEDIATA 1:
3. ACCIÓN INMEDIATA 2:
4. ACCIÓN INMEDIATA 3:
5. SOLUCIÓN PREVENTIVA:
6. QUÉ AUTOMATIZAR:
7. REDUCCIÓN ESTIMADA DE TICKETS: X%`;

    try {
      const analysis = await callAI([{role:'user',content:prompt}], SYSTEM);
      return res.status(200).json({ analysis, provider: PROVIDER });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(400).json({ error: `Acción desconocida: "${action}"` });
};
