#!/usr/bin/env node
/**
 * Construye `public/` y `src/generado/` a partir de:
 *   - base/charla-ia-investigacion.html  (la presentación original, intacta)
 *   - web/*                              (scripts y páginas propias)
 *   - datos/*.json                       (contenido, configuración y respaldos)
 *
 * La presentación se porta SIN cambios visuales: cada reemplazo sobre la base se
 * hace con `unaVez`, que falla si el texto buscado no aparece exactamente una vez.
 * Si alguien edita la base y un ancla desaparece, la construcción se detiene en vez
 * de publicar algo distinto sin avisar.
 */
import { readFile, writeFile, mkdir, rm, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const qrcode = require('qrcode-generator');

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const r = (...p) => path.join(RAIZ, ...p);

const leer = (p) => readFile(r(p), 'utf8');
const leerJson = async (p) => JSON.parse(await leer(p));

function unaVez(texto, buscar, reemplazo) {
  const partes = texto.split(buscar);
  if (partes.length !== 2) {
    throw new Error(`Se esperaba exactamente una aparición de:\n${buscar}\n(encontradas: ${partes.length - 1})`);
  }
  return partes[0] + reemplazo + partes[1];
}

/** JSON seguro dentro de <script type="application/json">. */
function jsonEmbebido(valor) {
  return JSON.stringify(valor).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function sha256Base64(texto) {
  return createHash('sha256').update(texto, 'utf8').digest('base64');
}

/** QR en SVG, con margen de 4 módulos y bordes nítidos para que escanee desde lejos. */
export function qrSvg(texto, etiqueta) {
  const qr = qrcode(0, 'M');
  qr.addData(texto);
  qr.make();
  const n = qr.getModuleCount();
  const margen = 4;
  let d = '';
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (qr.isDark(y, x)) d += `M${x + margen} ${y + margen}h1v1h-1z`;
    }
  }
  const lado = n + margen * 2;
  return (
    `<svg class="qr" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${lado} ${lado}" role="img" aria-label="${etiqueta}" shape-rendering="crispEdges">` +
    `<rect width="${lado}" height="${lado}" fill="#FFFFFF"/><path d="${d}" fill="#0F1B2D"/></svg>`
  );
}

async function fuentesEmbebidas() {
  const b64 = async (p) => (await readFile(r('node_modules', p))).toString('base64');
  const plex = (peso) => `@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-${peso}-normal.woff2`;
  const caras = [
    ["'IBM Plex Sans'", 'normal', '400', await b64(plex(400))],
    ["'IBM Plex Sans'", 'normal', '500', await b64(plex(500))],
    ["'IBM Plex Sans'", 'normal', '600', await b64(plex(600))],
    ["'Source Serif 4'", 'normal', '400 700', await b64('@fontsource-variable/source-serif-4/files/source-serif-4-latin-wght-normal.woff2')],
    ["'Source Serif 4'", 'italic', '400 700', await b64('@fontsource-variable/source-serif-4/files/source-serif-4-latin-wght-italic.woff2')],
  ];
  return caras
    .map(
      ([familia, estilo, peso, datos]) =>
        `@font-face{font-family:${familia};font-style:${estilo};font-weight:${peso};font-display:swap;src:url(data:font/woff2;base64,${datos}) format('woff2');}`,
    )
    .join('\n');
}

const ESTILOS_CHARLA = `
  /* Añadidos para la versión en vivo. Nada de esto cambia el aspecto de las diapositivas. */
  .qr-vivo{ display:flex; gap:clamp(10px,1.4vw,18px); align-items:center; }
  .qr-vivo .qr{ display:block; background:#fff; border-radius:8px; }
  .qr-vivo p{ font-size:clamp(12px,1.5vw,18px); line-height:1.35; }
  .qr-vivo b{ font-weight:600; }
  #stage > .slide:first-child{ position:relative; }
  /* Grande y lejos del borde: la esquina es lo primero que recorta un proyector. */
  .qr-portada{ position:absolute; right:clamp(48px,7vw,110px); bottom:clamp(110px,16vh,180px); }
  .qr-portada .qr{ width:clamp(140px,24vh,260px); height:auto; }
  .qr-portada p{ color:var(--deep-body); max-width:15em; }
  .qr-portada b{ color:var(--deep-ink); }
  .qr-cierre .qr{ width:clamp(140px,26vh,260px); height:auto; border:1px solid var(--line); }
  .qr-cierre p{ color:var(--body); max-width:18em; }
  .qr-cierre b{ color:var(--ink); }
  @media (max-width: 900px){ .qr-portada{ position:static; } }
  .verdict .ensayo{ color:var(--gold); font-weight:600; }
  .bar .punto{ width:10px; height:10px; border-radius:50%; background:var(--soft); display:inline-block; }
  .bar .punto.ok{ background:#2F6B3A; }
  .bar .punto.error{ background:#C9A45C; }
  .bar .punto.sesion{ background:var(--alert); }
  .controles{ position:fixed; top:12px; right:12px; bottom:calc(64px + env(safe-area-inset-bottom,0px)); width:min(440px, calc(100vw - 24px));
    overflow-y:auto; background:var(--deep); color:var(--deep-body); border-radius:14px; padding:16px 18px; z-index:10;
    display:flex; flex-direction:column; gap:14px; font-size:14px; line-height:1.45; box-shadow:0 10px 30px rgba(0,0,0,.35); }
  .controles[hidden]{ display:none; }
  .controles h4{ margin:0 0 6px; color:var(--glow); font-size:12px; letter-spacing:.14em; text-transform:uppercase; }
  .controles p, .controles li{ font-size:14px; color:var(--deep-body); }
  .controles ul{ padding-left:1.1em; gap:.25em; }
  .controles li.alerta{ color:#F2B8A8; font-weight:600; }
  .controles a{ color:var(--glow); }
  .controles .fila{ display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  .controles button{ font-size:13px; padding:7px 14px; background:var(--deep-ink); color:var(--deep); border-color:var(--deep-ink); }
  .controles button.ghost{ background:transparent; color:var(--deep-ink); }
  .controles input{ font:inherit; font-size:14px; flex:1; min-width:10em; padding:7px 10px; border-radius:8px; border:1px solid #3A4E6B; background:#16263D; color:var(--deep-ink); }
  .controles-cab{ display:flex; justify-content:space-between; align-items:center; color:var(--deep-ink); }
  .controles form{ margin:0; }
`;

const CONTROLES = `
<div class="controles" id="controles" hidden>
  <div class="controles-cab"><b>Controles del presentador</b><button class="ghost" id="cerrar-controles" type="button">Cerrar</button></div>
  <section><h4>Estado</h4><ul id="c-estado"><li>Comprobando…</li></ul></section>
  <section>
    <h4>Evidentia</h4>
    <p>Lance la pregunta de la miel antes de subir a la tarima: tarda entre 2 y 8 minutos. Sin red, ninguno de los dos enlaces abre: use el PDF del ensayo guardado en el escritorio.</p>
    <div class="fila"><button id="c-evidentia" type="button">Lanzar la pregunta de la miel</button></div>
    <p id="c-evidentia-estado"></p>
    <p><a id="c-evidentia-vivo" target="_blank" rel="noopener" hidden>Abrir el resultado en vivo</a></p>
    <p><a id="c-evidentia-ensayo" target="_blank" rel="noopener" hidden>Abrir el resultado del ensayo</a></p>
  </section>
  <section>
    <h4>Público (/vivo)</h4>
    <form id="c-aviso" class="fila"><input id="c-aviso-texto" maxlength="280" placeholder="Mensaje para el público" autocomplete="off"><button type="submit">Enviar</button></form>
    <div class="fila" style="margin-top:8px"><button class="ghost" id="c-reiniciar" type="button">Reiniciar la sala</button></div>
    <p id="c-aviso-estado"></p>
  </section>
  <section>
    <h4>Sin red</h4>
    <p>Si el portátil se queda sin red, esta pestaña sigue funcionando: Claude y PubMed muestran los resultados del ensayo, y para Evidentia queda el PDF guardado en el ensayo. Para tener además una copia en el disco:</p>
    <p><a href="/presentador/descargar">Descargar la presentación para abrirla sin red</a></p>
    <form method="post" action="/presentador/salir"><button class="ghost" type="submit">Cerrar la sesión</button></form>
  </section>
</div>
`;

/** Final exacto de la nota original de cada diapositiva que recibe un añadido. */
const NOTAS_ANCLA = {
  1: 'Antes de subir, lance la pregunta en Evidentia.">',
  3: 'Si algo falla, quedan las capturas del ensayo.">',
  10: 'Muestre el fragmento que respalda cada referencia y la marca de no revisado por un humano.">',
};

export function notasExtra(textoUrl) {
  return {
    1: `Invite a escanear el QR o a escribir ${textoUrl}; pulse C y confirme que el panel muestra público conectado.`,
    3: 'Con el sistema: pulse el primer botón y, mientras el modelo responde, lea la lista en forma corta; una sola votación (¿cuántas de las cinco existen?); después el segundo botón. Si a los 8 s no llega nada aparece el botón del ensayo; a los 25 s el respaldo entra solo.',
    10: 'Sin red, ninguno de los enlaces de Evidentia abre: use el PDF del ensayo guardado en el escritorio.',
  };
}

async function construirPresentador({ contenido, config, respaldos, urlVivo }) {
  let html = await leer('base/charla-ia-investigacion.html');

  // 1. Sin CDN: las fuentes van embebidas para que la presentación se vea igual sin red.
  html = unaVez(html, '<link rel="preconnect" href="https://fonts.googleapis.com">\n', '');
  html = unaVez(html, '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n', '');
  html = unaVez(
    html,
    '<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=Source+Serif+4:ital,wght@0,400..700;1,400..700&display=swap" rel="stylesheet">\n',
    // El favicon va embebido: la copia sin red no debe pedir nada fuera del archivo.
    `<meta name="robots" content="noindex, nofollow">\n<link rel="icon" href="data:image/svg+xml;base64,${(await readFile(r('web', 'favicon.svg'))).toString('base64')}" type="image/svg+xml">\n<style>\n${await fuentesEmbebidas()}\n</style>\n`,
  );
  html = unaVez(html, '</style>\n</head>', `</style>\n<style>${ESTILOS_CHARLA}</style>\n</head>`);

  // 2. El QR hacia /vivo: en la portada y en la última diapositiva.
  const textoUrl = urlVivo.replace(/^https?:\/\//, '');
  const svg = qrSvg(urlVivo, `Código QR: ${textoUrl}`);
  html = unaVez(
    html,
    '      <p style="color:#8E9AAE">Cirugía Plástica · Universidad Nacional de Colombia</p>\n    </section>',
    '      <p style="color:#8E9AAE">Cirugía Plástica · Universidad Nacional de Colombia</p>\n' +
      `      <div class="qr-vivo qr-portada">${svg}<p>Siga las demostraciones en su celular<br><b>${textoUrl}</b></p></div>\n    </section>`,
  );
  html = unaVez(
    html,
    '      <p style="color:var(--soft)">[Código QR del kit]</p>',
    `      <div class="qr-vivo qr-cierre">${svg}<p>El kit y las demostraciones, en su celular<br><b>${textoUrl}</b></p></div>`,
  );
  html = unaVez(html, '[su correo o red social]', config.contacto);

  // Notas del orador: lo que cambia por tener el sistema en vivo. Se añaden al final
  // de la nota original de la diapositiva; las notas no se proyectan.
  for (const [n, extra] of Object.entries(notasExtra(textoUrl))) {
    const marca = NOTAS_ANCLA[n];
    html = unaVez(html, marca, `${marca.slice(0, -2)} ${extra}">`);
  }

  // 3. La diapositiva de la demo: mismos elementos, con los enganches del respaldo.
  html = unaVez(
    html,
    '        <button id="btn-verify" class="ghost" disabled>Verificar las cinco en PubMed</button>\n',
    '        <button id="btn-verify" class="ghost" disabled>Verificar las cinco en PubMed</button>\n' +
      '        <button id="btn-respaldo-claude" class="ghost" type="button" hidden>Mostrar la respuesta del ensayo</button>\n' +
      '        <button id="btn-respaldo-pubmed" class="ghost" type="button" hidden>Mostrar los resultados del ensayo</button>\n',
  );
  html = unaVez(
    html,
    '<p class="out-label">Respuesta del modelo · sin verificar</p>',
    '<p class="out-label" id="sample-label">Respuesta del modelo · sin verificar</p>',
  );

  // 4. Controles del presentador: fuera de las diapositivas, ocultos hasta pedirlos.
  html = unaVez(html, '<div class="notes" id="notes"></div>\n', `<div class="notes" id="notes"></div>\n${CONTROLES}`);
  html = unaVez(
    html,
    '  <button class="ghost" id="toggle-notes">Notas</button>\n',
    '  <button class="ghost" id="toggle-notes">Notas</button>\n' +
      '  <button class="ghost" id="toggle-controles">Controles</button>\n' +
      '  <span class="punto" id="estado-red" title="Comprobando la conexión"></span>\n',
  );

  // 5. El script: fuera `window.claude.use`, dentro el backend propio.
  const inicioScript = html.lastIndexOf('<script>\n(function(){');
  const finScript = html.lastIndexOf('</script>');
  if (inicioScript < 0 || finScript < inicioScript) throw new Error('No se encontró el script de la base.');
  const scriptBase = html.slice(inicioScript, finScript);
  if (!scriptBase.includes('window.claude.use("sample")') || !scriptBase.includes('window.claude.use("mcp")')) {
    throw new Error('El script de la base cambió: revise el port antes de continuar.');
  }

  const script = await leer('web/presentador.js');
  if (/<\/script/i.test(script)) throw new Error('El script del presentador no puede contener </script.');
  const datos = {
    referencias: contenido.referencias.map(({ n, cita, doi }) => ({ n, cita, doi })),
    respaldos,
    modelo: config.modelo,
    urlVivo,
    evidentiaEnsayo: respaldos.evidentia
      ? {
          enlace: `${config.evidentiaUrl.replace(/\/+$/, '')}/ui#${encodeURIComponent(respaldos.evidentia.runId)}`,
          fecha: respaldos.evidentia.fecha,
        }
      : null,
  };
  html =
    html.slice(0, inicioScript) +
    `<script type="application/json" id="datos-presentador">${jsonEmbebido(datos)}</script>\n<script>${script}</script>` +
    html.slice(finScript + '</script>'.length);

  if (html.includes('window.claude')) throw new Error('Quedó una llamada a window.claude en la presentación.');
  if (/fonts\.googleapis|fonts\.gstatic/.test(html)) throw new Error('Quedó una dependencia de Google Fonts.');

  const csp = [
    "default-src 'none'",
    `script-src 'sha256-${sha256Base64(script)}'`,
    // Los estilos en línea son de la base (atributos style=). Sin datos de fuera en ellos.
    "style-src 'unsafe-inline'",
    'font-src data:',
    "img-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');

  return { html, csp };
}

async function construirVivo({ contenido, respaldos }) {
  const plantilla = await leer('web/vivo.html');
  const datos = {
    totalDiapositivas: contenido.diapositivas.length,
    refResumen: contenido.resumen.referencia,
    fechaEnsayoPubmed: respaldos.pubmed?.fecha ?? null,
    // Las fabricadas viajan en forma corta y marcadas: la cita completa y su DOI
    // inventado no llegan nunca al público.
    referencias: contenido.referencias.map((ref) =>
      ref.fabricada
        ? { n: ref.n, corta: ref.corta, fabricada: true }
        : { n: ref.n, cita: ref.cita, corta: ref.corta, fabricada: false },
    ),
    kit: {
      lineasRojas: contenido.kit.lineasRojas,
      guias: contenido.kit.guias,
      prompts: contenido.kit.prompts,
    },
  };
  return unaVez(plantilla, '__DATOS_VIVO__', jsonEmbebido(datos));
}

export async function construir() {
  const [contenido, config, respaldos] = await Promise.all([
    leerJson('datos/contenido.json'),
    leerJson('datos/config.json'),
    // Las pruebas de extremo a extremo usan otros respaldos sin tocar los de verdad.
    process.env.CHARLA_RESPALDOS ? readFile(process.env.CHARLA_RESPALDOS, 'utf8').then(JSON.parse) : leerJson('datos/respaldos.json'),
  ]);
  const urlVivo = `${config.urlPublica.replace(/\/+$/, '')}/vivo`;

  await rm(r('public'), { recursive: true, force: true });
  await mkdir(r('public', '_privado'), { recursive: true });
  await mkdir(r('src', 'generado'), { recursive: true });

  const { html, csp } = await construirPresentador({ contenido, config, respaldos, urlVivo });
  await writeFile(r('public', '_privado', 'presentador.html'), html);
  // El Worker lee de aquí los mismos respaldos que lleva embebidos la página.
  await writeFile(r('public', '_privado', 'respaldos.json'), JSON.stringify(respaldos));
  await writeFile(r('public', 'vivo.html'), await construirVivo({ contenido, respaldos }));
  for (const f of ['vivo.js', 'vivo.css', 'entrar.html', 'entrar.js', 'entrar.css', 'sw-presentador.js', 'favicon.svg', 'robots.txt']) {
    await copyFile(r('web', f), r('public', f));
  }
  await writeFile(
    r('src', 'generado', 'csp.ts'),
    `// Generado por scripts/construir.mjs. No editar a mano.\nexport const CSP_PRESENTADOR = ${JSON.stringify(csp)};\n`,
  );

  const avisos = [];
  if (!respaldos.claude) avisos.push('No hay respuesta de Claude grabada (datos/respaldos.json → claude).');
  if (!respaldos.pubmed) avisos.push('No hay resultados de PubMed grabados (datos/respaldos.json → pubmed).');
  if (!respaldos.evidentia) avisos.push('No hay resultado de Evidentia grabado (datos/respaldos.json → evidentia).');
  // Un despliegue sin respaldos no llega a producción por descuido: `npm run deploy`
  // pone CHARLA_DESPLIEGUE=1. Antes del ensayo general, CHARLA_SIN_RESPALDOS=1 lo permite a sabiendas.
  if (avisos.length && process.env.CHARLA_DESPLIEGUE === '1' && process.env.CHARLA_SIN_RESPALDOS !== '1') {
    throw new Error(`${avisos.join(' ')} Para desplegar antes del ensayo general: CHARLA_SIN_RESPALDOS=1 npm run deploy`);
  }
  return { urlVivo, bytesPresentador: Buffer.byteLength(html), avisos };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const res = await construir();
  console.log(`Construido. QR → ${res.urlVivo}. Presentador: ${(res.bytesPresentador / 1024).toFixed(0)} KB.`);
  for (const a of res.avisos) console.warn(`AVISO: ${a}`);
}
