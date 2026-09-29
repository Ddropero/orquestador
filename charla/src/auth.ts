/**
 * Autenticación del presentador.
 *
 * Un solo secreto, PRESENTER_TOKEN, que nunca viaja en una URL: se escribe en el
 * formulario de /presentador (o en el fragmento `#t=`, que el navegador no envía
 * al servidor) y se canjea por una cookie de sesión firmada con HMAC. La cookie
 * es `__Host-`, HttpOnly, Secure y SameSite=Strict: ningún script de la página la
 * lee y ningún sitio ajeno la puede usar.
 *
 * Para scripts (grabar respaldos) vale también `Authorization: Bearer <token>`.
 */

export const COOKIE = '__Host-presentador';
/**
 * En `wrangler dev` (http://127.0.0.1) el navegador rechaza las cookies `__Host-` y
 * `Secure`. Solo en los hosts de bucle local se usa una cookie sin esos atributos;
 * en producción el Worker redirige todo http a https antes de llegar aquí.
 */
export const COOKIE_LOCAL = 'presentador-local';
export function esLocal(url: URL): boolean {
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
}
export function nombreCookie(local: boolean): string {
  return local ? COOKIE_LOCAL : COOKIE;
}
export const DURACION_SESION_S = 3 * 24 * 60 * 60;
/**
 * Un token corto se adivina. Por debajo de esto el servidor no autentica a nadie.
 * Decisión del ponente: 5 caracteres, para teclearlo en tarima. Con letras y dígitos
 * al azar hay 62^5 ≈ 9·10^8 opciones; a 10 intentos fallidos por minuto e IP, una IP
 * tardaría siglos y mil IP, semanas. Lo que protege es el cupo de la entrada.
 */
export const LONGITUD_MINIMA_TOKEN = 5;

const codificador = new TextEncoder();

function base64url(bytes: ArrayBuffer): string {
  let bin = '';
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmac(clave: string, mensaje: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey(
    'raw',
    codificador.encode(clave),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', k, codificador.encode(mensaje));
}

/** Comparación en tiempo constante de dos resúmenes de igual longitud. */
function iguales(a: ArrayBuffer, b: ArrayBuffer): boolean {
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  if (x.length !== y.length) return false;
  let diferencia = 0;
  for (let i = 0; i < x.length; i++) diferencia |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diferencia === 0;
}

export function tokenUtilizable(token: string | undefined): token is string {
  return typeof token === 'string' && token.length >= LONGITUD_MINIMA_TOKEN;
}

/**
 * ¿`candidato` es el token? Se comparan los HMAC de ambos con una clave fija, así
 * la comparación no filtra ni la longitud ni el prefijo del token real.
 */
export async function tokenValido(candidato: unknown, token: string | undefined): Promise<boolean> {
  if (!tokenUtilizable(token) || typeof candidato !== 'string' || candidato.length === 0) return false;
  if (candidato.length > 512) return false;
  const [a, b] = await Promise.all([
    hmac('comparar-token-v1', candidato),
    hmac('comparar-token-v1', token),
  ]);
  return iguales(a, b);
}

export async function firmarSesion(token: string, ahoraMs: number): Promise<{ valor: string; vence: number }> {
  const vence = Math.floor(ahoraMs / 1000) + DURACION_SESION_S;
  const firma = base64url(await hmac(token, `sesion-presentador-v1:${vence}`));
  return { valor: `${vence}.${firma}`, vence };
}

/** Devuelve el vencimiento (s desde época) si la sesión es válida; si no, `null`. */
export async function verificarSesion(
  valor: string | null,
  token: string | undefined,
  ahoraMs: number,
): Promise<number | null> {
  if (!valor || !tokenUtilizable(token)) return null;
  const m = /^(\d{10,12})\.([A-Za-z0-9_-]{43})$/.exec(valor);
  if (!m) return null;
  const vence = Number(m[1]);
  if (!Number.isFinite(vence) || vence * 1000 <= ahoraMs) return null;
  // Una cookie que dice vencer más allá de la duración máxima no la firmó este servidor hoy.
  if (vence * 1000 > ahoraMs + DURACION_SESION_S * 1000 + 60_000) return null;
  const esperada = await hmac(token, `sesion-presentador-v1:${vence}`);
  const recibida = decodificarBase64url(m[2] ?? '');
  return recibida && iguales(esperada, recibida) ? vence : null;
}

function decodificarBase64url(s: string): ArrayBuffer | null {
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  } catch {
    return null;
  }
}

export function leerCookie(request: Request, nombre: string): string | null {
  const cabecera = request.headers.get('cookie');
  if (!cabecera) return null;
  for (const parte of cabecera.split(';')) {
    const i = parte.indexOf('=');
    if (i < 0) continue;
    if (parte.slice(0, i).trim() === nombre) return parte.slice(i + 1).trim();
  }
  return null;
}

export function cookieSesion(valor: string, local = false): string {
  return `${nombreCookie(local)}=${valor}; Path=/; Max-Age=${DURACION_SESION_S}; HttpOnly;${local ? '' : ' Secure;'} SameSite=Strict`;
}

export function cookieBorrada(local = false): string {
  return `${nombreCookie(local)}=; Path=/; Max-Age=0; HttpOnly;${local ? '' : ' Secure;'} SameSite=Strict`;
}

export interface Identidad {
  via: 'cookie' | 'bearer';
  /** Segundos desde época; solo para la cookie. */
  vence?: number;
}

/** ¿Quién llama? `null` si no es el presentador. */
export async function identificar(
  request: Request,
  token: string | undefined,
  ahoraMs: number,
  local = false,
): Promise<Identidad | null> {
  const auth = request.headers.get('authorization');
  if (auth?.startsWith('Bearer ')) {
    return (await tokenValido(auth.slice(7).trim(), token)) ? { via: 'bearer' } : null;
  }
  const vence = await verificarSesion(leerCookie(request, nombreCookie(local)), token, ahoraMs);
  return vence === null ? null : { via: 'cookie', vence };
}

/**
 * Defensa contra CSRF para las rutas que cambian estado con la cookie: la petición
 * tiene que venir de esta misma página. SameSite=Strict ya lo impide en los
 * navegadores actuales; esto cubre al resto.
 *
 * Primero `Sec-Fetch-Site`, que solo el navegador puede poner; si no viene, `Origin`.
 * Ojo: con `Referrer-Policy: no-referrer` un formulario envía `Origin: null` (así lo
 * manda la especificación de Fetch), por eso la política del sitio es `same-origin`.
 */
export function mismoOrigen(request: Request): boolean {
  const origen = request.headers.get('origin');
  const propio = new URL(request.url).origin;
  const sitio = request.headers.get('sec-fetch-site');
  const ok = sitio ? sitio === 'same-origin' : origen === propio;
  if (!ok) console.warn(JSON.stringify({ evento: 'origen_rechazado', origen, propio, sitio }));
  return ok;
}
