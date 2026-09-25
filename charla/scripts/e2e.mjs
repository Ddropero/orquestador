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
const FECHA_ENSAYO = '2026-09-30';

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
    evidentia: { runId: 'ensayo-e2e', fecha: FECHA_ENSAYO },
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
    comprobar(cuerpo.includes('Ejercicio docente: referencias fabricadas a propósito'), '/vivo lleva la etiqueta docente');
    comprobar(!cuerpo.includes('10.1093/cid/ciad1893') && !cuerpo.includes('Early oseltamivir and time to return'), '/vivo no lleva las citas inventadas completas');
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
    comprobar(p.status === 200 && (html.match(/<section class="slide/g) ?? []).length === 18, '/presentador con sesión: 18 diapositivas');
    comprobar((p.headers.get('content-security-policy') ?? '').includes("'sha256-"), '/presentador con CSP por hash');
    comprobar(p.headers.get('x-charla-pagina') === 'presentador' && (p.headers.get('cache-control') ?? '').includes('no-store'), '/presentador marcada y sin caché');
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

  // ---------------------------------------------------------------- Evidentia
  seccion('Demo 2: Evidentia');
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
    const est = await (await get('/api/sala/estado')).json();
    comprobar(!JSON.stringify(est.eventos).includes('sulfadiazina'), 'ningún texto del resultado llega al público');
    const en = await (await get('/api/presentador/estado', { headers: bearer })).json();
    comprobar(en.evidentia?.terminado === true && en.evidentia.resultado === 'completo', 'el presentador ve el run terminado');
  }

  seccion('Demo 2: Evidentia caída');
  {
    await sim.modo({ evidentia: 'caido' });
    comprobar((await get('/api/sala/reiniciar', { method: 'POST', headers: bearer, body: '{}' })).status === 200, 'reiniciar la sala');
    const r = await get('/api/evidentia/lanzar', { method: 'POST', headers: bearer, body: '{}' });
    comprobar(r.status === 502, 'lanzar con Evidentia caída → 502');
    const est = await (await get('/api/sala/estado')).json();
    comprobar(est.eventos.some((e) => e.tipo === 'evidentia_etapa' && e.estado === 'falló'), 'el público ve la etapa fallida');
    const en = await (await get('/api/presentador/estado', { headers: bearer })).json();
    comprobar(en.evidentiaSalud !== 'ok', 'el presentador ve que Evidentia no responde');
    await sim.modo({ evidentia: 'ok' });
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
    comprobar((await pres.$$('.slide')).length === 18, 'entra con el token y ve 18 diapositivas');
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
    await pres.keyboard.press('c');
    await pres.waitForSelector('#controles:not([hidden])');
    const estado = await esperar(async () => ((await pres.innerText('#c-estado')).includes('Clave de Anthropic: configurada') ? true : null), 10_000);
    comprobar(estado === true, 'el panel de controles muestra el estado');
    comprobar((await pres.innerText('#c-estado')).includes(`Respaldo de Claude: 30 de septiembre de 2026`), 'y las fechas de los respaldos');
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
