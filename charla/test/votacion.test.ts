import { describe, it, expect } from 'vitest';
import {
  abrirVotacion,
  cerrarVotacion,
  clavePapeleta,
  claveRed,
  conteosVacios,
  esperaParaDifundir,
  eventoVotos,
  interpretarVoto,
  leerCuerpoLimitado,
  registrarVoto,
  resumenVotacion,
  totalVotos,
  validarVoto,
  MAX_CUERPO_VOTO,
  PREFIJO_PAPELETA,
  PREFIJO_RED,
  TOPE_VOTANTES,
  TOPE_VOTANTES_POR_RED,
  type Papeleta,
  type Votacion,
  type Voto,
} from '../src/votacion.js';
import { sanear, TOTAL_REFERENCIAS } from '../src/eventos.js';

const VOTANTE = 'a1B2c3D4e5F6g7H8';
const OTRO = 'z9_y8-x7w6v5u4t3s2';

const voto = (extra: Partial<Voto> = {}): Voto => ({ votante: VOTANTE, ronda: 1, ref: 3, existe: true, ...extra });

/** Aplica un voto como lo hace la sala: papeletas en un mapa, votación reemplazada si cambió. */
function aplicar(v: Votacion, papeletas: Map<string, Papeleta>, x: Voto, tope?: number) {
  const clave = clavePapeleta(x.ronda, x.votante);
  const r = registrarVoto(v, papeletas.get(clave), x, tope);
  if (r.ok && r.cambio) papeletas.set(clave, r.papeleta);
  return r;
}

describe('validar el cuerpo del voto', () => {
  it('acepta exactamente el contrato y descarta lo demás', () => {
    expect(validarVoto({ ...voto(), nombre: 'Ana', cita: 'x', doi: '10.1/x' })).toEqual(voto());
    expect(validarVoto(voto({ existe: false, ref: 5, ronda: 12 }))).toEqual(voto({ existe: false, ref: 5, ronda: 12 }));
  });

  it('el votante es un identificador al azar de 16 a 64 letras, dígitos, _ o -', () => {
    expect(validarVoto(voto({ votante: 'x'.repeat(16) }))).not.toBeNull();
    expect(validarVoto(voto({ votante: 'x'.repeat(64) }))).not.toBeNull();
    for (const malo of ['x'.repeat(15), 'x'.repeat(65), 'a1B2c3D4e5F6g7H8 ', 'a1B2c3D4e5F6g7H<', 'ñandú-ñandú-ñandú', '../../../../etc/pw']) {
      expect(validarVoto(voto({ votante: malo }))).toBeNull();
    }
    expect(validarVoto({ ...voto(), votante: 12345678901234567 })).toBeNull();
  });

  it('rechaza ronda, referencia o respuesta fuera del contrato', () => {
    for (const ronda of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) expect(validarVoto(voto({ ronda }))).toBeNull();
    for (const ref of [0, 6, 2.5]) expect(validarVoto(voto({ ref }))).toBeNull();
    expect(validarVoto({ ...voto(), ronda: '1' })).toBeNull();
    expect(validarVoto({ ...voto(), ref: '3' })).toBeNull();
    expect(validarVoto({ ...voto(), existe: 'sí' })).toBeNull();
    expect(validarVoto({ ...voto(), existe: 1 })).toBeNull();
    const { existe: _existe, ...sinExiste } = voto();
    expect(validarVoto(sinExiste)).toBeNull();
    for (const raro of [null, undefined, 'voto', 3, [voto()]]) expect(validarVoto(raro)).toBeNull();
  });

  it('interpreta el texto del cuerpo: JSON válido y dentro del tope', () => {
    expect(interpretarVoto(JSON.stringify(voto()))).toEqual(voto());
    expect(interpretarVoto('')).toBeNull();
    expect(interpretarVoto('{"votante":')).toBeNull();
    expect(interpretarVoto('null')).toBeNull();
    expect(interpretarVoto(JSON.stringify({ ...voto(), relleno: 'x'.repeat(MAX_CUERPO_VOTO) }))).toBeNull();
  });
});

describe('leer el cuerpo sin pasar del tope', () => {
  const post = (body: BodyInit | null, headers: Record<string, string> = {}) =>
    new Request('https://charla.example/api/sala/voto', { method: 'POST', body, headers, ...(body instanceof ReadableStream ? { duplex: 'half' } : {}) } as RequestInit);

  it('devuelve el texto de un cuerpo pequeño', async () => {
    expect(await leerCuerpoLimitado(post(JSON.stringify(voto())))).toBe(JSON.stringify(voto()));
    expect(await leerCuerpoLimitado(post(null))).toBe('');
  });

  it('cuenta bytes, no caracteres', async () => {
    expect(await leerCuerpoLimitado(post('á'.repeat(MAX_CUERPO_VOTO / 2)))).toHaveLength(MAX_CUERPO_VOTO / 2);
    expect(await leerCuerpoLimitado(post('á'.repeat(MAX_CUERPO_VOTO / 2 + 1)))).toBeNull();
  });

  it('rechaza por content-length sin leer el cuerpo', async () => {
    expect(await leerCuerpoLimitado(post('x', { 'content-length': String(MAX_CUERPO_VOTO + 1) }))).toBeNull();
  });

  it('corta un cuerpo por trozos que no declara su tamaño', async () => {
    let enviados = 0;
    const flujo = new ReadableStream<Uint8Array>({
      pull(c) {
        enviados += 1;
        if (enviados > 1000) c.close();
        else c.enqueue(new Uint8Array(100));
      },
    });
    expect(await leerCuerpoLimitado(post(flujo))).toBeNull();
    // No se leyó entero: se cortó al pasar el tope.
    expect(enviados).toBeLessThan(20);
  });
});

describe('abrir y cerrar', () => {
  it('cada ronda nueva tiene número mayor que la última y empieza en ceros', () => {
    const v = abrirVotacion(0);
    expect(v).toEqual({ estado: 'abierta', ronda: 1, conteos: conteosVacios(), votantes: 0 });
    expect(abrirVotacion(7).ronda).toBe(8);
    expect(abrirVotacion(-3).ronda).toBe(1);
    expect(abrirVotacion(Number.NaN).ronda).toBe(1);
    expect(v.conteos.map((c) => c.ref)).toEqual([1, 2, 3, 4, 5]);
    expect(v.conteos).toHaveLength(TOTAL_REFERENCIAS);
  });

  it('cerrar conserva ronda y totales', () => {
    const papeletas = new Map<string, Papeleta>();
    const r = aplicar(abrirVotacion(0), papeletas, voto());
    if (!r.ok) throw new Error('debía aceptarse');
    const c = cerrarVotacion(r.votacion);
    expect(c).toMatchObject({ estado: 'cerrada', ronda: 1, votantes: 1 });
    expect(c.conteos.find((x) => x.ref === 3)).toEqual({ ref: 3, si: 1, no: 0 });
  });
});

describe('registrar votos', () => {
  it('un voto nuevo suma en su referencia y cuenta un votante', () => {
    const v = abrirVotacion(0);
    const r = registrarVoto(v, undefined, voto());
    expect(r).toMatchObject({ ok: true, cambio: true, papeleta: { '3': true } });
    if (!r.ok) return;
    expect(r.votacion.votantes).toBe(1);
    expect(r.votacion.conteos).toEqual([
      { ref: 1, si: 0, no: 0 },
      { ref: 2, si: 0, no: 0 },
      { ref: 3, si: 1, no: 0 },
      { ref: 4, si: 0, no: 0 },
      { ref: 5, si: 0, no: 0 },
    ]);
    // No muta la votación de entrada: la sala decide cuándo reemplazarla.
    expect(v.conteos[2]).toEqual({ ref: 3, si: 0, no: 0 });
    expect(v.votantes).toBe(0);
  });

  it('cambiar el voto resta del conteo anterior: nadie cuenta dos veces', () => {
    const papeletas = new Map<string, Papeleta>();
    let v = abrirVotacion(0);
    for (const x of [voto(), voto({ existe: false })]) {
      const r = aplicar(v, papeletas, x);
      if (!r.ok) throw new Error('debía aceptarse');
      v = r.votacion;
    }
    expect(v.conteos.find((c) => c.ref === 3)).toEqual({ ref: 3, si: 0, no: 1 });
    expect(v.votantes).toBe(1);
    expect(papeletas.get(clavePapeleta(1, VOTANTE))).toEqual({ '3': false });
  });

  it('repetir el mismo voto no cambia nada (ni hay que escribir ni difundir)', () => {
    const v0 = abrirVotacion(0);
    const r1 = registrarVoto(v0, undefined, voto());
    if (!r1.ok) throw new Error('debía aceptarse');
    const r2 = registrarVoto(r1.votacion, r1.papeleta, voto());
    expect(r2).toMatchObject({ ok: true, cambio: false });
    if (r2.ok) expect(r2.votacion).toBe(r1.votacion);
  });

  it('el mismo votante vota en varias referencias y sigue siendo un votante', () => {
    const papeletas = new Map<string, Papeleta>();
    let v = abrirVotacion(0);
    for (let ref = 1; ref <= 5; ref++) {
      const r = aplicar(v, papeletas, voto({ ref, existe: ref % 2 === 0 }));
      if (!r.ok) throw new Error('debía aceptarse');
      v = r.votacion;
    }
    expect(v.votantes).toBe(1);
    expect(v.conteos.map((c) => [c.si, c.no])).toEqual([[0, 1], [1, 0], [0, 1], [1, 0], [0, 1]]);
    expect(papeletas.get(clavePapeleta(1, VOTANTE))).toEqual({ '1': false, '2': true, '3': false, '4': true, '5': false });
  });

  it('un voto de otra ronda es de un celular que se quedó atrás: votación cerrada', () => {
    const v = abrirVotacion(4);
    expect(registrarVoto(v, undefined, voto({ ronda: 4 }))).toEqual({ ok: false, error: 'votacion_cerrada' });
    expect(registrarVoto(v, undefined, voto({ ronda: 6 }))).toEqual({ ok: false, error: 'votacion_cerrada' });
    expect(registrarVoto(v, undefined, voto({ ronda: 5 }))).toMatchObject({ ok: true });
  });

  it('con la votación cerrada, o sin votación, no se vota', () => {
    const cerrada = cerrarVotacion(abrirVotacion(0));
    expect(registrarVoto(cerrada, undefined, voto())).toEqual({ ok: false, error: 'votacion_cerrada' });
    expect(registrarVoto(cerrada, { '3': false }, voto())).toEqual({ ok: false, error: 'votacion_cerrada' });
    expect(registrarVoto(null, undefined, voto())).toEqual({ ok: false, error: 'votacion_cerrada' });
  });

  it('al llegar al tope, un votante nuevo no entra pero quien ya votó puede cambiar', () => {
    const papeletas = new Map<string, Papeleta>();
    let v = abrirVotacion(0);
    for (const votante of [VOTANTE, OTRO]) {
      const r = aplicar(v, papeletas, voto({ votante }), 2);
      if (!r.ok) throw new Error('debía aceptarse');
      v = r.votacion;
    }
    expect(aplicar(v, papeletas, voto({ votante: 'nuevo-votante-0001' }), 2)).toEqual({ ok: false, error: 'votacion_llena' });
    const cambio = aplicar(v, papeletas, voto({ votante: OTRO, ref: 1, existe: false }), 2);
    expect(cambio).toMatchObject({ ok: true, cambio: true });
    if (cambio.ok) expect(cambio.votacion.votantes).toBe(2);
  });

  it('el tope por defecto es de 3000 votantes por ronda', () => {
    expect(TOPE_VOTANTES).toBe(3000);
    const llena: Votacion = { ...abrirVotacion(0), votantes: 3000 };
    expect(registrarVoto(llena, undefined, voto())).toEqual({ ok: false, error: 'votacion_llena' });
    expect(registrarVoto({ ...llena, votantes: 2999 }, undefined, voto())).toMatchObject({ ok: true });
  });

  it('cada red tiene su tope de votantes nuevos; quien ya votó cambia su voto aunque su red esté llena', () => {
    const v = abrirVotacion(0);
    // La red ya tiene su tope: un votante nuevo desde ella no entra, aunque la ronda tenga sitio.
    expect(registrarVoto(v, undefined, voto(), TOPE_VOTANTES, 5, 5)).toEqual({ ok: false, error: 'votacion_llena' });
    expect(registrarVoto(v, undefined, voto(), TOPE_VOTANTES, 4, 5)).toMatchObject({ ok: true, cambio: true, nuevo: true });
    // Cambiar el voto no gasta cupo de la red.
    const cambio = registrarVoto(v, { '3': false }, voto(), TOPE_VOTANTES, 5, 5);
    expect(cambio).toMatchObject({ ok: true, cambio: true, nuevo: false });
    // Repetir lo mismo tampoco.
    expect(registrarVoto(v, { '3': true }, voto(), TOPE_VOTANTES, 5, 5)).toMatchObject({ ok: true, cambio: false, nuevo: false });
  });

  it('el tope por red deja entrar a un auditorio entero detrás de una IP, y una sola red no llena la ronda', () => {
    expect(TOPE_VOTANTES_POR_RED).toBe(600);
    expect(TOPE_VOTANTES_POR_RED * 4).toBeLessThan(TOPE_VOTANTES);
    const v: Votacion = { ...abrirVotacion(0), votantes: 599 };
    expect(registrarVoto(v, undefined, voto(), undefined, 599)).toMatchObject({ ok: true, nuevo: true });
    expect(registrarVoto({ ...v, votantes: 600 }, undefined, voto(), undefined, 600)).toEqual({ ok: false, error: 'votacion_llena' });
    // Otra red, con la primera llena, sigue votando.
    expect(registrarVoto({ ...v, votantes: 600 }, undefined, voto({ votante: OTRO }), undefined, 0)).toMatchObject({ ok: true, nuevo: true });
  });

  it('la red se guarda resumida, con la sal de la ronda: ni la IP ni un resumen que sirva en otra ronda', async () => {
    const a = await claveRed(3, 'sal-uno', '203.0.113.7');
    expect(a).toMatch(new RegExp(`^${PREFIJO_RED}3:[0-9a-f]{32}$`));
    expect(a).not.toContain('203.0.113.7');
    expect(await claveRed(3, 'sal-uno', '203.0.113.7')).toBe(a);
    expect(await claveRed(3, 'sal-uno', '203.0.113.8')).not.toBe(a);
    expect((await claveRed(3, 'sal-dos', '203.0.113.7')).split(':')[2]).not.toBe(a.split(':')[2]);
    // No choca con las papeletas ni con las demás claves de la sala.
    expect(a.startsWith(PREFIJO_PAPELETA)).toBe(false);
    for (const otra of ['historial', 'seq', 'votacion', 'votacion_ronda', 'votacion_sal', 'evidentia', 'costos']) {
      expect(otra.startsWith(PREFIJO_RED)).toBe(false);
    }
  });

  it('los totales cuadran con las papeletas tras muchos votos y cambios', () => {
    // Generador determinista: la prueba no cambia de una corrida a otra.
    let semilla = 20261002;
    const azar = (n: number) => {
      semilla = (semilla * 1103515245 + 12345) % 2 ** 31;
      return semilla % n;
    };
    const votantes = Array.from({ length: 40 }, (_, i) => `votante-de-prueba-${String(i).padStart(3, '0')}`);
    const papeletas = new Map<string, Papeleta>();
    let v = abrirVotacion(0);
    for (let i = 0; i < 2000; i++) {
      const r = aplicar(v, papeletas, { votante: votantes[azar(40)]!, ronda: 1, ref: azar(5) + 1, existe: azar(2) === 0 });
      if (!r.ok) throw new Error('debía aceptarse');
      v = r.votacion;
    }
    const recuento = conteosVacios();
    for (const p of papeletas.values()) {
      for (const [ref, existe] of Object.entries(p)) {
        const c = recuento[Number(ref) - 1]!;
        if (existe) c.si += 1;
        else c.no += 1;
      }
    }
    expect(v.conteos).toEqual(recuento);
    expect(v.votantes).toBe(papeletas.size);
  });

  it('las papeletas llevan la ronda en la clave, con un prefijo propio', () => {
    expect(clavePapeleta(3, VOTANTE)).toBe(`${PREFIJO_PAPELETA}3:${VOTANTE}`);
    // Ninguna otra clave de la sala empieza así.
    for (const otra of ['historial', 'seq', 'votacion', 'votacion_ronda', 'votacion_sal', 'evidentia', 'costos']) {
      expect(otra.startsWith(PREFIJO_PAPELETA)).toBe(false);
    }
  });
});

describe('lo que sale de la votación', () => {
  it('los totales pasan por sanear tal cual, sin nada del votante', () => {
    const r = registrarVoto(abrirVotacion(2), undefined, voto({ ronda: 3 }));
    if (!r.ok) throw new Error('debía aceptarse');
    const e = sanear({ tipo: 'votos', ronda: r.votacion.ronda, conteos: r.votacion.conteos, votante: VOTANTE }, 1, 1);
    expect(e).toEqual({ tipo: 'votos', ronda: 3, conteos: r.votacion.conteos, ts: 1, seq: 1 });
    expect(JSON.stringify(e)).not.toContain(VOTANTE);
  });

  it('con la votación abierta, al público solo le llega cuántos votos van; el desglose, al cerrar', () => {
    const papeletas = new Map<string, Papeleta>();
    let v = abrirVotacion(0);
    for (const x of [voto({ ref: 1, existe: false }), voto({ ref: 2 }), voto({ votante: OTRO, ref: 2, existe: false })]) {
      const r = aplicar(v, papeletas, x);
      if (!r.ok) throw new Error('debía aceptarse');
      v = r.votacion;
    }
    expect(totalVotos(v.conteos)).toBe(3);
    expect(eventoVotos(abrirVotacion(0))).toEqual({ tipo: 'votos', ronda: 1, total: 0 });
    const abierta = eventoVotos(v);
    expect(abierta).toEqual({ tipo: 'votos', ronda: 1, total: 3 });
    expect(sanear(abierta, 1, 1)).toEqual({ tipo: 'votos', ronda: 1, total: 3, ts: 1, seq: 1 });
    const cerrada = eventoVotos(cerrarVotacion(v));
    expect(cerrada).toEqual({ tipo: 'votos', ronda: 1, conteos: v.conteos });
    expect(sanear(cerrada, 2, 2)).toMatchObject({ conteos: v.conteos });
  });

  it('el presentador ve estado, ronda, totales y votantes; sin votación, nulos', () => {
    expect(resumenVotacion(null)).toEqual({ estado: null, ronda: null, conteos: null, votantes: 0 });
    const v = cerrarVotacion(abrirVotacion(1));
    expect(resumenVotacion(v)).toEqual({ estado: 'cerrada', ronda: 2, conteos: conteosVacios(), votantes: 0 });
  });

  it('los totales se difunden como mucho una vez por segundo', () => {
    expect(esperaParaDifundir(0, 5_000)).toBe(0);
    expect(esperaParaDifundir(10_000, 10_000)).toBe(1000);
    expect(esperaParaDifundir(10_000, 10_400)).toBe(600);
    expect(esperaParaDifundir(10_000, 11_000)).toBe(0);
    expect(esperaParaDifundir(10_000, 12_500)).toBe(0);
  });
});
