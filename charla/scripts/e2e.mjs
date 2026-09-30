#!/usr/bin/env node
/**
 * Pruebas de extremo a extremo: el Worker de verdad (wrangler dev) contra
 * simuladores de NCBI, Anthropic y Evidentia, y las dos páginas abiertas en Chromium.
 *
 *   npm run e2e
 *
 * Variables opcionales: CHARLA_CHROMIUM (ruta al binario), CHARLA_TMP (directorio temporal).
 */
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { iniciarSimuladores, TEXTO_CLAUDE_SIMULADO } from './simuladores.mjs';
import { construir } from './construir.mjs';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'token-de-prueba-e2e-suficientemente-largo-2026';
const TEXTO_ENSAYO = 'Respuesta de ensayo grabada para las pruebas de extremo a extremo. Usted verifica.';
const TEXTO_CHAT_ENSAYO = 'Respuesta de ensayo del chat para las pruebas: acorta los síntomas menos de un día [PMID 24811411].';
const FUENTES_CHAT = ['24811411', '17163267', '25640810'];
const FECHA_ENSAYO = '2026-09-30';
// El embudo del ensayo: distinto del que devuelve el simulador, para saber cuál se ve.
const CIFRAS_ENSAYO = { pubmed: 29, europepmc: 11, unicas: 34, comprobadas: 18, retractadas: 1, afirmaciones: 3, escaladas: 1 };
// Lo que devuelve el simulador de Evidentia al terminar (ver simuladores.mjs).
const CIFRAS_SIMULADOR = { pubmed: 31, europepmc: 12, unicas: 38, comprobadas: 20, retractadas: 0, afirmaciones: 2, escaladas: 1 };
// Los DOI de las tres referencias fabricadas: no pueden llegar nunca al público.
const DOIS_INVENTADOS = ['10.1093/cid/ciad1893', '10.1016/j.jinf.2021.06.041', '10.1016/S1473-3099(22)00614-5'];

let pasadas = 0;
const fallos = [];
function comprobar(condicion, mensaje) {
  if (condicion) {
    pasadas++;
    console.log(`  ✓ ${mensaje}`);
  } else {
    fallos.push(mensaje);
    console.log(`  ✗ ${mensaje}`);
  }
}
const seccion = (t) => console.log(`\n${t}`);
/** Mismas claves y mismos valores, sin importar el orden (los objetos del contrato son planos). */
const mismoObjeto = (a, b) => {
  const orden = (o) => JSON.stringify(Object.keys(o ?? {}).sort().map((k) => [k, o[k]]));
  return Boolean(a) && Boolean(b) && orden(a) === orden(b);
};
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

async function puertoLibre() {
  return new Promise((resolver) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolver(p));
    });
  });
}

async function esperar(fn, ms, cada = 300) {
  const fin = Date.now() + ms;
  let ultimo;
  while (Date.now() < fin) {
    ultimo = await fn();
    if (ultimo) return ultimo;
    await dormir(cada);
  }
  return ultimo;
}

async function ndjson(res) {
  const mensajes = [];
  let resto = '';
  for await (const trozo of res.body.pipeThrough(new TextDecoderStream())) {
    resto += trozo;
    const lineas = resto.split('\n');
    resto = lineas.pop();
    for (const l of lineas) if (l.trim()) mensajes.push(JSON.parse(l));
  }
  if (resto.trim()) mensajes.push(JSON.parse(resto));
  return mensajes;
}

const tmp = await mkdtemp(path.join(process.env.CHARLA_TMP ?? os.tmpdir(), 'charla-e2e-'));
const sim = await iniciarSimuladores();
let wrangler = null;
let navegador = null;

try {
  // ---------------------------------------------------------------- construir
  const respaldosBase = JSON.parse(await readFile(path.join(RAIZ, 'datos/respaldos.json'), 'utf8'));
  const respaldosE2e = {
    claude: { texto: TEXTO_ENSAYO, fecha: FECHA_ENSAYO, modelo: 'claude-sonnet-5' },
    pubmed: { ...respaldosBase.pubmed, fecha: FECHA_ENSAYO },
    evidentia: { runId: 'ensayo-e2e', fecha: FECHA_ENSAYO, cifras: CIFRAS_ENSAYO },
    chat: {
      fecha: FECHA_ENSAYO,
      modelo: 'claude-sonnet-5',
      resultados: 3,
      fuentes: FUENTES_CHAT.map((pmid, i) => ({ pmid, titulo: `Artículo del ensayo ${i + 1}`, revista: 'Revista', anio: 2014 + i })),
      texto: TEXTO_CHAT_ENSAYO,
    },
  };
  const archivoRespaldos = path.join(tmp, 'respaldos.json');
  await writeFile(archivoRespaldos, JSON.stringify(respaldosE2e));
  process.env.CHARLA_RESPALDOS = archivoRespaldos;
  await construir();
  console.log('Construido con los respaldos de prueba.');

  // ---------------------------------------------------------------- wrangler dev
  const puerto = await puertoLibre();
  const base = `http://127.0.0.1:${puerto}`;
  const wsBase = `ws://127.0.0.1:${puerto}`;
  const registroWrangler = [];
  wrangler = spawn(
    'npx',
    [
      'wrangler', 'dev', '--port', String(puerto), '--ip', '127.0.0.1',
      '--persist-to', path.join(tmp, 'estado'),
      '--show-interactive-dev-session=false',
      '--var', 'LOCAL:1',
      '--var', `PRESENTER_TOKEN:${TOKEN}`,
      '--var', 'ANTHROPIC_API_KEY:sk-ant-prueba',
      '--var', `ANTHROPIC_BASE_URL:${sim.base}`,
      '--var', 'ANTHROPIC_WORKSPACE_ID:wrkspc_prueba',
      '--var', `NCBI_BASE_URL:${sim.base}/entrez/eutils`,
      '--var', `EVIDENTIA_URL:${sim.base}`,
    ],
    {
      cwd: RAIZ,
      detached: true,
      env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false', NO_PROXY: '127.0.0.1,localhost' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  wrangler.stdout.on('data', (d) => registroWrangler.push(String(d)));
  wrangler.stderr.on('data', (d) => registroWrangler.push(String(d)));

  const salud = await esperar(
    async () => {
      try {
        const r = await fetch(`${base}/api/salud`);
        return r.ok;
      } catch {
        return false;
      }
    },
    120_000,
    1000,
  );
  if (!salud) {
    console.error(registroWrangler.join(''));
    throw new Error('wrangler dev no arrancó');
  }
  console.log(`wrangler dev listo en ${base}`);

  const get = (ruta, init = {}) => fetch(`${base}${ruta}`, { redirect: 'manual', ...init });
  const bearer = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

  // ---------------------------------------------------------------- público
  seccion('Rutas públicas');
  {
    const r = await get('/');
    comprobar(r.status === 302 && r.headers.get('location') === '/vivo', '/ redirige a /vivo');
    const v = await get('/vivo');
    const cuerpo = await v.text();
    comprobar(v.status === 200, '/vivo responde 200');
    const csp = v.headers.get('content-security-policy') ?? '';
    comprobar(csp.includes("script-src 'self'") && !csp.includes('unsafe-inline'), '/vivo lleva CSP estricto');
    comprobar(v.headers.get('x-frame-options') === 'DENY' && v.headers.get('referrer-policy') === 'same-origin', '/vivo lleva cabeceras de seguridad');
    comprobar((v.headers.get('cache-control') ?? '').includes('no-transform'), '/vivo con no-transform (Cloudflare no le inyecta scripts)');
    comprobar(cuerpo.includes('Ejercicio docente: referencias fabricadas a propósito'), '/vivo lleva la etiqueta docente');
    comprobar(DOIS_INVENTADOS.every((doi) => !cuerpo.includes(doi)) && !cuerpo.includes('Early oseltamivir and time to return'), '/vivo no lleva las citas inventadas completas ni sus DOI');
    const js = await (await get('/vivo.js')).text();
    comprobar(DOIS_INVENTADOS.every((doi) => !js.includes(doi)) && !/innerHTML|outerHTML|insertAdjacentHTML/.test(js), '/vivo.js tampoco, y no usa innerHTML');
    for (const ruta of ['/_privado/presentador.html', '/_privado/respaldos.json', '/presentador.html', '/datos/config.json', '/wrangler.jsonc', '/api/nada']) {
      comprobar((await get(ruta)).status === 404, `${ruta} → 404`);
    }
    const e = await get('/api/sala/estado');
    const estado = await e.json();
    comprobar(e.status === 200 && Array.isArray(estado.eventos), '/api/sala/estado devuelve eventos');
  }

  // ---------------------------------------------------------------- acceso
  seccion('Acceso del presentador');
  let cookie = '';
  {
    const sin = await get('/presentador');
    comprobar(sin.status === 401 && (await sin.text()).includes('Acceso del presentador'), '/presentador sin sesión pide el token (401)');
    comprobar((sin.headers.get('cache-control') ?? '').includes('no-transform'), 'la página de entrada con no-transform');
    const form = (token) =>
      get('/presentador/entrar', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base },
        body: `token=${encodeURIComponent(token)}`,
      });
    const mal = await form('token-equivocado-pero-largo-para-probar');
    comprobar(mal.status === 303 && (mal.headers.get('location') ?? '').includes('error=1') && !mal.headers.get('set-cookie'), 'token equivocado → sin cookie');
    const ajeno = await get('/presentador/entrar', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://malo.example' },
      body: `token=${encodeURIComponent(TOKEN)}`,
    });
    comprobar(ajeno.status === 403, 'entrar desde otro origen → 403');
    const bien = await form(TOKEN);
    const sc = bien.headers.get('set-cookie') ?? '';
    // En local (http://127.0.0.1) la cookie no puede ser __Host- ni Secure; en producción sí (ver auth.ts).
    comprobar(bien.status === 303 && sc.startsWith('presentador-local=') && sc.includes('HttpOnly') && sc.includes('SameSite=Strict'), 'token correcto → cookie HttpOnly SameSite=Strict');
    cookie = sc.split(';')[0];
    const p = await get('/presentador', { headers: { cookie } });
    const html = await p.text();
    comprobar(p.status === 200 && (html.match(/<section class="slide/g) ?? []).length === 19, '/presentador con sesión: 19 diapositivas');
    comprobar((p.headers.get('content-security-policy') ?? '').includes("'sha256-"), '/presentador con CSP por hash');
    comprobar(p.headers.get('x-charla-pagina') === 'presentador' && (p.headers.get('cache-control') ?? '').includes('no-store') && (p.headers.get('cache-control') ?? '').includes('no-transform'), '/presentador marcada, sin caché y con no-transform');
    comprobar((p.headers.get('set-cookie') ?? '').startsWith('presentador-local='), 'abrir /presentador con sesión la renueva (cookie fresca)');
    const d = await get('/presentador/descargar', { headers: { cookie } });
    comprobar(d.status === 200 && (d.headers.get('content-disposition') ?? '').includes('attachment'), '/presentador/descargar entrega el archivo');
    await writeFile(path.join(tmp, 'sin-red.html'), await d.text());
    const bearerMal = await get('/api/presentador/estado', { headers: { authorization: 'Bearer otro-token-largo-que-no-es-el-bueno' } });
    comprobar(bearerMal.status === 401, 'Bearer equivocado → 401');
  }

  // ---------------------------------------------------------------- demo Claude
  seccion('Demo 1a: Claude (en vivo)');
  {
    comprobar((await get('/api/claude/resumen', { method: 'POST', body: '{}' })).status === 401, 'sin sesión → 401');
    const ajeno = await get('/api/claude/resumen', { method: 'POST', headers: { cookie, origin: 'https://malo.example', 'content-type': 'application/json' }, body: '{}' });
    comprobar(ajeno.status === 403, 'con cookie desde otro origen → 403');
    const r = await get('/api/claude/resumen', { method: 'POST', headers: bearer, body: '{}' });
    comprobar(r.status === 200 && (r.headers.get('content-type') ?? '').includes('ndjson'), 'con Bearer → flujo NDJSON');
    const m = await ndjson(r);
    const fin = m.find((x) => x.t === 'fin');
    comprobar(m.some((x) => x.t === 'texto') && fin && fin.texto === TEXTO_CLAUDE_SIMULADO, 'llega el texto parcial y el final');
    const reg = await sim.registro();
    const ll = reg.claude[0];
    comprobar(ll && ll.apiKey === 'sk-ant-prueba' && ll.model === 'claude-sonnet-5' && ll.stream === true, 'la llamada usa la clave del servidor y claude-sonnet-5 en streaming');
    comprobar(ll && ll.tools === null && ll.system === null, 'sin herramientas ni prompt de sistema');
    comprobar(ll && ll.workspace === 'wrkspc_prueba', 'con la cabecera del espacio de trabajo cuando ANTHROPIC_WORKSPACE_ID está definido');
    comprobar(ll && String(ll.prompt).includes('Resuma') && String(ll.prompt).includes('Lindqvist HM'), 'el prompt es el fijo del servidor sobre la referencia 1');
    const est = await (await get('/api/sala/estado')).json();
    const ct = est.eventos.filter((e) => e.tipo === 'claude_texto');
    comprobar(ct.length === 1 && ct[0].texto_parcial === TEXTO_CLAUDE_SIMULADO && !ct[0].ensayo, 'el público recibe solo el texto final, sin marca de ensayo');
    comprobar(est.eventos.every((e) => !('prompt' in e) && !JSON.stringify(e).includes('sk-ant')), 'ningún evento lleva prompt ni clave');
    const en = await (await get('/api/presentador/estado', { headers: bearer })).json();
    comprobar(en.claudeHoy === 1 && en.costos.llamadas === 1 && en.costos.usd > 0, `se registró el costo (US$ ${en.costos.usd})`);
  }

  seccion('Demo 1a: Claude falla → respaldo');
  {
    await sim.modo({ claude: 'error' });
    const m = await ndjson(await get('/api/claude/resumen', { method: 'POST', headers: bearer, body: '{}' }));
    const r = m.find((x) => x.t === 'respaldo');
    comprobar(r && r.texto === TEXTO_ENSAYO && r.fecha === FECHA_ENSAYO, 'con la API caída llega la respuesta de ensayo con su fecha');
    const est = await (await get('/api/sala/estado')).json();
    const ct = est.eventos.filter((e) => e.tipo === 'claude_texto');
    comprobar(ct.length === 1 && ct[0].ensayo === true && ct[0].texto_parcial === TEXTO_ENSAYO, 'el público ve la respuesta de ensayo marcada');
  }

  seccion('Demo 1a: Claude colgado → respaldo a los 25 s');
  {
    await sim.modo({ claude: 'colgado' });
    const t = Date.now();
    const m = await ndjson(await get('/api/claude/resumen', { method: 'POST', headers: bearer, body: '{}' }));
    const seg = (Date.now() - t) / 1000;
    const r = m.find((x) => x.t === 'respaldo');
    comprobar(r && /25 segundos/.test(r.motivo) && seg < 30, `respaldo por plazo a los ${seg.toFixed(1)} s`);
    await sim.modo({ claude: 'ok' });
  }

  // ---------------------------------------------------------------- demo PubMed
  seccion('Demo 1b: PubMed (en vivo)');
  {
    const m = await ndjson(await get('/api/pubmed/verificar', { method: 'POST', headers: bearer, body: '{}' }));
    const ev = m.filter((x) => x.t === 'evento').map((x) => x.evento);
    const veredictos = ev.filter((e) => e.tipo === 'pubmed_veredicto');
    comprobar(veredictos.map((v) => v.existe).join() === 'false,true,false,true,false', 'veredictos: 2 existen y 3 no');
    comprobar(veredictos.find((v) => v.ref === 2)?.pmid === '30184455' && veredictos.find((v) => v.ref === 4)?.pmid === '24718923', 'PMID correctos para las reales');
    const c3 = ev.find((e) => e.tipo === 'pubmed_consulta' && e.ref === 3 && e.via === 'título');
    comprobar(c3 && c3.resultados === 1 && c3.coincide === false, 'la ref. 3 trae 1 resultado por título que no coincide');
    comprobar(veredictos.every((v) => !v.ensayo) && m.find((x) => x.t === 'fin')?.ensayo === false, 'todo en vivo, sin marca de ensayo');
    const reg = await sim.registro();
    comprobar(reg.ncbi.every((l) => l.tool === 'charla-caso-clinico' && l.email === 'david@davidduque.com'), 'cada petición a NCBI lleva tool y email');
    const est = await (await get('/api/sala/estado')).json();
    comprobar(est.eventos.filter((e) => e.tipo === 'pubmed_veredicto').length === 5, 'el público tiene los cinco veredictos');
  }

  seccion('Demo 1b: PubMed caído → respaldo');
  {
    await sim.modo({ ncbi: 'caido' });
    const t = Date.now();
    const m = await ndjson(await get('/api/pubmed/verificar', { method: 'POST', headers: bearer, body: '{}' }));
    const seg = (Date.now() - t) / 1000;
    const fin = m.find((x) => x.t === 'fin');
    const veredictos = m.filter((x) => x.t === 'evento').map((x) => x.evento).filter((e) => e.tipo === 'pubmed_veredicto');
    comprobar(fin && fin.ensayo === true && fin.fecha === FECHA_ENSAYO, `termina con los resultados del ensayo en ${seg.toFixed(1)} s`);
    comprobar(veredictos.length === 5 && veredictos.every((v) => v.ensayo === true), 'los cinco veredictos vienen marcados como ensayo');
    comprobar(veredictos.map((v) => v.existe).join() === 'false,true,false,true,false', 'y son los correctos');
    await sim.modo({ ncbi: 'ok' });
  }

  // ---------------------------------------------------------------- chat con PubMed
  seccion('Demo 2: el mismo chat, con PubMed (en vivo)');
  {
    const consulta = JSON.parse(await readFile(path.join(RAIZ, 'datos/contenido.json'), 'utf8')).chat.consulta;
    comprobar((await get('/api/chat/responder', { method: 'POST', body: '{}' })).status === 401, 'sin sesión → 401');
    const antes = (await (await get('/api/presentador/estado', { headers: bearer })).json()).claudeHoy;
    const r = await get('/api/chat/responder', { method: 'POST', headers: bearer, body: '{}' });
    comprobar(r.status === 200 && (r.headers.get('content-type') ?? '').includes('ndjson'), 'con Bearer → flujo NDJSON');
    const m = await ndjson(r);
    const fin = m.find((x) => x.t === 'fin');
    comprobar(fin && fin.resultados === 3 && fin.fuentes.map((f) => f.pmid).join() === FUENTES_CHAT.join(), 'lee los tres artículos que devolvió la consulta fija');
    comprobar(fin && fin.citados.join() === '24811411,25640810' && fin.texto.includes('[PMID 25640810]'), 'la respuesta cita dos de ellos por su PMID');
    comprobar(fin && !fin.texto.includes('99999999') && fin.texto.includes('cita retirada'), 'la cita a un PMID que no salió de la búsqueda se retira');
    const reg = await sim.registro();
    const busqueda = reg.ncbi.filter((l) => l.term === consulta).pop();
    comprobar(busqueda && busqueda.sort === 'relevance' && busqueda.retmax === '3', 'busca con la consulta fija: los 3 primeros por relevancia');
    comprobar(reg.ncbi.some((l) => l.ruta.endsWith('efetch.fcgi') && l.id === FUENTES_CHAT.join(',') && l.tool === 'charla-caso-clinico'), 'lee los resúmenes con efetch, con tool y email');
    const ll = reg.claude[reg.claude.length - 1];
    comprobar(ll && ll.tools === null && ll.system === null && ll.model === 'claude-sonnet-5', 'Claude sin herramientas ni prompt de sistema');
    comprobar(ll && String(ll.prompt).includes('Resúmenes de PubMed') && String(ll.prompt).includes('PMID 17163267') && String(ll.prompt).includes('oseltamivir'), 'el prompt es el fijo del servidor, con los resúmenes leídos');
    const est = await (await get('/api/sala/estado')).json();
    const pasos = Object.fromEntries(est.eventos.filter((e) => e.tipo === 'chat_paso').map((e) => [e.paso, e]));
    comprobar(pasos.busqueda?.cifra === 3 && pasos.lectura?.cifra === 3 && pasos.respuesta?.cifra === 2 && pasos.respuesta?.estado === 'completada', 'el público ve los tres pasos con sus cifras');
    const fuentes = est.eventos.find((e) => e.tipo === 'chat_fuentes');
    comprobar(fuentes && fuentes.fuentes.length === 3 && fuentes.fuentes.every((f) => /^\d+$/.test(f.pmid) && f.titulo && !('resumen' in f)), 'y las tres fuentes con PMID y título, sin los resúmenes');
    const ct = est.eventos.filter((e) => e.tipo === 'chat_texto');
    comprobar(ct.length === 1 && ct[0].texto_parcial === fin?.texto && !ct[0].ensayo, 'el público recibe la respuesta revisada, sin marca de ensayo');
    comprobar(est.eventos.every((e) => !JSON.stringify(e).includes('SOLO los resúmenes')), 'la instrucción del prompt no llega al público');
    comprobar(est.eventos.some((e) => e.tipo === 'claude_texto'), 'la respuesta de la demo 1 sigue ahí para su comparación');
    const despues = (await (await get('/api/presentador/estado', { headers: bearer })).json()).claudeHoy;
    comprobar(despues === antes + 1, 'cuenta en el cupo diario de Claude');
  }

  seccion('Demo 2: chat con PubMed caído → respaldo');
  {
    await sim.modo({ ncbi: 'caido' });
    const antes = (await (await get('/api/presentador/estado', { headers: bearer })).json()).claudeHoy;
    const m = await ndjson(await get('/api/chat/responder', { method: 'POST', headers: bearer, body: '{}' }));
    const r = m.find((x) => x.t === 'respaldo');
    comprobar(r && r.texto === TEXTO_CHAT_ENSAYO && r.fecha === FECHA_ENSAYO && /PubMed no respondió/.test(r.motivo), `llega la respuesta del ensayo con su fecha («${r?.motivo}»)`);
    const despues = (await (await get('/api/presentador/estado', { headers: bearer })).json()).claudeHoy;
    comprobar(despues === antes, 'sin PubMed no se llama a Claude');
    const est = await (await get('/api/sala/estado')).json();
    const ch = est.eventos.filter((e) => e.tipo.startsWith('chat_'));
    comprobar(ch.length > 0 && ch.filter((e) => e.tipo !== 'chat_paso' || e.estado === 'completada').every((e) => e.ensayo === true), 'el público ve el ensayo marcado como tal');
    await sim.modo({ ncbi: 'html' });
    const h = await ndjson(await get('/api/chat/responder', { method: 'POST', headers: bearer, body: '{}' }));
    comprobar(h.some((x) => x.t === 'respaldo'), 'una página antibot en lugar de PubMed también pasa al ensayo');
    await sim.modo({ ncbi: 'ok' });
  }

  seccion('Demo 2: chat con Claude caído → respaldo');
  {
    await sim.modo({ claude: 'error' });
    const m = await ndjson(await get('/api/chat/responder', { method: 'POST', headers: bearer, body: '{}' }));
    const r = m.find((x) => x.t === 'respaldo');
    comprobar(r && r.texto === TEXTO_CHAT_ENSAYO && /Claude no respondió/.test(r.motivo), `llega la respuesta del ensayo («${r?.motivo}»)`);
    await sim.modo({ claude: 'ok' });
    const pedida = await get('/api/sala/respaldo', { method: 'POST', headers: bearer, body: '{"tipo":"chat"}' });
    comprobar(pedida.status === 200 && (await pedida.json()).ok === true, 'el presentador puede pedir el ensayo sin pregunta en curso');
  }

  // ---------------------------------------------------------------- Evidentia
  seccion('Demo 3: Evidentia');
  {
    const r = await get('/api/evidentia/lanzar', { method: 'POST', headers: bearer, body: '{}' });
    const d = await r.json();
    comprobar(r.status === 200 && /^sim/.test(d.runId) && d.enlace === `${sim.base}/ui#${d.runId}`, 'lanza y devuelve runId y enlace a /ui');
    const otra = await get('/api/evidentia/lanzar', { method: 'POST', headers: bearer, body: '{}' });
    comprobar(otra.status === 409, 'un segundo lanzamiento mientras corre → 409');
    const reg = await sim.registro();
    comprobar(reg.evidentia[0]?.mode === 'ask' && /miel/i.test(reg.evidentia[0]?.question ?? ''), 'la pregunta va en modo ask');
    const completada = await esperar(async () => {
      const est = await (await get('/api/sala/estado')).json();
      return est.eventos.find((e) => e.tipo === 'evidentia_etapa' && e.etapa.startsWith('Búsqueda') && e.estado === 'completada');
    }, 30_000, 1000);
    comprobar(completada && completada.detalle === '31 referencias de PubMed y 12 de Europe PMC', 'el sondeo por alarma trae las etapas con cifras');
    const embudo = await esperar(async () => {
      const est = await (await get('/api/sala/estado')).json();
      return est.eventos.find((e) => e.tipo === 'evidentia_embudo');
    }, 5000);
    const { tipo: _t, ts: _ts, seq: _seq, ...cifrasEmbudo } = embudo ?? {};
    comprobar(embudo && mismoObjeto(cifrasEmbudo, CIFRAS_SIMULADOR), 'al terminar llega el embudo con sus cifras, solo enteros y sin marca de ensayo');
    const est = await (await get('/api/sala/estado')).json();
    const ultimaEtapa = Math.max(...est.eventos.filter((e) => e.tipo === 'evidentia_etapa').map((e) => e.seq));
    comprobar(embudo && embudo.seq > ultimaEtapa, 'el embudo va después de las etapas');
    comprobar(!JSON.stringify(est.eventos).includes('sulfadiazina'), 'ningún texto del resultado llega al público');
    const en = await (await get('/api/presentador/estado', { headers: bearer })).json();
    comprobar(en.evidentia?.terminado === true && en.evidentia.resultado === 'completo', 'el presentador ve el run terminado');
    comprobar(mismoObjeto(en.evidentia?.cifras, CIFRAS_SIMULADOR), 'y las cifras del embudo');
  }

  seccion('Demo 3: Evidentia caída');
  {
    await sim.modo({ evidentia: 'caido' });
    comprobar((await get('/api/sala/reiniciar', { method: 'POST', headers: bearer, body: '{}' })).status === 200, 'reiniciar la sala');
    const r = await get('/api/evidentia/lanzar', { method: 'POST', headers: bearer, body: '{}' });
    comprobar(r.status === 502, 'lanzar con Evidentia caída → 502');
    const est = await (await get('/api/sala/estado')).json();
    comprobar(est.eventos.some((e) => e.tipo === 'evidentia_etapa' && e.estado === 'falló'), 'el público ve la etapa fallida');
    const ens = est.eventos.find((e) => e.tipo === 'evidentia_embudo');
    const { tipo: _t, ts: _ts, seq: _seq, ensayo, ...cifrasEns } = ens ?? {};
    comprobar(ens && ensayo === true && mismoObjeto(cifrasEns, CIFRAS_ENSAYO), 'y el embudo del ensayo, marcado como ensayo');
    const en = await (await get('/api/presentador/estado', { headers: bearer })).json();
    comprobar(en.evidentiaSalud !== 'ok', 'el presentador ve que Evidentia no responde');
    comprobar(en.respaldos?.embudoEvidentia === true, 'el presentador ve que el respaldo de Evidentia trae el embudo');
    await sim.modo({ evidentia: 'ok' });
  }

  // ---------------------------------------------------------------- votación
  seccion('Votación del público (HTTP)');
  {
    // El celular manda Origin (o Sec-Fetch-Site) por su cuenta; aquí se pone a mano.
    const votar = (cuerpo, cabeceras = { origin: base }) =>
      get('/api/sala/voto', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...cabeceras },
        body: typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo),
      });
    const votacion = (cuerpo, headers = bearer) => get('/api/sala/votacion', { method: 'POST', headers, body: JSON.stringify(cuerpo) });
    const leer = (r) => r.json().catch(() => null);
    const estadoPres = async () => (await get('/api/presentador/estado', { headers: bearer })).json();
    const conteo = (v, ref) => v?.conteos?.find((c) => c.ref === ref) ?? null;
    // /api/sala/estado tiene una caché de 1 s en el Worker y los votos no la invalidan: se espera.
    const salaCuando = (condicion, ms = 5000) =>
      esperar(async () => {
        const est = await (await get('/api/sala/estado')).json();
        return condicion(est) ? est : null;
      }, ms, 250);
    const A = 'e2eVotanteA_0123456789';
    const B = 'e2eVotanteB_0123456789';

    const inicial = await estadoPres();
    comprobar(inicial.votacion?.estado === null && inicial.votacion.ronda === null && inicial.votacion.conteos === null, 'sin votación, el presentador la ve vacía');
    const antesDeAbrir = await votar({ votante: A, ronda: 1, ref: 1, existe: true });
    comprobar(antesDeAbrir.status === 409 && (await leer(antesDeAbrir))?.error === 'votacion_cerrada', 'votar sin votación abierta → 409 votacion_cerrada');

    comprobar(
      (await get('/api/sala/votacion', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"abrir":true}' })).status === 401,
      'abrir la votación sin sesión → 401',
    );
    comprobar(
      (await votacion({ abrir: true }, { cookie, origin: 'https://malo.example', 'content-type': 'application/json' })).status === 403,
      'abrir la votación con cookie desde otro origen → 403',
    );
    const malAbrir = await votacion({ abrir: 'sí' });
    comprobar(malAbrir.status === 400 && (await leer(malAbrir))?.error === 'abrir_invalido', '{abrir} que no es booleano → 400');

    const abrir = await votacion({ abrir: true });
    const abierta = await leer(abrir);
    const ronda = abierta?.ronda;
    comprobar(abrir.status === 200 && abierta.ok === true && abierta.estado === 'abierta' && Number.isInteger(ronda) && ronda >= 1, `el presentador abre la votación con Bearer (ronda ${ronda})`);
    const otra = await leer(await votacion({ abrir: true }));
    comprobar(otra?.repetida === true && otra.estado === 'abierta' && otra.ronda === ronda, 'un segundo «abrir» sigue con la misma ronda: un doble clic no borra votos');

    const v1 = await votar({ votante: A, ronda, ref: 1, existe: true });
    comprobar(v1.status === 200 && mismoObjeto(await leer(v1), { ok: true }), 'voto válido → 200 {ok:true}');
    comprobar((v1.headers.get('cache-control') ?? '').includes('no-store'), 'la respuesta del voto no se guarda en caché');
    const siguientes = [
      await votar({ votante: A, ronda, ref: 1, existe: false }),
      await votar({ votante: A, ronda, ref: 1, existe: false }),
      await votar({ votante: B, ronda, ref: 1, existe: true }),
      await votar({ votante: B, ronda, ref: 2, existe: true }),
    ];
    comprobar(siguientes.every((r) => r.status === 200), 'cambio de voto, voto repetido y votos de otro votante → 200');
    let ep = await estadoPres();
    comprobar(
      mismoObjeto(conteo(ep.votacion, 1), { ref: 1, si: 1, no: 1 }) && mismoObjeto(conteo(ep.votacion, 2), { ref: 2, si: 1, no: 0 }) && ep.votacion.votantes === 2,
      'cambiar el voto resta del conteo anterior (ref. 1: 1 sí · 1 no; 2 votantes)',
    );

    const invalidos = [
      ['votante corto', { votante: 'corto', ronda, ref: 1, existe: true }],
      ['votante con espacio', { votante: 'votante con espacio 12345', ronda, ref: 1, existe: true }],
      ['votante de 65 caracteres', { votante: 'v'.repeat(65), ronda, ref: 1, existe: true }],
      ['ref 0', { votante: A, ronda, ref: 0, existe: true }],
      ['ref 6', { votante: A, ronda, ref: 6, existe: true }],
      ['ref 1.5', { votante: A, ronda, ref: 1.5, existe: true }],
      ['ref en texto', { votante: A, ronda, ref: '1', existe: true }],
      ['existe no booleano', { votante: A, ronda, ref: 1, existe: 'sí' }],
      ['ronda en texto', { votante: A, ronda: String(ronda), ref: 1, existe: true }],
      ['sin votante', { ronda, ref: 1, existe: true }],
      ['cuerpo que no es JSON', '{votante:'],
      ['cuerpo vacío', ''],
    ];
    const noDieron400 = [];
    for (const [nombre, cuerpo] of invalidos) {
      const r = await votar(cuerpo);
      const d = await leer(r);
      if (r.status !== 400 || d?.error !== 'voto_invalido') noDieron400.push(`${nombre}: ${r.status}`);
    }
    comprobar(
      noDieron400.length === 0,
      noDieron400.length ? `votos inválidos que no dieron 400: ${noDieron400.join(', ')}` : `votante o ref inválidos → 400 voto_invalido (${invalidos.length} casos)`,
    );

    const ajeno = await votar({ votante: A, ronda, ref: 3, existe: true }, { origin: 'https://malo.example' });
    comprobar(ajeno.status === 403, 'voto con Origin ajeno → 403');
    comprobar((await votar({ votante: A, ronda, ref: 3, existe: true }, {})).status === 403, 'voto sin Origin ni Sec-Fetch-Site → 403');
    comprobar(
      (await votar({ votante: A, ronda, ref: 3, existe: true }, { origin: base, 'sec-fetch-site': 'cross-site' })).status === 403,
      'voto con Sec-Fetch-Site cross-site → 403 aunque el Origin sea el propio',
    );
    comprobar((await votar({ votante: B, ronda, ref: 3, existe: false }, { 'sec-fetch-site': 'same-origin' })).status === 200, 'voto con Sec-Fetch-Site same-origin → 200');
    const grande = await votar(JSON.stringify({ votante: A, ronda, ref: 1, existe: true, relleno: 'x'.repeat(600) }));
    comprobar(grande.status === 413, 'voto de más de 512 bytes → 413');
    const deOtraRonda = await votar({ votante: A, ronda: ronda + 1, ref: 1, existe: true });
    comprobar(deOtraRonda.status === 409 && (await leer(deOtraRonda))?.error === 'votacion_cerrada', 'voto de una ronda que no es la abierta → 409');
    ep = await estadoPres();
    comprobar(mismoObjeto(conteo(ep.votacion, 3), { ref: 3, si: 0, no: 1 }) && ep.votacion.votantes === 2, 'los votos rechazados no cuentan');

    // Un celular que vota en las cinco a la vez y luego cambia las cinco a la vez: su
    // papeleta no se pisa (la puerta de entrada de la sala ordena las lecturas y
    // escrituras) y cada cambio resta del conteo anterior.
    const C = 'e2eVotanteC_0123456789';
    const cinco = (existe) => Promise.all([1, 2, 3, 4, 5].map((ref) => votar({ votante: C, ronda, ref, existe })));
    const primeros = await cinco(true);
    const cambios = await cinco(false);
    ep = await estadoPres();
    comprobar(
      [...primeros, ...cambios].every((r) => r.status === 200) &&
        ep.votacion.votantes === 3 &&
        [
          { ref: 1, si: 1, no: 2 },
          { ref: 2, si: 1, no: 1 },
          { ref: 3, si: 0, no: 2 },
          { ref: 4, si: 0, no: 1 },
          { ref: 5, si: 0, no: 1 },
        ].every((x) => mismoObjeto(conteo(ep.votacion, x.ref), x)),
      'votos simultáneos del mismo celular en las cinco, y sus cambios simultáneos: un votante más y ningún voto fantasma',
    );

    // Muchos celulares a la vez: los totales salen como mucho una vez por segundo y cuadran.
    const ws = new WebSocket(`${wsBase}/api/sala/ws`);
    const mensajes = [];
    await new Promise((resolver, rechazar) => {
      ws.onopen = resolver;
      ws.onerror = () => rechazar(new Error('ws'));
    });
    ws.onmessage = (m) => {
      if (m.data !== 'pong') mensajes.push({ t: Date.now(), e: JSON.parse(m.data) });
    };
    // Más de un segundo desde la última difusión (la de los votos anteriores pudo quedar
    // programada hasta 1 s después del último): el primer voto de la ráfaga sale ya y el
    // resto espera al segundo siguiente.
    await dormir(2200);
    const desde = Date.now();
    const N = 40;
    const rafaga = await Promise.all(
      Array.from({ length: N }, (_, k) => votar({ votante: `e2eRafaga_${String(k).padStart(4, '0')}_abcdef`, ronda, ref: 4, existe: k % 4 !== 0 })),
    );
    await dormir(2500);
    const duracion = Date.now() - desde;
    ws.close();
    const difusiones = mensajes.filter((m) => m.t >= desde && m.e.tipo === 'votos');
    const huecos = difusiones.slice(1).map((m, k) => m.t - difusiones[k].t);
    comprobar(rafaga.every((r) => r.status === 200), `${N} votos simultáneos → 200`);
    comprobar(
      difusiones.length >= 2 && difusiones.length <= Math.ceil(duracion / 1000) + 1 && huecos.every((h) => h >= 700),
      `los totales se difunden como mucho una vez por segundo (${difusiones.length} difusiones en ${(duracion / 1000).toFixed(1)} s)`,
    );
    // 9 votos antes de la ráfaga (A, B y C) y 40 en ella.
    const TOTAL_ABIERTA = 49;
    comprobar(difusiones.at(-1)?.e.total === TOTAL_ABIERTA, `y la última difusión trae el total exacto (${difusiones.at(-1)?.e.total} de ${TOTAL_ABIERTA} votos)`);
    comprobar(
      mensajes.filter((m) => m.e.tipo === 'votos').every((m) => Object.keys(m.e).sort().join() === 'ronda,seq,tipo,total,ts'),
      'con la votación abierta, al público solo le llega cuántos votos van, sin el desglose por referencia',
    );
    comprobar(mensajes.every((m) => !/e2eRafaga|e2eVotante/.test(JSON.stringify(m.e))), 'ningún evento difundido lleva el código de un votante');

    const conVotos = await salaCuando((est) => est.eventos.some((e) => e.tipo === 'votos' && e.total === TOTAL_ABIERTA));
    const eventosVot = conVotos?.eventos ?? [];
    comprobar(eventosVot.some((e) => e.tipo === 'votacion' && e.estado === 'abierta' && e.ronda === ronda), '/api/sala/estado trae la votación abierta');
    const totales = eventosVot.filter((e) => e.tipo === 'votos');
    comprobar(
      totales.length === 1 && totales[0].ronda === ronda && totales[0].total === TOTAL_ABIERTA && !('conteos' in totales[0]),
      'y sus totales: uno solo en el historial, y tampoco ahí el desglose mientras está abierta',
    );
    comprobar(eventosVot.filter((e) => e.tipo === 'votacion').length === 1, 'el historial guarda solo el último estado de la votación');

    // Verificar en PubMed revela los veredictos: la votación se cierra antes.
    const finales = (await estadoPres()).votacion.conteos;
    const m = await ndjson(await get('/api/pubmed/verificar', { method: 'POST', headers: bearer, body: '{}' }));
    ep = await estadoPres();
    comprobar(ep.votacion?.estado === 'cerrada' && ep.votacion.ronda === ronda && JSON.stringify(ep.votacion.conteos) === JSON.stringify(finales), 'verificar en PubMed cierra la votación y conserva sus totales');
    const trasVerificar = await salaCuando(
      (est) => est.eventos.some((e) => e.tipo === 'votacion' && e.estado === 'cerrada') && est.eventos.filter((e) => e.tipo === 'pubmed_veredicto').length === 5,
    );
    const evs = trasVerificar?.eventos ?? [];
    const seqDe = (f) => evs.find(f)?.seq ?? -1;
    const sTotales = seqDe((e) => e.tipo === 'votos' && e.ronda === ronda);
    const sCierre = seqDe((e) => e.tipo === 'votacion' && e.estado === 'cerrada' && e.ronda === ronda);
    const sInicio = seqDe((e) => e.tipo === 'demo_inicio' && e.tema === 'verificacion');
    const sVeredicto = Math.min(...evs.filter((e) => e.tipo === 'pubmed_veredicto').map((e) => e.seq));
    comprobar(
      sTotales > 0 && sTotales < sCierre && sCierre < sInicio && sInicio < sVeredicto,
      'orden en el historial: totales finales → cierre de la votación → inicio de la verificación → veredictos',
    );
    const desglose = evs.find((e) => e.tipo === 'votos' && e.ronda === ronda);
    comprobar(
      JSON.stringify(desglose?.conteos) === JSON.stringify(finales) && mismoObjeto(conteo(desglose, 4), { ref: 4, si: 30, no: 11 }),
      'al cerrar, el público recibe el desglose: los mismos totales que ve el presentador (ref. 4: 30 sí · 11 no)',
    );
    comprobar((await votar({ votante: A, ronda, ref: 5, existe: false })).status === 409, 'con la votación cerrada, votar → 409');
    const ev = m.filter((x) => x.t === 'evento').map((x) => x.evento);
    const consultasPm = ev.filter((e) => e.tipo === 'pubmed_consulta');
    const precedidas = consultasPm.every((c) => {
      const b = ev[ev.indexOf(c) - 1];
      return b?.tipo === 'pubmed_buscando' && b.ref === c.ref && b.via === c.via;
    });
    comprobar(
      consultasPm.length > 0 && precedidas && ev.filter((e) => e.tipo === 'pubmed_buscando').length === consultasPm.length,
      'cada consulta a PubMed va precedida de su «buscando», también en el flujo del presentador',
    );
    comprobar(
      ev.filter((e) => e.tipo === 'pubmed_buscando').every((e) => Object.keys(e).sort().join() === 'ref,seq,tipo,ts,via'),
      'el «buscando» lleva solo el número de referencia y la vía, nunca el texto de la consulta',
    );
    comprobar(evs.filter((e) => e.tipo === 'pubmed_buscando').length === 1, 'el historial guarda solo la última búsqueda');
    const cerrarOtraVez = await leer(await votacion({ abrir: false }));
    comprobar(cerrarOtraVez?.ok === true && cerrarOtraVez.estado === 'cerrada' && cerrarOtraVez.ronda === ronda, 'cerrar una votación ya cerrada no hace daño');

    // Con los veredictos a la vista no se abre otra votación: la respuesta ya está en la pantalla.
    ep = await estadoPres();
    comprobar(ep.verificacionALaVista === true, 'el presentador sabe que el público ya ve la verificación');
    const tapada = await votacion({ abrir: true });
    const dTapada = await leer(tapada);
    comprobar(
      tapada.status === 409 && dTapada?.error === 'verificacion_a_la_vista' && /reinicie la sala/.test(dTapada.mensaje ?? ''),
      'con los veredictos a la vista, abrir otra votación → 409, y el mensaje dice que hay que reiniciar la sala',
    );
    comprobar((await estadoPres()).votacion?.estado === 'cerrada', 'y la votación sigue cerrada');
    comprobar((await get('/api/sala/reiniciar', { method: 'POST', headers: bearer, body: '{}' })).status === 200, 'reiniciar la sala para votar otra vez');
    comprobar((await estadoPres()).verificacionALaVista === false, 'tras reiniciar ya no hay veredictos a la vista');

    // Una ronda nueva empieza de cero; el respaldo de PubMed también la cierra.
    const ronda2 = (await leer(await votacion({ abrir: true })))?.ronda;
    comprobar(ronda2 === ronda + 1, `abrir otra vez crea la ronda siguiente (${ronda2})`);
    const enLaNueva = await votar({ votante: A, ronda: ronda2, ref: 1, existe: true });
    const conLaVieja = await votar({ votante: B, ronda, ref: 1, existe: true });
    comprobar(enLaNueva.status === 200 && conLaVieja.status === 409, 'en la ronda nueva se vota; un celular con la anterior → 409');
    ep = await estadoPres();
    comprobar(
      ep.votacion.votantes === 1 && ep.votacion.conteos.every((c) => mismoObjeto(c, { ref: c.ref, si: c.ref === 1 ? 1 : 0, no: 0 })),
      'la ronda nueva empieza de cero',
    );

    // El tope por red: un script que inventa votantes desde una sola red (con Origin
    // puesto a mano, como aquí) no llena la ronda ni deja fuera al resto. wrangler dev
    // toma la IP de cf-connecting-ip; en producción la pone Cloudflare.
    const deLaRed = (ip) => ({ origin: base, 'cf-connecting-ip': ip });
    const RED_X = '198.51.100.23';
    const RED_Y = '198.51.100.99';
    const TOPE_RED = 600;
    let aceptados = 0;
    for (let lote = 0; lote < TOPE_RED; lote += 50) {
      const rs = await Promise.all(
        Array.from({ length: 50 }, (_, k) => votar({ votante: `e2eRed_${String(lote + k).padStart(4, '0')}_abcdefgh`, ronda: ronda2, ref: 2, existe: true }, deLaRed(RED_X))),
      );
      aceptados += rs.filter((r) => r.status === 200).length;
    }
    const sobra = await votar({ votante: 'e2eRed_sobra_abcdefghij', ronda: ronda2, ref: 2, existe: true }, deLaRed(RED_X));
    comprobar(
      aceptados === TOPE_RED && sobra.status === 503 && (await leer(sobra))?.error === 'votacion_llena',
      `desde una misma red entran ${aceptados} votantes nuevos por ronda; el siguiente → 503 votacion_llena`,
    );
    comprobar(
      (await votar({ votante: 'e2eRed_0007_abcdefgh', ronda: ronda2, ref: 2, existe: false }, deLaRed(RED_X))).status === 200,
      'quien ya votó desde esa red puede cambiar su voto',
    );
    comprobar((await votar({ votante: 'e2eOtraRed_abcdefghij', ronda: ronda2, ref: 2, existe: true }, deLaRed(RED_Y))).status === 200, 'desde otra red se sigue votando');
    ep = await estadoPres();
    comprobar(
      ep.votacion.votantes === 602 && mismoObjeto(conteo(ep.votacion, 2), { ref: 2, si: 600, no: 1 }),
      `el rechazado por el tope de su red no cuenta (${ep.votacion.votantes} votantes; ref. 2: ${conteo(ep.votacion, 2)?.si} sí · ${conteo(ep.votacion, 2)?.no} no)`,
    );

    comprobar((await get('/api/sala/respaldo', { method: 'POST', headers: bearer, body: '{"tipo":"pubmed"}' })).status === 200, 'el presentador pide el respaldo de PubMed');
    ep = await estadoPres();
    comprobar(ep.votacion?.estado === 'cerrada' && ep.votacion.ronda === ronda2, 'pedir el respaldo de PubMed también cierra la votación');

    // Pasar de la diapositiva de la demo cierra la votación, con sus totales; volver atrás no.
    const diapo = (n) => get('/api/sala/diapositiva', { method: 'POST', headers: bearer, body: JSON.stringify({ n }) });
    comprobar((await get('/api/sala/reiniciar', { method: 'POST', headers: bearer, body: '{}' })).status === 200, 'reiniciar la sala para la ronda siguiente');
    const ronda3 = (await leer(await votacion({ abrir: true })))?.ronda;
    await votar({ votante: A, ronda: ronda3, ref: 5, existe: true });
    await diapo(2);
    await diapo(3);
    comprobar((await estadoPres()).votacion?.estado === 'abierta', 'en las diapositivas 2 y 3 la votación sigue abierta');
    await diapo(4);
    ep = await estadoPres();
    comprobar(
      ep.votacion?.estado === 'cerrada' && ep.votacion.ronda === ronda3 && mismoObjeto(conteo(ep.votacion, 5), { ref: 5, si: 1, no: 0 }),
      'pasar a la diapositiva 4 cierra la votación y conserva sus totales',
    );
    const trasDiapo = (await salaCuando((est) => est.eventos.some((e) => e.tipo === 'diapositiva' && e.n === 4)))?.eventos ?? [];
    const sq = (f) => trasDiapo.find(f)?.seq ?? -1;
    comprobar(
      sq((e) => e.tipo === 'votos' && Array.isArray(e.conteos)) > 0 &&
        sq((e) => e.tipo === 'votos' && Array.isArray(e.conteos)) < sq((e) => e.tipo === 'votacion' && e.estado === 'cerrada') &&
        sq((e) => e.tipo === 'votacion' && e.estado === 'cerrada') < sq((e) => e.tipo === 'diapositiva' && e.n === 4),
      'orden en el historial: desglose final → cierre de la votación → diapositiva 4',
    );

    // Reiniciar la sala cierra y borra; el número de ronda sigue creciendo.
    const ronda4 = (await leer(await votacion({ abrir: true })))?.ronda;
    comprobar(ronda4 === ronda3 + 1, `sin veredictos a la vista se abre otra ronda (${ronda4})`);
    await votar({ votante: B, ronda: ronda4, ref: 2, existe: false });
    comprobar((await get('/api/sala/reiniciar', { method: 'POST', headers: bearer, body: '{}' })).status === 200, 'reiniciar la sala con la votación abierta');
    ep = await estadoPres();
    comprobar(
      ep.votacion?.estado === null && ep.votacion.ronda === null && ep.votacion.conteos === null && ep.votacion.votantes === 0,
      'reiniciar cierra la votación y borra sus votos',
    );
    comprobar((await salaCuando((est) => est.eventos.length === 0)) !== null, 'y el público recibe un historial vacío');
    comprobar((await votar({ votante: B, ronda: ronda4, ref: 2, existe: true })).status === 409, 'tras reiniciar, un celular con la ronda anterior → 409');
    const ronda5 = (await leer(await votacion({ abrir: true })))?.ronda;
    comprobar(ronda5 === ronda4 + 1, `el número de ronda sigue creciendo tras el reinicio (${ronda4} → ${ronda5})`);
    comprobar((await get('/api/sala/reiniciar', { method: 'POST', headers: bearer, body: '{}' })).status === 200, 'la sala queda limpia para lo que sigue');
  }

  // ---------------------------------------------------------------- sala
  seccion('Sala: avisos, diapositivas y WebSocket');
  {
    const a = await get('/api/sala/aviso', { method: 'POST', headers: bearer, body: JSON.stringify({ texto: '<b>Hola</b> a todos' }) });
    comprobar(a.status === 200, 'aviso enviado');
    comprobar((await get('/api/sala/diapositiva', { method: 'POST', headers: bearer, body: '{"n":3}' })).status === 200, 'diapositiva 3');
    comprobar((await get('/api/sala/diapositiva', { method: 'POST', headers: bearer, body: '{"n":99}' })).status === 400, 'diapositiva 99 → 400');
    const grande = await get('/api/sala/aviso', { method: 'POST', headers: bearer, body: JSON.stringify({ texto: 'x'.repeat(10_000) }) });
    comprobar(grande.status === 413, 'cuerpo enorme → 413');
    const est = await (await get('/api/sala/estado')).json();
    const av = est.eventos.find((e) => e.tipo === 'aviso');
    comprobar(av && av.texto === '<b>Hola</b> a todos', 'el aviso viaja como texto, sin interpretar');

    const ws = new WebSocket(`${wsBase}/api/sala/ws`);
    const recibidos = [];
    const cierre = new Promise((resolver) => (ws.onclose = (e) => resolver(e.code)));
    await new Promise((resolver, rechazar) => {
      ws.onopen = resolver;
      ws.onerror = () => rechazar(new Error('ws'));
    });
    ws.onmessage = (m) => recibidos.push(m.data);
    await dormir(500);
    comprobar(recibidos.some((d) => d !== 'pong' && JSON.parse(d).tipo === 'diapositiva' && JSON.parse(d).n === 3), 'al conectar llega el historial');
    ws.send('ping');
    await dormir(300);
    comprobar(recibidos.includes('pong'), 'ping → pong');
    ws.send('hola');
    const codigo = await Promise.race([cierre, dormir(3000).then(() => null)]);
    comprobar(codigo === 1008, 'escribir por el WebSocket lo cierra (1008): solo lectura');
  }

  // ---------------------------------------------------------------- navegador
  seccion('Navegador: /vivo');
  const ejecutable = process.env.CHARLA_CHROMIUM ?? (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : chromium.executablePath());
  navegador = await chromium.launch({ executablePath: ejecutable });
  const erroresConsola = [];
  const nuevaPagina = async (contexto) => {
    const p = await contexto.newPage();
    p.on('console', (m) => {
      if (m.type() === 'error') erroresConsola.push(m.text());
    });
    p.on('pageerror', (e) => erroresConsola.push(String(e)));
    // Solo recursos (script, CSS, fuentes, documento). Un fetch con flujo NDJSON desde una
    // página controlada por el service worker aparece como ERR_ABORTED en Chromium aunque
    // termine bien: la petición real es la que el service worker reemite hacia la red.
    p.on('requestfailed', (r) => {
      if (r.resourceType() === 'fetch' || r.resourceType() === 'xhr') return;
      erroresConsola.push(`petición fallida: ${r.url()} (${r.failure()?.errorText ?? ''})`);
    });
    return p;
  };
  const publico = await navegador.newContext({ viewport: { width: 390, height: 844 } });
  const vivo = await nuevaPagina(publico);
  {
    // Deja el estado como lo vería alguien que llega tarde: demo completa y una de ensayo.
    await ndjson(await get('/api/claude/resumen', { method: 'POST', headers: bearer, body: '{}' }));
    await ndjson(await get('/api/pubmed/verificar', { method: 'POST', headers: bearer, body: '{}' }));
    await vivo.goto(`${base}/vivo`);
    await vivo.waitForSelector('#conexion.ok', { timeout: 10_000 }).catch(() => {});
    const conexion = await vivo.getAttribute('#conexion', 'class');
    comprobar(/\bok\b/.test(conexion ?? ''), `/vivo conectado por WebSocket (${conexion})`);
    await vivo.waitForSelector('#referencias:not([hidden]) li.si', { timeout: 10_000 });
    const texto = await vivo.innerText('body');
    comprobar(texto.includes('Ejercicio docente: referencias fabricadas a propósito'), 'etiqueta docente visible');
    comprobar((texto.match(/Ejercicio docente: referencia fabricada a propósito\. No la cite\./g) ?? []).length === 3, 'cada fabricada lleva su etiqueta');
    comprobar(!texto.includes('Early oseltamivir and time to return to work') && !texto.includes('ciad1893'), 'la cita inventada completa no está en la página');
    comprobar(await vivo.$('a[href="https://pubmed.ncbi.nlm.nih.gov/30184455/"]') !== null, 'la real enlaza a su PMID');
    comprobar(texto.includes(TEXTO_CLAUDE_SIMULADO), 'el resumen del modelo aparece');
    comprobar(texto.toLowerCase().includes('texto generado por ia sin verificar'), 'con su sello de texto sin verificar');
    comprobar(texto.includes('La referencia 1 no existe'), 'el resumen queda junto al veredicto de la referencia 1');
    comprobar(await vivo.innerText('#diapo-n') === '3' && (await vivo.innerText('#diapo-titulo')).length > 0, 'muestra la diapositiva actual');
    comprobar(texto.includes('<b>Hola</b> a todos'), 'el aviso se ve como texto plano, con sus etiquetas literales');
    const html = await vivo.content();
    comprobar(!/<b>Hola<\/b>/.test(html), 'sin HTML inyectado en el DOM');
    // Un evento nuevo llega en vivo, sin recargar.
    await get('/api/sala/diapositiva', { method: 'POST', headers: bearer, body: '{"n":4}' });
    const n = await esperar(async () => ((await vivo.innerText('#diapo-n')) === '4' ? '4' : null), 5000);
    comprobar(n === '4', 'la diapositiva cambia en vivo');
  }

  seccion('Navegador: /presentador');
  const presentador = await navegador.newContext({ viewport: { width: 1280, height: 800 } });
  const pres = await nuevaPagina(presentador);
  {
    await pres.goto(`${base}/presentador`);
    await pres.fill('#token', TOKEN);
    await Promise.all([pres.waitForNavigation(), pres.click('button[type="submit"]')]);
    await pres.waitForSelector('.slide.active');
    comprobar((await pres.$$('.slide')).length === 19, 'entra con el token y ve 19 diapositivas');
    comprobar((await pres.$$('.qr')).length === 2, 'el QR está en la portada y en el cierre');
    await pres.keyboard.press('ArrowRight');
    await pres.keyboard.press('ArrowRight');
    await pres.waitForSelector('#refs li');
    const n = await esperar(async () => ((await vivo.innerText('#diapo-n')) === '3' ? '3' : null), 5000);
    comprobar(n === '3', 'al pasar de diapositiva, el público la ve');
    await pres.click('#btn-sample');
    const salida = await esperar(async () => ((await pres.innerText('#sample-out')) === TEXTO_CLAUDE_SIMULADO ? true : null), 15_000);
    comprobar(salida === true, 'el botón de Claude muestra la respuesta en vivo');
    await pres.click('#btn-verify');
    const v1 = await esperar(async () => ((await pres.getAttribute('#v1', 'class'))?.includes('ok') ? true : null), 20_000);
    comprobar(v1 === true && (await pres.innerText('#v1')).includes('30184455'), 'la referencia 2 aparece con su PMID');
    await esperar(async () => ((await pres.innerText('#demo-status')).includes('terminada') ? true : null), 20_000);
    comprobar((await pres.getAttribute('#v2', 'class'))?.includes('no') && (await pres.innerText('#v2')).includes('No existe'), 'la referencia 3 sale como inexistente');
    await pres.keyboard.press('ArrowRight');
    await pres.waitForSelector('#chat.active #btn-chat:not([disabled])');
    await pres.click('#btn-chat');
    const chatListo = await esperar(async () => ((await pres.innerText('#chat-status')).includes('Ábralos antes de citarlos') ? true : null), 20_000);
    comprobar(chatListo === true && (await pres.$$('#chat-fuentes li')).length === 3, 'el chat con PubMed responde en vivo con sus tres fuentes');
    comprobar((await pres.innerText('#chat-out')).includes('[PMID 24811411]') && !(await pres.innerText('#chat-out')).includes('99999999'), 'con las citas revisadas');
    const enVivo = await esperar(async () => ((await vivo.$$('#chat-fuentes a')).length === 3 ? true : null), 10_000);
    comprobar(enVivo === true && !(await vivo.$eval('#chat', (e) => e.hidden)), '/vivo muestra el chat con sus tres fuentes enlazadas a PubMed');
    comprobar((await vivo.$('#chat-texto a[href="https://pubmed.ncbi.nlm.nih.gov/25640810/"]')) !== null, 'y cada PMID citado en el texto es un enlace');
    const tarjetaChat = (await vivo.innerText('#chat')).toLowerCase();
    comprobar(!tarjetaChat.includes('99999999') && tarjetaChat.includes('abra cada artículo antes de citarlo'), 'sin el PMID ajeno y con el sello de texto generado por IA');
    // CHARLA_CAPTURAS=<carpeta>: guarda cómo se ven la diapositiva y la tarjeta de /vivo.
    if (process.env.CHARLA_CAPTURAS) {
      await pres.screenshot({ path: path.join(process.env.CHARLA_CAPTURAS, 'diapositiva-4-chat.png') });
      await vivo.locator('#chat').screenshot({ path: path.join(process.env.CHARLA_CAPTURAS, 'vivo-chat.png') });
    }
    // De vuelta a la lista de cinco: el resto de la prueba usa sus botones.
    await pres.keyboard.press('ArrowLeft');
    await pres.waitForSelector('#demo.active');
    // La página publica la diapositiva con 300 ms de retraso. Hay que esperar a que la
    // sala la tenga: si no, en cuanto se abre el celular Chromium frena los temporizadores
    // de esta pestaña, que queda en segundo plano, y el «3» llega tarde, cuando la prueba
    // del mapa ya publicó la 9.
    const volvio = await esperar(async () => ((await vivo.innerText('#diapo-n')) === '3' ? true : null), 5000);
    comprobar(volvio === true, 'al volver a la lista de cinco, el público ve la diapositiva 3');
    await pres.keyboard.press('c');
    await pres.waitForSelector('#controles:not([hidden])');
    const estado = await esperar(async () => ((await pres.innerText('#c-estado')).includes('Clave de Anthropic: configurada') ? true : null), 10_000);
    comprobar(estado === true, 'el panel de controles muestra el estado');
    comprobar((await pres.innerText('#c-estado')).includes(`Respaldo de Claude: 30 de septiembre de 2026`), 'y las fechas de los respaldos');
  }

  seccion('Navegador: /vivo en un celular — mapa de pasos, votación y procesos');
  {
    const diapositiva = (n) => get('/api/sala/diapositiva', { method: 'POST', headers: bearer, body: JSON.stringify({ n }) });
    const texto = (pagina, selector) => pagina.$eval(selector, (e) => e.textContent ?? '');
    const oculto = (pagina, selector) => pagina.$eval(selector, (e) => e.hidden);
    comprobar((await get('/api/sala/reiniciar', { method: 'POST', headers: bearer, body: '{}' })).status === 200, 'sala limpia para un público nuevo');

    const telefono = await navegador.newContext({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });
    await telefono.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
    // Vigía dentro de la página: revisa el DOM tras CADA cambio, no solo al final, y
    // avisa aquí. Así se prueba «en ningún momento», no solo el estado que queda.
    const vigia = { dois: new Set(), antes: [], verificando: new Set(), buscando: new Set(), csp: [] };
    await telefono.exposeFunction('__e2eAviso', (tipo, dato) => {
      if (tipo === 'doi') vigia.dois.add(dato);
      else if (tipo === 'antes') vigia.antes.push(dato);
      else if (tipo === 'verificando') vigia.verificando.add(dato);
      else if (tipo === 'buscando') vigia.buscando.add(dato);
      else if (tipo === 'csp') vigia.csp.push(dato);
    });
    await telefono.addInitScript((dois) => {
      const avisados = new Set();
      const avisar = (tipo, dato) => {
        const clave = `${tipo}|${dato}`;
        if (avisados.has(clave)) return;
        avisados.add(clave);
        try {
          window.__e2eAviso(tipo, dato);
        } catch {
          // la página se cierra
        }
      };
      document.addEventListener('securitypolicyviolation', (e) => avisar('csp', `${e.violatedDirective} ${e.blockedURI}`));
      const revisar = () => {
        const html = document.documentElement ? document.documentElement.outerHTML : '';
        for (const d of dois) if (html.includes(d)) avisar('doi', d);
        for (const li of document.querySelectorAll('#refs > li')) {
          const sinVeredicto = li.classList.contains('verificando') || li.classList.contains('espera');
          if (li.classList.contains('verificando')) avisar('verificando', li.id);
          if (li.querySelector('.tramo.buscando')) avisar('buscando', li.id);
          if (sinVeredicto && li.querySelector('.cita, .consulta, .consulta-texto, .fabricada, a.repetir')) avisar('antes', `${li.id}: ${li.textContent}`);
        }
      };
      new MutationObserver(revisar).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
    }, DOIS_INVENTADOS);

    const tel = await nuevaPagina(telefono);
    const erroresTel = [];
    tel.on('console', (m) => {
      if (m.type() === 'error') erroresTel.push(m.text());
    });
    tel.on('pageerror', (e) => erroresTel.push(String(e)));
    const salientes = [];
    tel.on('request', (r) => {
      if (r.method() !== 'GET') salientes.push({ metodo: r.method(), ruta: new URL(r.url()).pathname, cuerpo: r.postData() });
    });
    const framesWs = [];
    tel.on('websocket', (w) => w.on('framesent', (f) => framesWs.push(String(f.payload))));

    await tel.goto(`${base}/vivo`);
    await tel.waitForSelector('#conexion.ok', { timeout: 10_000 });
    const datosVivo = JSON.parse(await texto(tel, '#datos-vivo'));
    comprobar(await oculto(tel, '#votacion'), 'sin votación abierta, la tarjeta de votación no se ve');

    // ------------------------------------------------ el mapa de los siete pasos
    comprobar((await tel.$$('#mapa-pasos details.paso')).length === 7 && (await tel.$('#mapa-pasos details.actual')) === null, 'el mapa trae los siete pasos y ninguno está en pantalla');
    comprobar((await oculto(tel, '#pasos')) && (await oculto(tel, '#kit-prompts')), 'antes de que la charla llegue al mapa, ni el mapa ni su atajo en el kit se ven');
    await diapositiva(3);
    await tel.waitForFunction(() => document.getElementById('diapo-n')?.textContent === '3', null, { timeout: 5000 }).catch(() => {});
    comprobar(await oculto(tel, '#pasos'), 'en la diapositiva 3, durante el ejercicio, el mapa sigue oculto');
    await diapositiva(9);
    const resaltado = await tel.waitForSelector('#pasos.resaltado', { timeout: 5000 }).catch(() => null);
    comprobar(resaltado !== null && (await tel.getAttribute('#diapo-paso-enlace', 'href')) === '#pasos', 'en la diapositiva 9 se resalta el mapa y el atajo lleva a él');
    const diag = await tel.evaluate(() => ({ n: document.getElementById('diapo-n')?.textContent, pasos: document.getElementById('pasos').hidden, kit: document.getElementById('kit-prompts').hidden, resaltado: document.getElementById('pasos').classList.contains('resaltado') }));
    comprobar(!(await oculto(tel, '#pasos')) && !(await oculto(tel, '#kit-prompts')), `y desde ahí se ven el mapa y su atajo en el kit ${JSON.stringify(diag)}`);
    await diapositiva(10);
    const actual = await tel.waitForSelector('#paso-1.actual', { timeout: 5000 }).catch(() => null);
    const paso1 = await tel.$eval('#paso-1', (d) => ({ abierto: d.open, marca: d.querySelector('.paso-marca')?.textContent }));
    comprobar(actual !== null && paso1.abierto && paso1.marca === 'En pantalla', 'tras publicar la diapositiva 10 se resalta y se abre el paso 01');
    comprobar(!(await tel.$eval('#pasos', (e) => e.classList.contains('resaltado'))) && (await tel.$$('#mapa-pasos details.actual')).length === 1, 'solo el paso 01 queda resaltado');
    comprobar(
      (await tel.getAttribute('#diapo-paso-enlace', 'href')) === '#paso-1' && (await texto(tel, '#diapo-paso-enlace')).includes('paso 01'),
      'el atajo de la diapositiva lleva al paso 01',
    );
    const botonCopiar = await tel.$('#paso-1 button.copiar');
    comprobar(botonCopiar !== null && (await botonCopiar.isVisible()), 'el botón de copiar el prompt del paso 01 existe y se ve');
    comprobar((await texto(tel, '#prompt-1')) === datosVivo.pasos[0].prompt && datosVivo.pasos[0].prompt.length > 20, 'con el prompt del paso 01 a la vista');
    if (botonCopiar) await botonCopiar.click();
    const avisoCopia = await esperar(async () => (await texto(tel, '#paso-1 .copiado')) || null, 3000, 100);
    const portapapeles = await tel.evaluate(() => navigator.clipboard.readText()).catch(() => null);
    comprobar(avisoCopia === 'Prompt copiado.' && portapapeles === datosVivo.pasos[0].prompt, `copiar deja el prompt en el portapapeles («${avisoCopia}»)`);
    await diapositiva(11);
    await tel.waitForSelector('#paso-2.actual', { timeout: 5000 }).catch(() => {});
    comprobar(await tel.$eval('#paso-1', (d) => d.classList.contains('visto') && !d.classList.contains('actual') && !d.open), 'con la 11, el paso 01 queda como visto y se cierra solo');

    // ------------------------------------------------ la votación desde el panel
    // La sala se reinició por la API y no desde este panel, que aún cree que el público
    // ve los veredictos de la verificación anterior (botón «Abrir» apagado). Al abrirse,
    // el panel vuelve a leer el estado: se cierra y se abre.
    comprobar(await pres.$eval('#c-votacion-abrir', (b) => b.disabled), 'tras la verificación, el panel tenía apagado «Abrir la votación»');
    if (!(await pres.$('#controles[hidden]'))) await pres.keyboard.press('c');
    await pres.keyboard.press('c');
    await pres.waitForSelector('#c-votacion-abrir:not([disabled])', { timeout: 10_000 });
    await pres.click('#c-votacion-abrir');
    // innerText y no textContent: el panel separa las líneas con <br>.
    const panelAbierta = await esperar(async () => {
      const t = await pres.innerText('#c-votacion-estado');
      return /Abierta · ronda \d+\n/.test(t) ? t : null;
    }, 10_000);
    const rondaVivo = Number(/ronda (\d+)/.exec(panelAbierta ?? '')?.[1]);
    comprobar(Boolean(panelAbierta), `el botón del panel abre la votación (ronda ${rondaVivo})`);
    // Si nadie vota (el Wi-Fi del público falla aunque el del portátil ande), el panel
    // lo dice solo a los 20 s: con la votación abierta y el panel a la vista se relee cada 5 s.
    const tAviso = Date.now();
    const sinVotos = await esperar(async () => ((await pres.innerText('#c-votacion-estado')).includes('Nadie ha votado en') ? true : null), 35_000, 500);
    const segAviso = (Date.now() - tAviso) / 1000;
    comprobar(
      sinVotos === true && /mano alzada/.test(await pres.innerText('#c-votacion-estado')),
      `sin votos, el panel sugiere la mano alzada (a los ${segAviso.toFixed(0)} s de abrir)`,
    );
    await tel.waitForSelector('#votacion.abierta', { timeout: 5000 }).catch(() => {});
    comprobar(
      (await tel.$$('#votos-lista li.voto')).length === 5 && (await tel.$$eval('#votos-lista .voto-resultado', (l) => l.every((x) => x.hidden))),
      'en /vivo aparecen las cinco para votar, sin porcentajes mientras está abierta',
    );
    comprobar(!/Lindqvist|Hayden|Moreau|Jefferson|Ferreira/.test(await texto(tel, '#votacion')), 'la votación muestra solo los números, sin las citas');

    await tel.click('li.voto[data-ref="1"] .voto-si');
    const marcado = await tel.waitForSelector('li.voto.votada[data-ref="1"] .voto-si[aria-pressed="true"]', { timeout: 5000 }).catch(() => null);
    await esperar(async () => ((await texto(tel, '#votacion-mensaje')).includes('Voto registrado') ? true : null), 5000, 100);
    const primerVoto = salientes.find((s) => s.ruta === '/api/sala/voto');
    const cuerpoVoto = primerVoto ? JSON.parse(primerVoto.cuerpo ?? 'null') : null;
    const votoBien =
      primerVoto?.metodo === 'POST' &&
      cuerpoVoto?.ref === 1 &&
      cuerpoVoto.existe === true &&
      cuerpoVoto.ronda === rondaVivo &&
      /^[A-Za-z0-9_-]{16,64}$/.test(cuerpoVoto.votante) &&
      Object.keys(cuerpoVoto).sort().join() === 'existe,ref,ronda,votante';
    comprobar(
      votoBien,
      `pulsar «Sí» envía {votante, ronda, ref, existe} por fetch a POST /api/sala/voto${votoBien ? '' : ` (${JSON.stringify(primerVoto ?? null)}, ronda ${rondaVivo})`}`,
    );
    comprobar(marcado !== null && (await texto(tel, 'li.voto[data-ref="1"] .voto-propio')) === 'Su voto: sí existe', 'y lo marca como su voto');
    await tel.click('li.voto[data-ref="1"] .voto-no');
    await tel.waitForSelector('li.voto[data-ref="1"] .voto-no[aria-pressed="true"]', { timeout: 5000 }).catch(() => {});
    comprobar(
      (await tel.getAttribute('li.voto[data-ref="1"] .voto-no', 'aria-pressed')) === 'true' && (await tel.getAttribute('li.voto[data-ref="1"] .voto-si', 'aria-pressed')) === 'false',
      'cambiar a «No» desmarca el «Sí»',
    );
    await tel.click('li.voto[data-ref="2"] .voto-si');
    await tel.waitForSelector('li.voto[data-ref="2"] .voto-si[aria-pressed="true"]', { timeout: 5000 }).catch(() => {});
    const ep = await (await get('/api/presentador/estado', { headers: bearer })).json();
    const k = (n) => ep.votacion?.conteos?.find((c) => c.ref === n);
    comprobar(k(1)?.si === 0 && k(1)?.no === 1 && k(2)?.si === 1 && k(2)?.no === 0 && ep.votacion.votantes === 1, 'el servidor cuenta un votante, con el cambio de la ref. 1 ya restado');
    const participacion = await esperar(async () => ((await texto(tel, '#votacion-participacion')).includes('2 votos') ? true : null), 5000);
    comprobar(participacion === true, 'la participación llega en vivo (2 votos en total)');
    const avisoFuera = await esperar(async () => (!(await pres.innerText('#c-votacion-estado')).includes('Nadie ha votado') ? true : null), 12_000, 500);
    comprobar(avisoFuera === true && (await pres.innerText('#c-votacion-estado')).includes('Total: 2 votos de 1 votante'), 'con los primeros votos, el aviso desaparece y el panel muestra los totales');

    await tel.reload();
    await tel.waitForSelector('#conexion.ok', { timeout: 10_000 });
    await tel.waitForSelector('li.voto[data-ref="2"] .voto-si[aria-pressed="true"]', { timeout: 5000 }).catch(() => {});
    comprobar(
      (await tel.getAttribute('li.voto[data-ref="1"] .voto-no', 'aria-pressed')) === 'true' && (await tel.getAttribute('li.voto[data-ref="2"] .voto-si', 'aria-pressed')) === 'true',
      'al recargar, el celular recuerda sus votos de esta ronda',
    );

    // Una red que acepta la conexión y no contesta (portal cautivo, NAT saturado): el
    // voto tiene plazo y los botones de esa referencia vuelven a funcionar.
    await tel.route('**/api/sala/voto', () => {
      // Sin continuar ni responder: la petición queda colgada.
    });
    const t0 = Date.now();
    await tel.click('li.voto[data-ref="3"] .voto-si');
    const apagados = await tel.$eval('li.voto[data-ref="3"] .voto-si', (b) => b.disabled);
    const enviando = await texto(tel, '#votacion-mensaje');
    const liberado = await esperar(async () => ((await texto(tel, '#votacion-mensaje')).startsWith('No se pudo confirmar su voto') ? true : null), 12_000, 200);
    const segVoto = (Date.now() - t0) / 1000;
    const activos = await tel.$eval('li.voto[data-ref="3"] .voto-si', (b) => !b.disabled);
    comprobar(
      apagados && enviando === 'Enviando su voto…' && liberado === true && activos && segVoto >= 7 && segVoto < 12,
      `con la red colgada, a los ${segVoto.toFixed(1)} s el voto se da por no confirmado y los botones vuelven a funcionar`,
    );
    comprobar((await texto(tel, 'li.voto[data-ref="3"] .voto-propio')) === 'Todavía no ha votado.', 'y la referencia no queda marcada como votada');
    await tel.unroute('**/api/sala/voto');

    // ------------------------------------------------ Claude, PubMed y la comparación
    await ndjson(await get('/api/claude/resumen', { method: 'POST', headers: bearer, body: '{}' }));
    await tel.waitForSelector('#resumen:not([hidden])', { timeout: 5000 }).catch(() => {});
    comprobar(
      !(await tel.$('#resumen.lado-a-lado')) && (await oculto(tel, '#col-pubmed')) && (await oculto(tel, '#resumen-titular')),
      'con el resumen y sin veredicto todavía no hay comparación',
    );

    // El botón del presentador: el panel se cierra para no tapar la diapositiva.
    await pres.keyboard.press('c');
    await pres.waitForSelector('#controles', { state: 'hidden' });
    await pres.click('#btn-verify');
    await tel.waitForSelector('#ref-5.no', { timeout: 20_000 }).catch(() => {});
    await pres.waitForSelector('#btn-verify:not([disabled])', { timeout: 20_000 }).catch(() => {});

    comprobar(vigia.verificando.size > 0 && vigia.buscando.size > 0, `se vio la verificación en curso (${vigia.verificando.size} referencias «verificando», ${vigia.buscando.size} con una búsqueda en marcha)`);
    comprobar(vigia.antes.length === 0, vigia.antes.length ? `antes del veredicto se vio: ${vigia.antes[0]}` : 'antes del veredicto no se ve ni la cita ni el texto de las consultas');

    await tel.waitForSelector('#votacion:not(.abierta)', { timeout: 5000 }).catch(() => {});
    const votos = await tel.$$eval('#votos-lista li.voto', (lis) =>
      lis.map((li) => ({
        clases: li.className.split(/\s+/),
        botonesOcultos: li.querySelector('.voto-botones').hidden,
        resultadoVisible: !li.querySelector('.voto-resultado').hidden,
        cifra: li.querySelector('.voto-cifra').textContent,
        propio: li.querySelector('.voto-propio').textContent,
        ancho: li.querySelector('.relleno').style.width,
      })),
    );
    comprobar(votos.length === 5 && votos.every((v) => v.botonesOcultos && v.resultadoVisible), 'verificar cierra la votación en /vivo: sin botones y con los resultados');
    comprobar(
      votos[0]?.clases.includes('no-existe') && votos[0].cifra === 'El 0 % creyó que existía (1 voto) · PubMed: no existe' && votos[0].ancho === '0%',
      `ref. 1: «${votos[0]?.cifra}»`,
    );
    comprobar(
      votos[1]?.clases.includes('existe') && votos[1].cifra === 'El 100 % creyó que existía (1 voto) · PubMed: existe' && votos[1].ancho === '100%',
      `ref. 2: «${votos[1]?.cifra}»`,
    );
    comprobar(votos[0]?.propio === 'Su voto: no existe · acertó' && votos[1]?.propio === 'Su voto: sí existe · acertó', 'cada quien ve si acertó');

    const refs = await tel.$$eval('#refs > li', (lis) =>
      lis.map((li) => ({
        id: li.id,
        clases: li.className.split(/\s+/),
        cita: li.querySelector('.cita')?.textContent ?? null,
        veredicto: li.querySelector('.veredicto')?.textContent ?? null,
        fabricada: li.querySelector('.fabricada')?.textContent ?? null,
        tramos: [...li.querySelectorAll('li.tramo')].map((t) => ({
          via: t.dataset.via,
          clases: t.className.split(/\s+/),
          consulta: t.querySelector('.consulta-texto')?.textContent ?? null,
          sinTexto: Boolean(t.querySelector('.consulta-texto.sin-texto')),
          repetir: t.querySelector('a.repetir')?.getAttribute('href') ?? null,
        })),
      })),
    );
    const ref1 = refs.find((r) => r.id === 'ref-1');
    const ref2 = refs.find((r) => r.id === 'ref-2');
    const q1 = datosVivo.referencias[0].consultas;
    const q2 = datosVivo.referencias[1].consultas;
    const tramo = (r, via) => r?.tramos.find((t) => t.via === via);
    const pubmedTerm = (q) => `https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(q)}`;
    comprobar(
      refs.length === 5 && refs.every((r) => (r.clases.includes('si') || r.clases.includes('no')) && r.veredicto && r.tramos.some((t) => t.consulta)),
      'las cinco tienen veredicto y, en la misma tarjeta, las consultas que lo sostienen',
    );
    comprobar(
      ref1?.clases.includes('no') &&
        ref1.cita === datosVivo.referencias[0].corta &&
        ref1.fabricada === 'Ejercicio docente: referencia fabricada a propósito. No la cite.' &&
        ref1.tramos.map((t) => t.via).join() === 'titulo,doi,autor' &&
        ref1.tramos.every((t) => t.clases.includes('hecho')),
      'ref. 1: fabricada, en forma corta y con su etiqueta; tubería completa por título, DOI y autor',
    );
    comprobar(
      tramo(ref1, 'titulo')?.consulta === q1.titulo && tramo(ref1, 'titulo')?.repetir === pubmedTerm(q1.titulo) && tramo(ref1, 'autor')?.consulta === q1.autor,
      'ref. 1: consultas exactas por título y autor, con enlace para repetirlas',
    );
    comprobar(
      tramo(ref1, 'doi')?.sinTexto && tramo(ref1, 'doi')?.consulta === 'el DOI citado' && tramo(ref1, 'doi')?.repetir === null,
      'ref. 1: de la búsqueda por DOI solo dice «el DOI citado», sin enlace',
    );
    comprobar(
      ref2?.clases.includes('si') &&
        tramo(ref2, 'titulo')?.clases.includes('coincide') &&
        tramo(ref2, 'titulo')?.consulta === q2.titulo &&
        tramo(ref2, 'titulo')?.repetir === pubmedTerm(q2.titulo) &&
        tramo(ref2, 'doi')?.clases.includes('omitido') &&
        tramo(ref2, 'autor')?.clases.includes('omitido'),
      'ref. 2: coincide por título y los otros dos pasos no hicieron falta',
    );
    comprobar(refs.filter((r) => r.fabricada).length === 3 && refs.filter((r) => r.fabricada).every((r) => r.clases.includes('no')), 'las tres fabricadas, cada una junto a su veredicto y su etiqueta');

    await tel.waitForSelector('#resumen.lado-a-lado', { timeout: 5000 }).catch(() => {});
    const comparacion = await tel.evaluate(() => {
      const $ = (id) => document.getElementById(id);
      return {
        lado: $('resumen').classList.contains('lado-a-lado'),
        pubmed: !$('col-pubmed').hidden,
        titular: $('resumen-titular').hidden ? null : $('resumen-titular').textContent,
        falso: $('resumen-titular').classList.contains('falso'),
        veredicto: !$('resumen-veredicto').hidden,
        detalle: $('pubmed-detalle').textContent,
        modelo: $('resumen-texto').textContent,
      };
    });
    comprobar(
      comparacion.lado && comparacion.pubmed && comparacion.falso && comparacion.veredicto && comparacion.titular === 'El modelo resumió con seguridad un artículo que no existe.',
      'con el resumen y el veredicto de la ref. 1, aparece la comparación lado a lado',
    );
    comprobar(
      comparacion.detalle.includes('Referencia 1') && !comparacion.detalle.includes('Lindqvist') && comparacion.modelo === TEXTO_CLAUDE_SIMULADO,
      'la columna de PubMed dice solo el número de la referencia, junto al texto del modelo',
    );

    await pres.keyboard.press('c');
    const panelCerrada = await esperar(async () => {
      const t = await pres.innerText('#c-votacion-estado');
      return t.includes(`Cerrada · ronda ${rondaVivo} · totales finales\n`) ? t : null;
    }, 10_000);
    comprobar(
      Boolean(panelCerrada) && panelCerrada.includes('\n1: 0 sí · 1 no\n') && panelCerrada.includes('\n2: 1 sí · 0 no\n') && panelCerrada.includes('\nTotal: 2 votos de 1 votante'),
      `el panel muestra la votación cerrada con los totales finales${panelCerrada ? '' : ` («${(await pres.innerText('#c-votacion-estado')).replace(/\n/g, ' / ')}»)`}`,
    );
    const avisoVeredictos = await esperar(
      async () => ((await pres.innerText('#c-votacion-estado')).endsWith('para votar otra vez, reinicie la sala.') ? true : null),
      10_000,
    );
    comprobar(
      avisoVeredictos === true && (await pres.$eval('#c-votacion-abrir', (b) => b.disabled)) && !(await pres.$eval('#c-votacion-cerrar', (b) => b.disabled)),
      'con los veredictos a la vista, el panel lo dice y apaga «Abrir la votación»',
    );

    // ------------------------------------------------ Evidentia: el embudo
    const lanzada = await get('/api/evidentia/lanzar', { method: 'POST', headers: bearer, body: '{}' });
    comprobar(lanzada.status === 200, 'Evidentia lanzada con /vivo abierta');
    await tel.waitForSelector('#evidentia:not([hidden])', { timeout: 5000 }).catch(() => {});
    comprobar((await oculto(tel, '#embudo')) && !(await oculto(tel, '#embudo-espera')), 'mientras Evidentia trabaja, el embudo espera sus cifras');
    await tel.waitForSelector('#embudo:not([hidden]) li.escalon', { timeout: 30_000 }).catch(() => {});
    const escalones = () =>
      tel.$$eval('#embudo li.escalon', (ls) =>
        ls.map((l) => ({
          clave: l.dataset.escalon,
          cifra: l.querySelector('.escalon-cifra')?.textContent,
          detalle: l.querySelector('.escalon-detalle')?.textContent ?? '',
          ancho: l.querySelector('.relleno')?.style.width,
        })),
      );
    const vivoEmbudo = await escalones();
    comprobar(
      vivoEmbudo.map((e) => `${e.clave}=${e.cifra}`).join() === 'encontradas=43,unicas=38,comprobadas=20,afirmaciones=2',
      `cuando Evidentia termina en el simulador aparece el embudo (${vivoEmbudo.map((e) => e.cifra).join(' → ')})`,
    );
    comprobar(
      vivoEmbudo[0]?.detalle === 'PubMed 31 · Europe PMC 12' && vivoEmbudo[2]?.detalle === 'Ninguna retractada' && vivoEmbudo[3]?.detalle === '1 espera revisión humana',
      'con el detalle de cada escalón',
    );
    comprobar(vivoEmbudo[0]?.ancho === '100%' && vivoEmbudo[3]?.ancho === '5%', 'barras proporcionales, con el ancho puesto por CSSOM');
    comprobar((await oculto(tel, '#embudo-ensayo')) && (await oculto(tel, '#embudo-espera')), 'el embudo en vivo no lleva la etiqueta de ensayo');

    await sim.modo({ evidentia: 'caido' });
    await get('/api/evidentia/lanzar', { method: 'POST', headers: bearer, body: '{}' });
    await tel.waitForSelector('#embudo-ensayo:not([hidden])', { timeout: 5000 }).catch(() => {});
    const ensayoEmbudo = await escalones();
    comprobar(
      (await texto(tel, '#embudo-ensayo')) === 'Cifras del ensayo del 30 de septiembre de 2026' &&
        ensayoEmbudo.map((e) => `${e.clave}=${e.cifra}`).join() === 'encontradas=40,unicas=34,comprobadas=18,afirmaciones=3' &&
        ensayoEmbudo[2]?.detalle === '1 retractada',
      'si Evidentia falla, el embudo del ensayo aparece con su etiqueta y su fecha',
    );
    await sim.modo({ evidentia: 'ok' });

    // ------------------------------------------------ lo que /vivo envía y lo que no
    const html = await tel.content();
    comprobar(
      vigia.dois.size === 0 && DOIS_INVENTADOS.every((d) => !html.includes(d)),
      vigia.dois.size ? `DOI inventado en el DOM: ${[...vigia.dois].join(', ')}` : 'ningún DOI inventado apareció en el DOM en ningún momento',
    );
    comprobar(framesWs.every((f) => f === 'ping'), `por el WebSocket /vivo solo envía «ping» (${framesWs.length} mensajes)`);
    const otros = salientes.filter((s) => !(s.metodo === 'POST' && s.ruta === '/api/sala/voto'));
    // Cuatro intentos: tres votos y el que se quedó colgado a propósito.
    comprobar(otros.length === 0 && salientes.length === 4, `lo único que /vivo envía al servidor son los votos (${salientes.length} POST a /api/sala/voto)`);
    comprobar(vigia.csp.length === 0, vigia.csp.length ? `violaciones de CSP en /vivo: ${vigia.csp.join(' | ')}` : 'sin violaciones de CSP en /vivo');
    const erroresVivo = erroresTel.filter((e) => !/favicon/i.test(e));
    comprobar(erroresVivo.length === 0, erroresVivo.length ? `errores de consola en /vivo: ${erroresVivo.join(' | ')}` : 'sin errores de consola en /vivo');
    await telefono.close();
  }

  seccion('Navegador: copia sin red');
  {
    const sinRed = await navegador.newContext({ viewport: { width: 1280, height: 800 } });
    const pagina = await nuevaPagina(sinRed);
    const peticiones = [];
    pagina.on('request', (r) => {
      if (!r.url().startsWith('file:')) peticiones.push(r.url());
    });
    await pagina.goto(`file://${path.join(tmp, 'sin-red.html')}`);
    await pagina.waitForSelector('.slide.active');
    await pagina.keyboard.press('ArrowRight');
    await pagina.keyboard.press('ArrowRight');
    await pagina.click('#btn-sample');
    // textContent y no innerText: la etiqueta se ve en mayúsculas por CSS.
    const etiqueta = () => pagina.$eval('#sample-label', (e) => e.textContent ?? '');
    await esperar(async () => ((await etiqueta()).includes('Respuesta de ensayo') ? true : null), 5000);
    comprobar((await etiqueta()).includes('grabada el 30 de septiembre de 2026'), 'sin red, Claude muestra la respuesta de ensayo con fecha');
    comprobar((await pagina.innerText('#sample-out')) === TEXTO_ENSAYO, 'con el texto grabado');
    await pagina.click('#btn-verify');
    await esperar(async () => ((await pagina.innerText('#v1')).includes('ensayo') ? true : null), 5000);
    comprobar((await pagina.innerText('#v1')).includes('Resultado del ensayo del 30 de septiembre de 2026'), 'sin red, PubMed muestra los resultados del ensayo etiquetados');
    comprobar((await pagina.getAttribute('#v0', 'class'))?.includes('no') && (await pagina.getAttribute('#v3', 'class'))?.includes('ok'), 'con los veredictos correctos');
    const fuentes = await pagina.evaluate(() => document.fonts.check("16px 'IBM Plex Sans'") && document.fonts.check("16px 'Source Serif 4'"));
    comprobar(fuentes === true, 'las fuentes están embebidas');
    comprobar(peticiones.length === 0, `sin red no sale ninguna petición (${peticiones.length})`);
    await sinRed.close();
  }

  // El 401 es la propia página de entrada; el favicon.ico lo pide Chromium por su cuenta.
  // ---------------------------------------------------------------- límites de tasa
  // Al final: el límite de la entrada es por IP y bloquearía las pruebas anteriores.
  seccion('Límite de tasa de la entrada');
  {
    let primer429 = null;
    for (let i = 1; i <= 14; i++) {
      const r = await get('/presentador/entrar', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' },
        body: 'token=token-equivocado-para-agotar-el-limite-de-entrada',
      });
      if (r.status === 429) {
        primer429 = i;
        comprobar(r.headers.get('retry-after') === '10', 'el 429 lleva retry-after');
        break;
      }
    }
    comprobar(primer429 !== null && primer429 <= 11, primer429 ? `el intento ${primer429} de entrar con token equivocado ya recibe 429` : 'el límite de la entrada no actuó en 14 intentos');
    const publico = await get('/vivo');
    comprobar(publico.status === 200, 'el límite de la entrada no afecta a /vivo');
    // Un vecino de Wi-Fi que agota el cupo no deja fuera al ponente: el token correcto entra igual.
    const correcto = await get('/presentador/entrar', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' },
      body: `token=${encodeURIComponent(TOKEN)}`,
    });
    comprobar(correcto.status === 303 && (correcto.headers.get('set-cookie') ?? '').startsWith('presentador-local='), 'con el cupo agotado, el token correcto sigue entrando');
    const bearerAgotado = await get('/api/presentador/estado', { headers: { authorization: 'Bearer otro-token-largo-que-no-es-el-bueno' } });
    comprobar(bearerAgotado.status === 429, 'con el cupo agotado, un Bearer equivocado recibe 429');
    const bearerBueno = await get('/api/presentador/estado', { headers: { authorization: `Bearer ${TOKEN}` } });
    comprobar(bearerBueno.status === 200, 'y el Bearer correcto sigue entrando');
  }

  const relevantes = erroresConsola.filter((e) => !/favicon|status of 401/i.test(e));
  comprobar(relevantes.length === 0, relevantes.length ? `errores de consola: ${relevantes.join(' | ')}` : 'sin errores de consola ni de CSP en el navegador');
} catch (error) {
  fallos.push(`excepción: ${error?.stack ?? error}`);
  console.error(error);
} finally {
  if (navegador) await navegador.close().catch(() => {});
  if (wrangler?.pid) {
    try {
      process.kill(-wrangler.pid, 'SIGTERM');
    } catch {
      // ya cerrado
    }
  }
  await sim.cerrar();
  delete process.env.CHARLA_RESPALDOS;
  await construir();
}

console.log(`\n${pasadas} comprobaciones pasaron, ${fallos.length} fallaron.`);
for (const f of fallos) console.log(`  ✗ ${f}`);
process.exit(fallos.length ? 1 : 0);
