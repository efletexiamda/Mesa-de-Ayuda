// ═══════════════════════════════════════════════════════════
//  public/app.js  —  Dashboard Mesa de Ayuda · Efletexia
//  Integración directa con Jira REST API via Token
// ═══════════════════════════════════════════════════════════

const API      = '/api/jira';
const JIRA_URL = 'https://efletexia.atlassian.net';

/* ── Estado global ──────────────────────────────────────── */
let D       = {};
let MONTHS  = [];
let PENDING = [];
let cur     = 0;
let fakeDur = 75;
const CH    = {};

/* ── Paletas ────────────────────────────────────────────── */
const G  = '#16a34a', R = '#dc2626';
const PC = ['#22c55e','#f59e0b','#3b82f6','#ef4444','#8b5cf6','#64748b','#ec4899','#14b8a6'];
const AC = ['#3b82f6','#f59e0b','#22c55e','#8b5cf6','#ec4899','#64748b','#14b8a6'];
const EK = ['Resuelto','Cancelado','Esp. ayuda','Esp. cliente','Escalado'];
const EC = ['#22c55e','#f59e0b','#3b82f6','#8b5cf6','#ef4444'];

/* ══════════════════════════════════════════════════════════
   UTILIDADES FECHA
══════════════════════════════════════════════════════════ */
const MN = ['Enero','Febrero','Marzo','Abril','Mayo','Junio',
            'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
const MS = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];

const _id  = id => document.getElementById(id);
const mkey = (y,m) => `${y}-${String(m).padStart(2,'0')}`;
const mlbl = (y,m) => `${MN[m-1]} ${y}`;
const msht = (y,m) => `${MS[m-1]} ${String(y).slice(2)}`;

function fmtDate(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleDateString('es-PE',{day:'2-digit',month:'2-digit',year:'numeric'}); }
  catch { return iso; }
}

function defaultRange() {
  const now = new Date();
  return Array.from({length:3}, (_,i) => {
    const d = new Date(now.getFullYear(), now.getMonth()-(2-i), 1);
    return { year: d.getFullYear(), month: d.getMonth()+1 };
  });
}

function rangeFromFilter() {
  const fv = _id('dFrom')?.value, tv = _id('dTo')?.value;
  if (!fv || !tv) return defaultRange();
  const [fy,fm] = fv.split('-').map(Number);
  const [ty,tm] = tv.split('-').map(Number);
  const arr = []; let y=fy, m=fm;
  while (y<ty || (y===ty && m<=tm)) { arr.push({year:y,month:m}); if(++m>12){m=1;y++;} }
  return arr.slice(0,6);
}

window.applyFilter = () => loadFromJira();

/* ══════════════════════════════════════════════════════════
   API BACKEND
══════════════════════════════════════════════════════════ */
async function api(action, extra={}) {
  const r = await fetch(API, {
    method:  'POST',
    headers: {'Content-Type':'application/json'},
    body:    JSON.stringify({action,...extra})
  });
  if (!r.ok) {
    const e = await r.json().catch(()=>({error:r.statusText}));
    throw new Error(e.error || `HTTP ${r.status}`);
  }
  return r.json();
}

/* ══════════════════════════════════════════════════════════
   PROCESAMIENTO DE TICKETS
══════════════════════════════════════════════════════════ */
function isInc(iss) {
  const t = (iss.issuetype||'').toLowerCase();
  return t.includes('incident') || t.includes('incidente');
}

function mapStatus(s) {
  // Estados reales de Jira Mesa de Ayuda Efletexia
  if (!s) return 'Esp. ayuda';
  const v = s.toUpperCase();
  if (v.includes('RESUELTO') || v.includes('RESOLVED') || v.includes('DONE') || v.includes('CLOSED')) return 'Resuelto';
  if (v.includes('CANCELADO') || v.includes('CANCELLED') || v.includes('CANCELED')) return 'Cancelado';
  if (v.includes('ESCALADO')  || v.includes('ESCALATED')) return 'Escalado';
  if (v.includes('ESPERANDO POR EL CLIENTE') || v.includes('WAITING FOR CUSTOMER')) return 'Esp. cliente';
  return 'Esp. ayuda'; // ESPERANDO POR AYUDA y cualquier otro
}

// Áreas usuarias reales de Jira Mesa de Ayuda Efletexia
const AREAS_JIRA = ['Operaciones','Admin. & Finanzas','TI','Torre de Control',
                    'Recursos Humanos','Marketing','Proyectos'];

function mapArea(rt) {
  if (!rt) return 'Sin área';
  const v = rt.toLowerCase();
  if (v.includes('operacion'))                          return 'Operaciones';
  if (v.includes('admin') || v.includes('finanza'))     return 'Admin. & Finanzas';
  if (v==='ti'||v.includes(' ti ')||v.startsWith('ti ')||v.endsWith(' ti')) return 'TI';
  if (v.includes('torre') || v.includes('control'))     return 'Torre de Control';
  if (v.includes('recurso')||v.includes('humano')||v.includes('rrhh')) return 'Recursos Humanos';
  if (v.includes('market'))                             return 'Marketing';
  if (v.includes('proyecto'))                           return 'Proyectos';
  return rt;
}

function extractApp(iss) {
  if (iss.components?.length) return iss.components[0];
  for (const l of (iss.labels||[])) {
    const lv = l.toLowerCase();
    if (lv.includes('t1')) return 'Aplicacion T1';
    if (lv.includes('t2')) return 'Aplicacion T2';
    if (lv.includes('torre')||lv.includes('control')) return 'Torre de Control';
  }
  const s = (iss.summary||'').toLowerCase();
  if (s.includes('aplicacion t1')||s.includes('app t1')) return 'Aplicacion T1';
  if (s.includes('aplicacion t2')||s.includes('app t2')) return 'Aplicacion T2';
  if (s.includes('torre')||s.includes('control'))         return 'Torre de Control';
  return 'Sin app';
}

function processIssues(issues=[]) {
  const d = {sol:0,inc:0,
    estado:{sol:{},inc:{}}, tipo:{sol:{},inc:{}},
    area:{sol:{},inc:{}},   apps:{sol:{},inc:{}},
    esp:{sol:{},inc:{}},    inf:{sol:{},inc:{}},
    part:{}, rec:[]};
  const sc = {};

  for (const iss of issues) {
    const t = isInc(iss) ? 'inc' : 'sol';
    t==='inc' ? d.inc++ : d.sol++;

    const st   = mapStatus(iss.status);
    const tipo = (iss.issuetype||'').toLowerCase().includes('proyecto') ? 'Proyecto'
                 : t==='inc' ? 'Incidente de [System]' : 'Solicitud de servicio';
    const area = iss.area || 'Sin área';  // Area Usuario: Operaciones, TI, Admin. & Finanzas, etc.
    const app  = iss.apptype || extractApp(iss);  // Tipo de Aplicación
    const esp  = iss.assignee || 'Sin asignar';
    const inf  = iss.reporter || 'Desconocido';

    d.estado[t][st]  = (d.estado[t][st]  ||0)+1;
    d.tipo[t][tipo]  = (d.tipo[t][tipo]  ||0)+1;
    d.area[t][area]  = (d.area[t][area]  ||0)+1;
    d.apps[t][app]   = (d.apps[t][app]   ||0)+1;
    d.esp[t][esp]    = (d.esp[t][esp]    ||0)+1;
    d.inf[t][inf]    = (d.inf[t][inf]    ||0)+1;
    // Participantes de la solicitud
    for (const p of (iss.participants||[])) {
      d.part[p] = (d.part[p]||0)+1;
    }

    if (iss.summary) {
      const k = iss.summary.trim().toUpperCase();
      sc[k] = (sc[k]||0)+1;
    }
  }

  d.rec = Object.entries(sc).filter(([,v])=>v>1).sort((a,b)=>b[1]-a[1]).slice(0,10);
  return d;
}

/* ══════════════════════════════════════════════════════════
   CARGA PRINCIPAL DESDE JIRA
══════════════════════════════════════════════════════════ */
async function loadFromJira() {
  showLoad(true); hideErr(); setBtn(false);
  try {
    /* 1 · Verificar conexión */
    step(1);
    const info = await api('getProjectInfo');

    /* 2 · Tickets por mes */
    step(2);
    MONTHS = rangeFromFilter();
    D = {};
    for (const {year,month} of MONTHS) {
      const k = mkey(year,month);
      const r = await api('getMonthTickets', {year,month});
      D[k] = processIssues(r.issues||[]);
    }

    /* Pendientes */
    const pr = await api('getPendingTickets');
    PENDING = (pr.pending||[]).map(iss=>({
      key:  iss.key,
      cr:   fmtDate(iss.created),
      tipo: isInc(iss)?'inc':'sol',
      est:  mapStatus(iss.status),
      res:  iss.summary||'',
      area: iss.area || iss.requesttype||'—',
      inf:  iss.reporter||'—',
      asig: iss.assignee||'Sin asignar',
      part: (iss.participants||[]).join(', ') || (iss.components||[])[0] || '—'
    }));

    /* 3 · Render */
    step(3);
    updateTabs(); cur=0; tabClass();
    const ps = MONTHS.map(({year,month})=>mlbl(year,month)).join(' – ');
    _id('hdrPeriod').textContent = `📅 ${ps}`;
    _id('hdrDate').textContent   =
      `Actualizado: ${new Date().toLocaleDateString('es-PE',{day:'2-digit',month:'long',year:'numeric'})}`;

    /* 4 · Resumen (local, sin IA) */
    step(4);
    buildLocalSummary();

    renderAll(); renderTable();
    _id('footer').textContent =
      `Fuente: Jira Service Management · ${info.url||JIRA_URL} · `+
      `Proyecto ${info.name||'Mesa de Ayuda'} · `+
      `Datos extraídos: ${new Date().toLocaleDateString('es-PE')}`;

  } catch(err) {
    console.error(err);
    showErr(err.message||'No se pudo conectar con Jira.');
    demoData();
  } finally {
    showLoad(false); setBtn(true);
  }
}

/* ── Resumen local sin IA ────────────────────────────────── */
function buildLocalSummary() {
  const all = merged();
  const tot = all.sol+all.inc;
  const rS  = all.estado.sol['Resuelto']||0, rI=all.estado.inc['Resuelto']||0;
  const pend= (all.estado.sol['Escalado']||0)+(all.estado.inc['Escalado']||0)+
              (all.estado.sol['Esp. ayuda']||0)+(all.estado.inc['Esp. ayuda']||0);
  const tasa= tot?((rS+rI)/tot*100).toFixed(0):0;
  const ps  = MONTHS.map(({year,month})=>mlbl(year,month)).join(', ');
  const topApp = topK(all.apps), topEsp=topK(all.esp), topUser=topK(all.inf);

  window._aiScript =
    `Resumen ejecutivo de la Mesa de Ayuda de Efletexia para el período ${ps}. `+
    `Se registraron ${tot} tickets en total, de los cuales ${all.sol} corresponden a solicitudes de servicio `+
    `y ${all.inc} a incidentes. Se resolvieron ${rS+rI} tickets con una tasa global del ${tasa} por ciento. `+
    `Actualmente hay ${pend} tickets pendientes que requieren atención inmediata. `+
    `La aplicación con mayor número de tickets es ${topApp}. `+
    `El especialista con mayor carga de trabajo es ${topEsp}. `+
    `El usuario que más reporta tickets es ${topUser}. `+
    `Se recomienda priorizar la atención de los tickets escalados y revisar la asignación de tickets sin especialista designado.`;

  fakeDur = Math.ceil(window._aiScript.split(' ').length/2.5);
  _id('aud-desc').textContent = `Síntesis narrada · ${ps} · Haz clic en ▶ para escuchar`;
  _id('tTot').textContent     = fmt(fakeDur);
}

function topK(obj) {
  const m={};
  for(const t of['sol','inc'])
    for(const[k,v]of Object.entries(obj[t]||{}))
      if(k!=='Sin asignar'&&k!=='Desconocido') m[k]=(m[k]||0)+v;
  return Object.entries(m).sort((a,b)=>b[1]-a[1])[0]?.[0]||'N/D';
}

/* ══════════════════════════════════════════════════════════
   DATOS DEMO (fallback)
══════════════════════════════════════════════════════════ */
function demoData() {
  const rng=defaultRange(); MONTHS=rng; D={};
  const B=[
    {sol:50,inc:50,estado:{sol:{Resuelto:50,Cancelado:0,Escalado:0,'Esp. ayuda':0},inc:{Resuelto:48,Cancelado:0,Escalado:0,'Esp. ayuda':2}},tipo:{sol:{'Solicitud de servicio':50},inc:{'Incidente de [System]':47,'Proyecto':3}},area:{sol:{Operaciones:20,'Torre de Control':8,TI:5,'Admin. & Finanzas':4,'Recursos Humanos':2,Marketing:1},inc:{Operaciones:25,'Torre de Control':12,TI:8,'Admin. & Finanzas':3,'Recursos Humanos':2}},apps:{sol:{'Aplicacion T1':27,'Aplicacion T2':2,'Torre de Control':3,'Sin app':18},inc:{'Aplicacion T1':26,'Aplicacion T2':7,'Torre de Control':6,'Sin app':11}},esp:{sol:{'Soporte Efletexia':12,'Andres Medina':10,'Sin asignar':28},inc:{'Andres Medina':15,'Soporte Efletexia':3,'Sin asignar':32}},rec:[['Liberacion de Pedidos',6],['Cambios de placa - Aje Col',3],['REFERENCIAS A ELIMINAR DEL OPL',3],['REFERENCIA 961201 NO APARECE EN OPL',2],['DIFERENCIA DE MONTO OPL ORIENTE',2]],inf:{sol:{'Eric Cacho':20,'Soporte Efletexia':13,'Andres Medina':4,'Daniela':3,'Otros':10},inc:{'Eric Cacho':4,'Andres Medina':15,'Soporte Efletexia':3,'Cesar C.':9,'Otros':19}}},
    {sol:80,inc:20,estado:{sol:{Resuelto:79,Cancelado:1,Escalado:0,'Esp. ayuda':0},inc:{Resuelto:20,Cancelado:0,Escalado:0,'Esp. ayuda':0}},tipo:{sol:{'Solicitud de servicio':80},inc:{'Incidente de [System]':20}},area:{sol:{Operaciones:35,'Torre de Control':15,TI:12,'Admin. & Finanzas':10,'Recursos Humanos':5,Marketing:3},inc:{Operaciones:10,'Torre de Control':5,TI:4,'Admin. & Finanzas':1}},apps:{sol:{'Aplicacion T1':54,'Aplicacion T2':7,'Torre de Control':1,'Sin app':18},inc:{'Aplicacion T1':10,'Aplicacion T2':5,'Torre de Control':4,'Otros':1}},esp:{sol:{'Andres Medina':9,'Soporte Efletexia':8,'Sin asignar':63},inc:{'Andres Medina':7,'Soporte Efletexia':1,'Sin asignar':12}},rec:[['Liberacion de Pedidos',7],['REFERENCIAS A ELIMINAR DEL OPL',3],['Liberación viajes',2]],inf:{sol:{'Eric Cacho':24,'Soporte Efletexia':7,'Andres Medina':7,'Daniela':7,'Otros':35},inc:{'Eric Cacho':3,'Andres Medina':6,'Cesar Castañeda':2,'Otros':9}}},
    {sol:69,inc:31,estado:{sol:{Resuelto:51,Cancelado:12,Escalado:0,'Esp. ayuda':6},inc:{Resuelto:28,Cancelado:1,Escalado:1,'Esp. ayuda':1}},tipo:{sol:{'Solicitud de servicio':69},inc:{'Incidente de [System]':31}},area:{sol:{Operaciones:30,'Torre de Control':18,TI:10,'Admin. & Finanzas':8,Marketing:2,'Recursos Humanos':1},inc:{Operaciones:15,'Torre de Control':8,TI:5,'Admin. & Finanzas':3}},apps:{sol:{'Aplicacion T1':54,'Aplicacion T2':1,'Torre de Control':2,'Sin app':12},inc:{'Aplicacion T1':25,'Aplicacion T2':2,'Torre de Control':1,'Sin app':3}},esp:{sol:{'Soporte Efletexia':8,'Andres Medina':2,'Sin asignar':59},inc:{'Andres Medina':4,'Soporte Efletexia':3,'Sin asignar':24}},rec:[['REVISION DE APROBACIONES',3],['Aprobación por Incremento en Tarifa',2],['REFERENCIAS A ELIMINAR DEL OPL',2]],inf:{sol:{'Eric Cacho':25,'Cesar C.':14,'Adm2 CRISAR':7,'Daniela':5,'Otros':18},inc:{'Cesar C.':15,'Verónica Méndez':6,'Eric Cacho':4,'Otros':6}}}
  ];
  rng.forEach(({year,month},i)=>{ D[mkey(year,month)]=B[i%3]; });
  PENDING=[
    {key:'TK-648',cr:'16/06/2026',tipo:'inc',est:'Esp. ayuda',res:'Error en mis cargas Ambiente : Transportista',area:'Operaciones',inf:'Cesar C.',asig:'Sin asignar',part:'Eric Cacho'},
    {key:'TK-647',cr:'16/06/2026',tipo:'inc',est:'Esp. ayuda',res:'Datos para confirmar en nueva TC',area:'Operaciones',inf:'Cesar C.',asig:'Sin asignar',part:'—'},
    {key:'TK-646',cr:'16/06/2026',tipo:'inc',est:'Esp. ayuda',res:'Regresar referencia a prefactura para rechazo',area:'Operaciones',inf:'Verónica Méndez',asig:'Sin asignar',part:'—'},
    {key:'TK-542',cr:'14/05/2026',tipo:'sol',est:'Esp. ayuda',res:'Agregar Boton descargable Descarga QR Cliente',area:'TI',inf:'Cesar C.',asig:'Sin asignar',part:'Eric Cacho'},
    {key:'TK-507',cr:'10/05/2026',tipo:'inc',est:'Escalado',res:'Duplicación de clientes en el ruteador - URGENTE',area:'Operaciones',inf:'Soporte Efletexia',asig:'Andres Medina',part:'Eric Cacho, Cesar C.'},
    {key:'TK-411',cr:'22/04/2026',tipo:'sol',est:'Escalado',res:'ACTIVACION VISIT TYPE AJE COLOMBIA',area:'Admin. & Finanzas',inf:'Andres Medina',asig:'Andres Medina',part:'—'}
  ];
  updateTabs(); cur=0; tabClass();
  const ps=rng.map(({year,month})=>mlbl(year,month)).join(' – ');
  _id('hdrPeriod').textContent=`📅 ${ps} (demo)`;
  _id('hdrDate').textContent='Datos de demostración — configura variables en Vercel';
  window._aiScript='Datos de demostración. Configure las variables JIRA_EMAIL y JIRA_TOKEN en Vercel para conectar con datos reales.';
  fakeDur=15; _id('tTot').textContent=fmt(fakeDur);
  _id('aud-desc').textContent='Síntesis narrada (datos demo) · Haz clic en ▶ para escuchar';
  renderAll(); renderTable();
}

/* ══════════════════════════════════════════════════════════
   UI HELPERS
══════════════════════════════════════════════════════════ */
function showLoad(v)  { _id('lov').classList.toggle('hidden',!v); }
function showErr(msg) { _id('errMsg').textContent=msg; _id('errBanner').classList.add('on'); }
function hideErr()    { _id('errBanner').classList.remove('on'); }
function setBtn(e)    { const b=_id('btnRef'); if(b) b.disabled=!e; }

function step(n) {
  for(let i=1;i<=4;i++){
    const el=_id(`s${i}`); if(!el) continue;
    const ic=el.querySelector('.lstep-i');
    el.classList.remove('done','act');
    if(i<n){ el.classList.add('done'); ic.textContent='✓'; }
    else if(i===n){ el.classList.add('act'); ic.textContent='●'; }
    else ic.textContent='○';
  }
}

function updateTabs() {
  Object.keys(D).forEach((k,i)=>{
    const[y,m]=k.split('-').map(Number);
    const el=_id(`tab${i}`); if(el){ el.textContent=mlbl(y,m); el.style.display=''; }
  });
  for(let i=Object.keys(D).length;i<3;i++){
    const el=_id(`tab${i}`); if(el) el.style.display='none';
  }
  const t3=_id('tab3'); if(t3){ t3.textContent='▦ Total Período'; t3.style.display=''; }
}
function tabClass() { document.querySelectorAll('.tab').forEach((el,i)=>el.classList.toggle('on',i===cur)); }

/* ── Datos activos ──────────────────────────────────────── */
function getD() { const ks=Object.keys(D); return cur<ks.length?D[ks[cur]]:merged(); }
function merged() {
  const ks=Object.keys(D);
  const m={sol:0,inc:0,estado:{sol:{},inc:{}},tipo:{sol:{},inc:{}},
           area:{sol:{},inc:{}},apps:{sol:{},inc:{}},esp:{sol:{},inc:{}},
           inf:{sol:{},inc:{}},part:{},rec:[]};
  for(const k of ks){
    const d=D[k]; m.sol+=d.sol; m.inc+=d.inc;
    for(const t of['sol','inc'])
      for(const c of['estado','tipo','area','apps','esp','inf'])
        for(const[kk,v]of Object.entries(d[c][t]||{}))
          m[c][t][kk]=(m[c][t][kk]||0)+v;
    for(const[kk,v]of Object.entries(d.part||{}))
      m.part[kk]=(m.part[kk]||0)+v;
    for(const[kk,v]of(d.rec||[])){
      const idx=m.rec.findIndex(([x])=>x===kk);
      idx>=0?m.rec[idx][1]+=v:m.rec.push([kk,v]);
    }
  }
  m.rec.sort((a,b)=>b[1]-a[1]); return m;
}
function curLabel() {
  const ks=Object.keys(D);
  if(cur<ks.length){ const[y,mn]=ks[cur].split('-').map(Number); return mlbl(y,mn); }
  return 'Período Total';
}

/* ══════════════════════════════════════════════════════════
   RENDER
══════════════════════════════════════════════════════════ */
function renderAll() {
  const d=getD(), L=curLabel();
  ['b_es','b_ei','b_sp','b_sc','b_area','b_areap','b_app','b_appp','b_esp','b_espp','b_rec','b_usr','b_usrp','b_part','b_partp']
    .forEach(id=>{ const el=_id(id); if(el) el.textContent=L; });
  renderKPIs(d); renderCharts(d);
}

function renderKPIs(d) {
  const tot=d.sol+d.inc;
  const pS=tot?((d.sol/tot)*100).toFixed(1):0, pI=tot?((d.inc/tot)*100).toFixed(1):0;
  const rS=d.estado.sol['Resuelto']||0, rI=d.estado.inc['Resuelto']||0;
  const pend=(d.estado.sol['Escalado']||0)+(d.estado.inc['Escalado']||0)+
             (d.estado.sol['Esp. ayuda']||0)+(d.estado.inc['Esp. ayuda']||0);
  const tasa=tot?((rS+rI)/tot*100).toFixed(1):0;
  const L=curLabel();
  _id('kpis').innerHTML=`
    <div class="kpi b"><div class="kpi-ico">📋</div><div class="kpi-lbl">Total Tickets</div><div class="kpi-val">${tot}</div><div class="kpi-foot">${L}</div></div>
    <div class="kpi g"><div class="kpi-ico">🟢</div><div class="kpi-lbl">Solicitudes Servicio</div><div class="kpi-val">${d.sol}</div><div class="kpi-foot"><span class="pill">${pS}%</span> del total</div></div>
    <div class="kpi r"><div class="kpi-ico">🔴</div><div class="kpi-lbl">Incidentes</div><div class="kpi-val">${d.inc}</div><div class="kpi-foot"><span class="pill">${pI}%</span> del total</div></div>
    <div class="kpi g"><div class="kpi-ico">✅</div><div class="kpi-lbl">Resueltos Sol.</div><div class="kpi-val">${rS}</div><div class="kpi-foot"><span class="pill">${d.sol?((rS/d.sol)*100).toFixed(0):0}%</span> resolución</div></div>
    <div class="kpi r"><div class="kpi-ico">✅</div><div class="kpi-lbl">Resueltos Inc.</div><div class="kpi-val">${rI}</div><div class="kpi-foot"><span class="pill">${d.inc?((rI/d.inc)*100).toFixed(0):0}%</span> resolución</div></div>
    <div class="kpi y"><div class="kpi-ico">⏳</div><div class="kpi-lbl">Pendientes</div><div class="kpi-val">${pend}</div><div class="kpi-foot">requieren atención</div></div>
    <div class="kpi b"><div class="kpi-ico">📈</div><div class="kpi-lbl">Tasa Resolución</div><div class="kpi-val">${tasa}%</div><div class="kpi-foot">sobre total período</div></div>`;
  _id('as1').textContent=tot; _id('as2').textContent=d.sol; _id('as3').textContent=d.inc;
}

/* CHARTS */
function kill(id) { if(CH[id]){ CH[id].destroy(); delete CH[id]; } }

function pie(id,labels,data,colors) {
  kill(id);
  const ctx=_id(id)?.getContext('2d'); if(!ctx) return;
  CH[id]=new Chart(ctx,{type:'doughnut',data:{labels,datasets:[{data,backgroundColor:colors,borderWidth:2,borderColor:'#fff',hoverOffset:4}]},options:{responsive:true,cutout:'58%',plugins:{legend:{position:'bottom',labels:{font:{size:9,weight:'700'},padding:7,usePointStyle:true,pointStyle:'circle',boxWidth:8}},tooltip:{callbacks:{label:c=>{const t=c.dataset.data.reduce((a,b)=>a+b,0);return ` ${c.label}: ${c.raw} (${t?((c.raw/t)*100).toFixed(1):0}%)`;}}}}}});
}
function gbar(id,labels,s,inc,h=false) {
  kill(id);
  const ctx=_id(id)?.getContext('2d'); if(!ctx) return;
  CH[id]=new Chart(ctx,{type:'bar',data:{labels,datasets:[{label:'Solicitud',data:s,backgroundColor:G,borderRadius:4,borderSkipped:false},{label:'Incidente',data:inc,backgroundColor:R,borderRadius:4,borderSkipped:false}]},options:{indexAxis:h?'y':'x',responsive:true,plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>` ${c.dataset.label}: ${c.raw}`}}},scales:{x:h?{grid:{color:'#f1f5f9'},ticks:{font:{size:9},precision:0},beginAtZero:true}:{grid:{display:false},ticks:{font:{size:9},maxRotation:28}},y:h?{grid:{display:false},ticks:{font:{size:9}}}:{grid:{color:'#f1f5f9'},ticks:{font:{size:9},precision:0},beginAtZero:true}}}});
}
function sBar(id,labels,data,color,h=false) {
  kill(id);
  const ctx=_id(id)?.getContext('2d'); if(!ctx) return;
  CH[id]=new Chart(ctx,{type:'bar',data:{labels,datasets:[{label:'Ocurrencias',data,backgroundColor:color,borderRadius:4,borderSkipped:false}]},options:{indexAxis:h?'y':'x',responsive:true,plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>` Ocurrencias: ${c.raw}`}}},scales:{x:h?{grid:{color:'#f1f5f9'},ticks:{font:{size:9},precision:0},beginAtZero:true}:{grid:{display:false},ticks:{font:{size:9}}},y:h?{grid:{display:false},ticks:{font:{size:9}}}:{grid:{color:'#f1f5f9'},ticks:{font:{size:9},precision:0},beginAtZero:true}}}});
}

function renderCharts(d) {
  pie('cEstSol',EK,EK.map(k=>d.estado.sol[k]||0),EC);
  pie('cEstInc',EK,EK.map(k=>d.estado.inc[k]||0),EC);
  kill('cEvol');
  const ks=Object.keys(D);
  const ce=_id('cEvol')?.getContext('2d');
  if(ce) CH['cEvol']=new Chart(ce,{type:'bar',data:{labels:ks.map(k=>{const[y,m]=k.split('-').map(Number);return msht(y,m);}),datasets:[{label:'Solicitud',data:ks.map(k=>D[k].sol),backgroundColor:G,borderRadius:4,borderSkipped:false},{label:'Incidente',data:ks.map(k=>D[k].inc),backgroundColor:R,borderRadius:4,borderSkipped:false}]},options:{responsive:true,plugins:{legend:{display:false}},scales:{x:{grid:{display:false},ticks:{font:{size:10}}},y:{grid:{color:'#f1f5f9'},ticks:{font:{size:9},precision:0},beginAtZero:true}}}});
  const tA=[...new Set([...Object.keys(d.tipo.sol),...Object.keys(d.tipo.inc)])];
  pie('cTipoPie',tA,tA.map(k=>(d.tipo.sol[k]||0)+(d.tipo.inc[k]||0)),[G,R,'#8b5cf6']);
  gbar('cTipoCol',tA,tA.map(k=>d.tipo.sol[k]||0),tA.map(k=>d.tipo.inc[k]||0));
  const aA=[...new Set([...Object.keys(d.area.sol),...Object.keys(d.area.inc)])];
  gbar('cArea',aA,aA.map(k=>d.area.sol[k]||0),aA.map(k=>d.area.inc[k]||0),true);
  const aT={}; aA.forEach(k=>aT[k]=(d.area.sol[k]||0)+(d.area.inc[k]||0));
  pie('cAreaPie',aA,Object.values(aT),AC);
  const apA=[...new Set([...Object.keys(d.apps.sol),...Object.keys(d.apps.inc)])];
  gbar('cAppBar',apA,apA.map(k=>d.apps.sol[k]||0),apA.map(k=>d.apps.inc[k]||0),true);
  const apT={}; apA.forEach(k=>apT[k]=(d.apps.sol[k]||0)+(d.apps.inc[k]||0));
  pie('cAppPie',apA,Object.values(apT),['#3b82f6','#8b5cf6','#f59e0b','#64748b','#ec4899']);
  // Especialista: excluir "Sin asignar" del gráfico, mostrarlo solo en KPI
  const eAll=[...new Set([...Object.keys(d.esp.sol),...Object.keys(d.esp.inc)])];
  const eA = eAll.filter(k => k !== 'Sin asignar' && k !== 'Unassigned' && k !== '');
  const sinAsignar = (d.esp.sol['Sin asignar']||0) + (d.esp.inc['Sin asignar']||0);
  // Actualizar badge con info de sin asignar
  const espBadge = document.getElementById('b_esp');
  if (espBadge) espBadge.textContent = `${curLabel()} · Sin asignar: ${sinAsignar}`;
  gbar('cEspCol',eA,eA.map(k=>d.esp.sol[k]||0),eA.map(k=>d.esp.inc[k]||0));
  const eT={}; eA.forEach(k=>eT[k]=(d.esp.sol[k]||0)+(d.esp.inc[k]||0));
  pie('cEspPie',eA,Object.values(eT),['#3b82f6','#22c55e','#f59e0b','#8b5cf6','#ec4899','#64748b']);
  const rec=(Array.isArray(d.rec)?d.rec:Object.entries(d.rec)).slice(0,8);
  sBar('cRecBar',rec.map(([k])=>k.length>32?k.slice(0,30)+'…':k),rec.map(([,v])=>v),'#6366f1',true);
  const iA={}; [...Object.keys(d.inf.sol),...Object.keys(d.inf.inc)].forEach(k=>iA[k]=(d.inf.sol[k]||0)+(d.inf.inc[k]||0));
  const iTop=Object.entries(iA).sort((a,b)=>b[1]-a[1]).slice(0,8);
  const iK=iTop.map(([k])=>k);
  gbar('cUsrBar',iK,iK.map(k=>d.inf.sol[k]||0),iK.map(k=>d.inf.inc[k]||0),true);
  pie('cUsrPie',iK,iTop.map(([,v])=>v),PC);

  // Participantes de la solicitud
  const partAll = Object.entries(d.part||{}).sort((a,b)=>b[1]-a[1]).slice(0,8);
  const partK   = partAll.map(([k])=>k);
  const partV   = partAll.map(([,v])=>v);
  sBar('cPartBar', partK, partV, '#0ea5e9', true);
  pie('cPartPie',  partK, partV, ['#0ea5e9','#38bdf8','#7dd3fc','#bae6fd','#0284c7','#0369a1','#075985','#0c4a6e']);
}

/* TABLE */
function renderTable() {
  const pc=_id('pendCount'); if(pc) pc.textContent=`${PENDING.length} tickets activos`;
  const tb=_id('tbody'); if(!tb) return;
  if(!PENDING.length){ tb.innerHTML='<tr><td colspan="9" style="text-align:center;color:var(--lt);padding:24px">No hay tickets pendientes 🎉</td></tr>'; return; }
  tb.innerHTML=PENDING.map(t=>{
    const tp=t.tipo==='sol'?`<span class="its its-s">SOL</span>`:`<span class="its its-i">INC</span>`;
    const st=t.est==='Escalado'?`<span class="sts se">Escalado</span>`:`<span class="sts sh2">Esp. ayuda</span>`;
    return`<tr><td class="tk"><a href="${JIRA_URL}/browse/${t.key}" target="_blank">${t.key}</a></td><td class="tm">${t.cr}</td><td>${tp}</td><td>${st}</td><td class="ts tm" title="${t.res}">${t.res}</td><td class="tm">${t.area}</td><td class="tm">${t.inf}</td><td class="tm">${t.asig}</td><td class="tm">${t.part}</td></tr>`;
  }).join('');
}

/* ══════════════════════════════════════════════════════════
   AUDIO TTS
══════════════════════════════════════════════════════════ */
let speaking=false,fakeP=0,fakeT=null,utt=null;
const synth=window.speechSynthesis;
function fmt(s){const m=Math.floor(s/60);return`${m}:${String(Math.floor(s%60)).padStart(2,'0')}`;}
function stopAudio(){synth.cancel();speaking=false;clearInterval(fakeT);fakeP=0;_id('playBtn').textContent='▶';_id('progBar').value=0;_id('tCur').textContent='0:00';}
window.togglePlay=function(){
  if(speaking){stopAudio();return;}
  synth.cancel();
  utt=new SpeechSynthesisUtterance(window._aiScript||'No hay resumen disponible.');
  utt.lang='es-ES';utt.rate=0.9;utt.pitch=1;
  utt.volume=(_id('volSlider')?.value||90)/100;
  utt.onstart=()=>{speaking=true;_id('playBtn').textContent='⏸';fakeP=0;
    fakeT=setInterval(()=>{if(!speaking){clearInterval(fakeT);return;}
      fakeP=Math.min(fakeP+0.5,fakeDur);_id('progBar').value=(fakeP/fakeDur)*100;
      _id('tCur').textContent=fmt(fakeP);if(fakeP>=fakeDur){clearInterval(fakeT);stopAudio();}},500);};
  utt.onend=()=>stopAudio();utt.onerror=()=>stopAudio();synth.speak(utt);
};
window.seekAudio=v=>{fakeP=fakeDur*(v/100);_id('tCur').textContent=fmt(fakeP);};
window.setVol=v=>{if(utt)utt.volume=v/100;};

/* ══════════════════════════════════════════════════════════
   TAB SWITCH & INIT
══════════════════════════════════════════════════════════ */
window.setM=function(i){cur=i;tabClass();if(speaking)stopAudio();if(Object.keys(D).length)renderAll();};

(function(){
  const rng=defaultRange();
  const df=_id('dFrom'),dt=_id('dTo');
  if(df) df.value=mkey(rng[0].year,rng[0].month);
  if(dt) dt.value=mkey(rng[2].year,rng[2].month);
  loadFromJira();
})();
