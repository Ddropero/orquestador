/**
 * Worker de la charla «Del caso clínico al PubMed».
 *
 * Tres públicos, tres niveles de acceso:
 *  - Público (QR): /vivo y la lectura de la sala. Solo lectura, con límite de tasa.
 *  - Presentador: /presentador y las rutas /api que cuestan dinero o cambian lo que
 *    ve el público. Exigen sesión (o Bearer) y, con cookie, mismo origen.
 *  - Nadie más: todo lo que no está en estas listas responde 404, incluidos los
 *    archivos privados de `public/_privado/`.
 *
 * `assets.run_worker_first` está activo: ni un archivo estático sale sin pasar por
 * aquí.
 */
import type { Env } from './env.js';
import { Sala } from './sala.js';
import { CONFIG } from './contenido.js';
import { cargarRespaldos } from './respaldos.js';
import {
  identificar,
  tokenValido,
  tokenUtilizable,
  firmarSesion,
  cookieSesion,
  cookieBorrada,
  esLocal,
  mismoOrigen,
  type Identidad,
} from './auth.js';
import { permitido, ipDe } from './limite.js';
import { json, error, demasiadas, conCabeceras, redirigir, cspVivo, CSP_ENTRAR } from './respuestas.js';
import { CSP_PRESENTADOR } from './generado/csp.js';

export { Sala };

/** Una sola sala para toda la charla. */
const NOMBRE_SALA = 'charla-2026-10-02';
const MAX_CUERPO = 4096;

/** Archivos públicos: ruta → [archivo en ASSETS, tipo de caché]. */
const PUBLICOS: Record<string, string> = {
  '/vivo': '/vivo.html',
  '/vivo.js': '/vivo.js',
  '/vivo.css': '/vivo.css',
  '/entrar.js': '/entrar.js',
  '/entrar.css': '/entrar.css',
  '/favicon.svg': '/favicon.svg',
  '/sw-presentador.js': '/sw-presentador.js',
  '/robots.txt': '/robots.txt',
};

/** Rutas del presentador → ruta interna de la sala. */
const PRESENTADOR: Record<string, string> = {
  'POST /api/claude/resumen': '/claude/resumen',
  'POST /api/pubmed/verificar': '/pubmed/verificar',
  'POST /api/evidentia/lanzar': '/evidentia/lanzar',
  'POST /api/sala/diapositiva': '/diapositiva',
  'POST /api/sala/aviso': '/aviso',
  'POST /api/sala/respaldo': '/respaldo',
  'POST /api/sala/reiniciar': '/reiniciar',
  'GET /api/presentador/respaldos': '/presentador/respaldos',
  'GET /api/presentador/costos': '/presentador/costos',
};

/** El sondeo de /vivo cada 5 s, con cientos de celulares, no necesita despertar la sala cada vez. */
let cacheEstado: { hasta: number; cuerpo: string } | null = null;

function sala(env: Env): DurableObjectStub<Sala> {
  return env.SALA.get(env.SALA.idFromName(NOMBRE_SALA));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await enrutar(request, env);
    } catch (e) {
      console.error(JSON.stringify({ evento: 'error_interno', nombre: e instanceof Error ? e.name : 'error' }));
      return error(500, 'Error interno.');
    }
  },
} satisfies ExportedHandler<Env>;

async function enrutar(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const ruta = url.pathname;
  const metodo = request.method;
  const ip = ipDe(request);
  const local = env.LOCAL === '1' || esLocal(url);

  // Nada viaja sin cifrar: la cookie del presentador y el token dependen de ello.
  if (url.protocol === 'http:' && !local) {
    url.protocol = 'https:';
    return redirigir(url.toString(), 301);
  }

  // ------------------------------------------------------------------ público
  if (metodo === 'GET' || metodo === 'HEAD') {
    if (ruta === '/') return redirigir('/vivo', 302);

    const archivo = PUBLICOS[ruta];
    if (archivo) {
      if (!(await permitido(env.LIMITE_LECTURA, `lectura:${ip}`))) return demasiadas();
      return servirPublico(env, url, archivo);
    }

    if (ruta === '/api/salud') {
      if (!(await permitido(env.LIMITE_LECTURA, `lectura:${ip}`))) return demasiadas();
      return json({ estado: 'ok' });
    }

    if (ruta === '/api/sala/estado' && metodo === 'GET') {
      if (!(await permitido(env.LIMITE_LECTURA, `lectura:${ip}`))) return demasiadas();
      const ahora = Date.now();
      if (!cacheEstado || cacheEstado.hasta < ahora) {
        const res = await sala(env).fetch('https://sala/estado');
        cacheEstado = { hasta: ahora + 1000, cuerpo: await res.text() };
      }
      return json(JSON.parse(cacheEstado.cuerpo));
    }

    if (ruta === '/api/sala/ws' && metodo === 'GET') {
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
        return error(426, 'Esta ruta solo acepta WebSocket.');
      }
      const origen = request.headers.get('origin');
      if (origen && origen !== url.origin) return error(403, 'Origen no permitido.');
      if (!(await permitido(env.LIMITE_WS, `ws:${ip}`))) return demasiadas();
      return sala(env).fetch(new Request('https://sala/ws', request));
    }
  }

  // -------------------------------------------------------------- presentador
  if (ruta === '/presentador' && metodo === 'GET') {
    const quien = await identificar(request, env.PRESENTER_TOKEN, Date.now(), local);
    if (!quien) return servirEntrada(env, url);
    // Renovación deslizante: abrir /presentador con sesión válida da tres días
    // frescos, para que la entrada del ensayo no venza en mitad de la charla.
    const renovada: Record<string, string> =
      quien.via === 'cookie' && tokenUtilizable(env.PRESENTER_TOKEN)
        ? { 'set-cookie': cookieSesion((await firmarSesion(env.PRESENTER_TOKEN, Date.now())).valor, local) }
        : {};
    return servirPresentador(env, url, false, renovada);
  }

  if (ruta === '/presentador/descargar' && metodo === 'GET') {
    const quien = await identificar(request, env.PRESENTER_TOKEN, Date.now(), local);
    return quien ? servirPresentador(env, url, true) : redirigir('/presentador');
  }

  if (ruta === '/presentador/entrar' && metodo === 'POST') return entrar(request, env, url, ip);

  if (ruta === '/presentador/salir' && metodo === 'POST') {
    if (!mismoOrigen(request)) return error(403, 'Origen no permitido.');
    return redirigir('/presentador', 303, { 'set-cookie': cookieBorrada(local) });
  }

  if (ruta.startsWith('/api/')) {
    const clave = `${metodo} ${ruta}`;
    const interna = PRESENTADOR[clave];
    const esEstado = clave === 'GET /api/presentador/estado';
    if (!interna && !esEstado) return error(404, 'No existe esta ruta.');

    const quien = await identificar(request, env.PRESENTER_TOKEN, Date.now(), local);
    if (!quien) {
      // Solo los Bearer fallidos gastan el cupo de adivinanzas (10/min por IP). Una
      // cookie inválida es una sesión vencida, no una adivinanza: no gasta el cupo
      // del propio ponente, que comparte la IP del auditorio.
      if (request.headers.has('authorization') && !(await permitido(env.LIMITE_ENTRADA, `entrada:${ip}`))) {
        return demasiadas();
      }
      return error(401, 'Solo el presentador puede usar esta ruta.');
    }
    if (quien.via === 'cookie' && metodo !== 'GET' && !mismoOrigen(request)) {
      return error(403, 'Origen no permitido.');
    }
    if (!(await permitido(env.LIMITE_PRESENTADOR, 'presentador'))) return demasiadas();

    if (esEstado) return estadoPresentador(env, quien);

    let cuerpo: string | undefined;
    if (metodo === 'POST') {
      const largo = Number(request.headers.get('content-length') ?? '0');
      if (largo > MAX_CUERPO) return error(413, 'Cuerpo demasiado grande.');
      cuerpo = await request.text();
      if (cuerpo.length > MAX_CUERPO) return error(413, 'Cuerpo demasiado grande.');
    }
    const res = await sala(env).fetch(`https://sala${interna}`, {
      method: metodo,
      headers: { 'content-type': 'application/json' },
      ...(cuerpo !== undefined ? { body: cuerpo || '{}' } : {}),
    });
    // Cualquier cambio en la sala invalida la caché del sondeo de este aislado.
    if (metodo === 'POST') cacheEstado = null;
    return conCabeceras(res, { 'cache-control': 'no-store' });
  }

  return error(404, 'No existe esta ruta.');
}

async function servirPublico(env: Env, url: URL, archivo: string): Promise<Response> {
  const res = await env.ASSETS.fetch(new URL(archivo, url.origin));
  if (!res.ok) return error(404, 'No existe esta ruta.');
  const extra: Record<string, string> = { 'cache-control': 'no-cache' };
  if (archivo.endsWith('.html')) extra['content-security-policy'] = cspVivo(url.origin);
  if (archivo === '/sw-presentador.js') extra['service-worker-allowed'] = '/presentador';
  return conCabeceras(res, extra);
}

async function servirEntrada(env: Env, url: URL): Promise<Response> {
  const res = await env.ASSETS.fetch(new URL('/entrar.html', url.origin));
  return conCabeceras(
    res,
    { 'content-security-policy': CSP_ENTRAR, 'cache-control': 'no-store', 'x-robots-tag': 'noindex' },
    401,
  );
}

async function servirPresentador(env: Env, url: URL, descargar: boolean, extra: Record<string, string> = {}): Promise<Response> {
  const res = await env.ASSETS.fetch(new URL('/_privado/presentador.html', url.origin));
  if (!res.ok) return error(500, 'Falta construir la página del presentador (npm run construir).');
  return conCabeceras(res, {
    ...extra,
    'content-security-policy': CSP_PRESENTADOR,
    'cache-control': 'no-store, private',
    'x-robots-tag': 'noindex',
    // El service worker solo guarda para uso sin red lo que lleva esta marca: nunca
    // la página de entrada.
    'x-charla-pagina': 'presentador',
    ...(descargar ? { 'content-disposition': 'attachment; filename="charla-presentador-sin-red.html"' } : {}),
  });
}

async function entrar(request: Request, env: Env, url: URL, ip: string): Promise<Response> {
  if (!mismoOrigen(request)) return error(403, 'Origen no permitido.');
  if (!tokenUtilizable(env.PRESENTER_TOKEN)) {
    console.error(JSON.stringify({ evento: 'token_presentador_ausente_o_corto' }));
    return redirigir('/presentador?error=1');
  }
  const largo = Number(request.headers.get('content-length') ?? '0');
  if (largo > MAX_CUERPO) return error(413, 'Cuerpo demasiado grande.');
  let candidato: unknown = null;
  try {
    const form = await request.formData();
    candidato = form.get('token');
  } catch {
    candidato = null;
  }
  if (!(await tokenValido(candidato, env.PRESENTER_TOKEN))) {
    // Solo los intentos fallidos gastan el cupo: un vecino de Wi-Fi con diez envíos
    // vacíos por minuto no deja fuera al ponente, que comparte la IP del auditorio.
    // Con un token al azar de 12 caracteres o más, adivinarlo cuesta más que la charla.
    if (!(await permitido(env.LIMITE_ENTRADA, `entrada:${ip}`))) return demasiadas();
    console.warn(JSON.stringify({ evento: 'entrada_fallida' }));
    return redirigir('/presentador?error=1');
  }
  const { valor } = await firmarSesion(env.PRESENTER_TOKEN, Date.now());
  return redirigir(`${url.origin}/presentador`, 303, { 'set-cookie': cookieSesion(valor, env.LOCAL === '1' || esLocal(url)) });
}

async function estadoPresentador(env: Env, quien: Identidad): Promise<Response> {
  const base = (env.EVIDENTIA_URL ?? CONFIG.evidentiaUrl).replace(/\/+$/, '');
  const [salaEstado, evidentiaSalud, respaldos] = await Promise.all([
    sala(env)
      .fetch('https://sala/presentador/estado')
      .then((r) => r.json() as Promise<Record<string, unknown>>),
    fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) })
      .then((r) => (r.ok ? 'ok' : `HTTP ${r.status}`))
      .catch(() => 'sin respuesta'),
    cargarRespaldos(env),
  ]);
  return json({
    ...salaEstado,
    sesion: { via: quien.via, ...(quien.vence ? { vence: new Date(quien.vence * 1000).toISOString() } : {}) },
    configuracion: {
      claveAnthropic: Boolean(env.ANTHROPIC_API_KEY),
      claveNcbi: Boolean(env.NCBI_API_KEY),
      tokenSeguro: tokenUtilizable(env.PRESENTER_TOKEN),
      modelo: CONFIG.modelo,
    },
    respaldos: {
      claude: respaldos.claude?.fecha ?? null,
      pubmed: respaldos.pubmed?.fecha ?? null,
      evidentia: respaldos.evidentia?.runId ?? null,
    },
    evidentiaSalud,
  });
}
