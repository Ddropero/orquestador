import { describe, it, expect } from 'vitest';
import {
  tokenValido,
  firmarSesion,
  verificarSesion,
  leerCookie,
  mismoOrigen,
  identificar,
  cookieSesion,
  COOKIE,
  DURACION_SESION_S,
} from '../src/auth.js';

const TOKEN = 'token-de-prueba-suficientemente-largo-123';
const AHORA = 1_790_000_000_000;

describe('token del presentador', () => {
  it('acepta solo el token exacto', async () => {
    expect(await tokenValido(TOKEN, TOKEN)).toBe(true);
    expect(await tokenValido(TOKEN + 'x', TOKEN)).toBe(false);
    expect(await tokenValido(TOKEN.slice(0, -1), TOKEN)).toBe(false);
    expect(await tokenValido('', TOKEN)).toBe(false);
    expect(await tokenValido(null, TOKEN)).toBe(false);
    expect(await tokenValido('x'.repeat(10_000), TOKEN)).toBe(false);
  });

  it('con un token del servidor ausente o corto, nadie entra', async () => {
    expect(await tokenValido('', undefined)).toBe(false);
    expect(await tokenValido('corto', 'corto')).toBe(false);
  });
});

describe('sesión firmada', () => {
  it('una sesión recién firmada vale y vence en tres días', async () => {
    const { valor, vence } = await firmarSesion(TOKEN, AHORA);
    expect(vence).toBe(Math.floor(AHORA / 1000) + DURACION_SESION_S);
    expect(await verificarSesion(valor, TOKEN, AHORA)).toBe(vence);
  });

  it('rechaza una sesión vencida, alterada o firmada con otro token', async () => {
    const { valor, vence } = await firmarSesion(TOKEN, AHORA);
    expect(await verificarSesion(valor, TOKEN, vence * 1000 + 1)).toBeNull();
    const [exp, firma] = valor.split('.');
    expect(await verificarSesion(`${Number(exp) + 100}.${firma}`, TOKEN, AHORA)).toBeNull();
    expect(await verificarSesion(valor, TOKEN + '-rotado', AHORA)).toBeNull();
    expect(await verificarSesion('basura', TOKEN, AHORA)).toBeNull();
    expect(await verificarSesion(null, TOKEN, AHORA)).toBeNull();
  });

  it('la cookie es __Host-, HttpOnly, Secure y SameSite=Strict', () => {
    const c = cookieSesion('1.abc');
    expect(c.startsWith(`${COOKIE}=`)).toBe(true);
    expect(COOKIE.startsWith('__Host-')).toBe(true);
    for (const parte of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) expect(c).toContain(parte);
    expect(c).not.toContain('Domain=');
  });

  it('en local (wrangler dev) la cookie no lleva prefijo __Host- ni Secure, y sigue siendo HttpOnly', () => {
    const c = cookieSesion('1.abc', true);
    expect(c.startsWith('presentador-local=')).toBe(true);
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Strict');
    expect(c).not.toContain('Secure');
  });
});

describe('identificar a quien llama', () => {
  it('por cookie de sesión', async () => {
    const { valor } = await firmarSesion(TOKEN, AHORA);
    const req = new Request('https://charla.example/api/x', { headers: { cookie: `otra=1; ${COOKIE}=${valor}` } });
    expect(leerCookie(req, COOKIE)).toBe(valor);
    expect(await identificar(req, TOKEN, AHORA)).toMatchObject({ via: 'cookie' });
  });

  it('por Bearer, para los scripts', async () => {
    const bien = new Request('https://charla.example/api/x', { headers: { authorization: `Bearer ${TOKEN}` } });
    const mal = new Request('https://charla.example/api/x', { headers: { authorization: 'Bearer otro-token-que-no-es-el-correcto' } });
    expect(await identificar(bien, TOKEN, AHORA)).toEqual({ via: 'bearer' });
    expect(await identificar(mal, TOKEN, AHORA)).toBeNull();
  });

  it('sin nada, nadie', async () => {
    expect(await identificar(new Request('https://charla.example/api/x'), TOKEN, AHORA)).toBeNull();
  });
});

describe('mismo origen', () => {
  it('acepta el propio origen y rechaza los demás', () => {
    const propio = new Request('https://charla.example/api/x', { method: 'POST', headers: { origin: 'https://charla.example' } });
    const ajeno = new Request('https://charla.example/api/x', { method: 'POST', headers: { origin: 'https://malo.example' } });
    const sinOrigen = new Request('https://charla.example/api/x', { method: 'POST' });
    const fetchSite = new Request('https://charla.example/api/x', { method: 'POST', headers: { 'sec-fetch-site': 'same-origin' } });
    expect(mismoOrigen(propio)).toBe(true);
    expect(mismoOrigen(ajeno)).toBe(false);
    expect(mismoOrigen(sinOrigen)).toBe(false);
    expect(mismoOrigen(fetchSite)).toBe(true);
  });

  it('Sec-Fetch-Site manda sobre Origin: un formulario propio con Origin null entra, un iframe ajeno no', () => {
    const formulario = new Request('https://charla.example/presentador/entrar', {
      method: 'POST',
      headers: { origin: 'null', 'sec-fetch-site': 'same-origin' },
    });
    const ajeno = new Request('https://charla.example/api/x', {
      method: 'POST',
      headers: { origin: 'https://charla.example', 'sec-fetch-site': 'cross-site' },
    });
    expect(mismoOrigen(formulario)).toBe(true);
    expect(mismoOrigen(ajeno)).toBe(false);
  });
});
