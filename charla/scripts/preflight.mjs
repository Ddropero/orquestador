#!/usr/bin/env node
/**
 * Comprobación del despliegue, desde fuera, como la vería el público y el ponente.
 *
 *   node scripts/preflight.mjs https://charla.davidduque.com
 *   PRESENTER_TOKEN=... node scripts/preflight.mjs https://charla.davidduque.com   (añade las del presentador)
 *
 * Sale con 1 si algo bloqueante falla. Es la lista de la sección 9 del plan, en
 * la parte que se puede automatizar; la prueba con el celular sigue siendo manual.
 */
const base = (process.argv[2] ?? '').replace(/\/+$/, '');
if (!base) {
  console.error('Uso: node scripts/preflight.mjs https://charla.davidduque.com');
  process.exit(2);
}
const token = process.env.PRESENTER_TOKEN;
const fallos = [];
const ok = (m) => console.log(`✓ ${m}`);
const mal = (m) => {
  console.log(`✗ ${m}`);
  fallos.push(m);
};

async function medir(ruta, init) {
  const t = performance.now();
  const res = await fetch(`${base}${ruta}`, { redirect: 'manual', ...init });
  const cuerpo = await res.text();
  return { res, cuerpo, ms: Math.round(performance.now() - t) };
}

// /vivo: la página del QR, rápida y con sus cabeceras.
{
  const { res, cuerpo, ms } = await medir('/vivo');
  res.status === 200 ? ok(`/vivo responde 200 en ${ms} ms`) : mal(`/vivo responde ${res.status}`);
  ms < 3000 ? ok('/vivo carga en menos de 3 s (sin contar el celular)') : mal(`/vivo tardó ${ms} ms`);
  const csp = res.headers.get('content-security-policy') ?? '';
  csp.includes("script-src 'self'") && !csp.includes('unsafe-inline') ? ok('/vivo con CSP estricto') : mal(`/vivo sin CSP estricto: ${csp}`);
  cuerpo.includes('Ejercicio docente: referencias fabricadas a propósito') ? ok('/vivo lleva la etiqueta docente') : mal('/vivo sin etiqueta docente');
  for (const doi of ['10.1093/cid/ciad1893', '10.1016/j.jinf.2021.06.041', '10.1016/S1473-3099(22)00614-5']) {
    if (cuerpo.includes(doi)) mal(`/vivo expone el DOI inventado ${doi}`);
  }
  res.headers.get('x-frame-options') === 'DENY' ? ok('x-frame-options: DENY') : mal('falta x-frame-options');
}

// El estado público y el WebSocket.
{
  const { res, cuerpo, ms } = await medir('/api/sala/estado');
  res.status === 200 && Array.isArray(JSON.parse(cuerpo).eventos) ? ok(`/api/sala/estado responde en ${ms} ms`) : mal(`/api/sala/estado: ${res.status}`);
}
try {
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/api/sala/ws`);
  await new Promise((resolver, rechazar) => {
    const t = setTimeout(() => rechazar(new Error('sin respuesta en 5 s')), 5000);
    ws.onopen = () => {
      clearTimeout(t);
      resolver();
    };
    ws.onerror = () => rechazar(new Error('error de conexión'));
  });
  const cierre = await new Promise((resolver) => {
    ws.onclose = (e) => resolver(e.code);
    ws.send('hola');
    setTimeout(() => resolver(null), 3000);
  });
  cierre === 1008 ? ok('el WebSocket público es de solo lectura (cierra con 1008 al escribir)') : mal(`el WebSocket no cerró al escribir (código ${cierre})`);
} catch (e) {
  mal(`WebSocket /api/sala/ws: ${e.message} (el sondeo cada 5 s sigue funcionando)`);
}

// Lo privado no se ve.
for (const ruta of ['/_privado/presentador.html', '/_privado/respaldos.json', '/presentador.html', '/base/charla-ia-investigacion.html', '/datos/config.json', '/src/index.ts', '/wrangler.jsonc']) {
  const { res } = await medir(ruta);
  res.status === 404 ? ok(`${ruta} → 404`) : mal(`${ruta} responde ${res.status}`);
}
{
  const { res } = await medir('/presentador');
  res.status === 401 ? ok('/presentador sin sesión pide el token (401)') : mal(`/presentador sin sesión responde ${res.status}`);
  const { res: r2 } = await medir('/api/claude/resumen', { method: 'POST', body: '{}' });
  r2.status === 401 ? ok('POST /api/claude/resumen sin sesión → 401') : mal(`POST /api/claude/resumen sin sesión → ${r2.status}`);
  const { res: r3 } = await medir('/api/sala/aviso', { method: 'POST', body: '{"texto":"x"}' });
  r3.status === 401 ? ok('POST /api/sala/aviso sin sesión → 401') : mal(`POST /api/sala/aviso sin sesión → ${r3.status}`);
}

// Con el token: configuración y respaldos.
if (token) {
  const { res, cuerpo } = await medir('/api/presentador/estado', { headers: { authorization: `Bearer ${token}` } });
  if (res.status !== 200) mal(`/api/presentador/estado con token → ${res.status}`);
  else {
    const d = JSON.parse(cuerpo);
    d.configuracion.claveAnthropic ? ok('ANTHROPIC_API_KEY configurada') : mal('falta ANTHROPIC_API_KEY');
    d.configuracion.tokenSeguro ? ok('PRESENTER_TOKEN con longitud suficiente') : mal('PRESENTER_TOKEN demasiado corto');
    d.respaldos.claude ? ok(`respaldo de Claude del ${d.respaldos.claude}`) : mal('sin respaldo de Claude grabado');
    d.respaldos.pubmed ? ok(`respaldo de PubMed del ${d.respaldos.pubmed}`) : mal('sin respaldo de PubMed grabado');
    d.respaldos.evidentia ? ok('respaldo de Evidentia grabado') : mal('sin respaldo de Evidentia grabado');
    d.evidentiaSalud === 'ok' ? ok('Evidentia responde en /health') : mal(`Evidentia: ${d.evidentiaSalud}`);
    console.log(`  Consultas a Claude hoy: ${d.claudeHoy} de ${d.limiteClaudeDiario}. Costo registrado: US$ ${d.costos.usd}.`);
  }
} else {
  console.log('  (sin PRESENTER_TOKEN: se omiten las comprobaciones del presentador)');
}

console.log(fallos.length ? `\n${fallos.length} bloqueante(s).` : '\nTodo en orden.');
process.exit(fallos.length ? 1 : 0);
