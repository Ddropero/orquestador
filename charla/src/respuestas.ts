/**
 * Respuestas y cabeceras. Sin CORS a propósito: todo lo que sirve este Worker es
 * para su propio origen, y ninguna otra página puede leer sus respuestas.
 */

const COMUNES: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  // No `no-referrer`: con esa política los formularios envían `Origin: null` y la
  // comprobación de mismo origen rechazaría al propio presentador.
  'referrer-policy': 'same-origin',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'strict-transport-security': 'max-age=31536000',
};

export function json(cuerpo: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: {
      ...COMUNES,
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extra,
    },
  });
}

export function error(status: number, mensaje: string, extra: Record<string, string> = {}): Response {
  return json({ error: mensaje }, status, extra);
}

export function demasiadas(): Response {
  return error(429, 'Demasiadas peticiones. Espere unos segundos.', { 'retry-after': '10' });
}

/** Copia una respuesta (de ASSETS o de la sala) y le pone las cabeceras de seguridad. */
export function conCabeceras(res: Response, extra: Record<string, string>, status?: number): Response {
  const r = new Response(res.body, { status: status ?? res.status, statusText: res.statusText, headers: res.headers });
  for (const [k, v] of Object.entries(COMUNES)) r.headers.set(k, v);
  for (const [k, v] of Object.entries(extra)) r.headers.set(k, v);
  return r;
}

export function redirigir(destino: string, status = 303, extra: Record<string, string> = {}): Response {
  return new Response(null, { status, headers: { ...COMUNES, location: destino, 'cache-control': 'no-store', ...extra } });
}

/** CSP de /vivo: nada en línea, nada de fuera, solo su propio origen y su WebSocket. */
export function cspVivo(origen: string): string {
  const ws = origen.replace(/^http/, 'ws');
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    `connect-src 'self' ${ws}`,
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export const CSP_ENTRAR = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');
