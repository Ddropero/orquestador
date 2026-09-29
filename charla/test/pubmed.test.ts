import { describe, it, expect } from 'vitest';
import {
  crearClienteNcbi,
  verificarReferencia,
  esLaReferencia,
  normalizarDoi,
  normalizarTitulo,
  ErrorNcbi,
  NCBI_BASE_POR_DEFECTO,
} from '../src/pubmed.js';
import { REFERENCIAS, type ConsultaRegistrada, type Respaldos } from '../src/contenido.js';
import respaldosJson from '../datos/respaldos.json';

const RESPALDOS = respaldosJson as unknown as Respaldos;
import { ncbiSimulado } from './fixtures/ncbi-simulado.js';

const sinEspera = { dormir: async () => {}, ahora: () => 0 };

function cliente(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
  return crearClienteNcbi({ tool: 'charla-prueba', email: 'prueba@example.com', fetchImpl, ...sinEspera, ...extra });
}

describe('verificación de las cinco referencias', () => {
  it('da el veredicto correcto para cada una: 2 existen, 3 no', async () => {
    const { fetchImpl } = ncbiSimulado();
    const c = cliente(fetchImpl);
    const resultados = [];
    for (const ref of REFERENCIAS) resultados.push(await verificarReferencia(ref, c, () => {}));
    expect(resultados.map((r) => r.existe)).toEqual(REFERENCIAS.map((r) => !r.fabricada));
    expect(resultados.find((r) => r.ref === 2)?.pmid).toBe('30184455');
    expect(resultados.find((r) => r.ref === 4)?.pmid).toBe('24718923');
  });

  it('la referencia 3, inventada, NO existe aunque su búsqueda por título devuelva un artículo', async () => {
    const { fetchImpl } = ncbiSimulado();
    const consultas: ConsultaRegistrada[] = [];
    const ref3 = REFERENCIAS.find((r) => r.n === 3)!;
    const v = await verificarReferencia(ref3, cliente(fetchImpl), (c) => {
      consultas.push(c);
    });
    expect(v.existe).toBe(false);
    expect(consultas[0]).toEqual({ via: 'título', resultados: 1, coincide: false });
    expect(consultas.map((c) => c.via)).toEqual(['título', 'DOI', 'autor']);
  });

  it('no toma el primer PMID de la búsqueda: el 38088961 no es el artículo de Hayden', async () => {
    const { fetchImpl } = ncbiSimulado();
    const v = await verificarReferencia(REFERENCIAS.find((r) => r.n === 2)!, cliente(fetchImpl), () => {});
    expect(v.pmid).toBe('30184455');
    expect(v.consultas).toEqual([{ via: 'título', resultados: 2, coincide: true }]);
  });

  it('coincide exactamente con el respaldo grabado en datos/respaldos.json', async () => {
    const { fetchImpl } = ncbiSimulado();
    const c = cliente(fetchImpl);
    for (const ref of REFERENCIAS) {
      const v = await verificarReferencia(ref, c, () => {});
      const grabado = RESPALDOS.pubmed?.referencias.find((x) => x.ref === ref.n);
      expect(v).toEqual(grabado);
    }
  });

  it('avisa ANTES de cada búsqueda por qué vía va, sin el término, y en orden con las consultas', async () => {
    const { fetchImpl, llamadas } = ncbiSimulado();
    const orden: string[] = [];
    const ref3 = REFERENCIAS.find((r) => r.n === 3)!;
    await verificarReferencia(
      ref3,
      cliente(fetchImpl),
      (c) => {
        orden.push(`consulta:${c.via}`);
      },
      (via) => {
        // Todavía no se pidió a NCBI la búsqueda de esta vía.
        const busquedas = llamadas.filter((l) => l.ruta === 'esearch.fcgi').length;
        orden.push(`buscando:${via}:${busquedas}`);
      },
    );
    expect(orden).toEqual([
      'buscando:título:0',
      'consulta:título',
      'buscando:DOI:1',
      'consulta:DOI',
      'buscando:autor:2',
      'consulta:autor',
    ]);
  });

  it('una referencia que aparece por título no avisa de las vías que no hacen falta', async () => {
    const { fetchImpl } = ncbiSimulado();
    const vias: string[] = [];
    await verificarReferencia(REFERENCIAS.find((r) => r.n === 2)!, cliente(fetchImpl), () => {}, (via) => {
      vias.push(via);
    });
    expect(vias).toEqual(['título']);
  });

  it('espera a alBuscar antes de consultar, y sin alBuscar funciona igual', async () => {
    const { fetchImpl, llamadas } = ncbiSimulado();
    const ref1 = REFERENCIAS.find((r) => r.n === 1)!;
    let antes = -1;
    await verificarReferencia(ref1, cliente(fetchImpl), () => {}, async () => {
      await new Promise((r) => setTimeout(r, 5));
      if (antes < 0) antes = llamadas.length;
    });
    expect(antes).toBe(0);
    const sin = await verificarReferencia(ref1, cliente(ncbiSimulado().fetchImpl), () => {});
    expect(sin).toEqual(RESPALDOS.pubmed?.referencias.find((x) => x.ref === 1));
  });

  it('un término que NCBI no encuentra cuenta como cero resultados, no como la búsqueda sin él', async () => {
    const { fetchImpl } = ncbiSimulado();
    const r = await cliente(fetchImpl).buscar('Moreau-Quintana[Author] AND influenza[Title/Abstract]');
    expect(r).toEqual({ total: 0, ids: [] });
  });

  it('envía tool, email y la clave de NCBI cuando existe', async () => {
    const { fetchImpl, llamadas } = ncbiSimulado();
    await cliente(fetchImpl, { apiKey: 'clave-ncbi' }).buscar('"10.1093/cid/ciad1893"[aid]');
    const p = llamadas[0]!.params;
    expect(p.get('db')).toBe('pubmed');
    expect(p.get('retmode')).toBe('json');
    expect(p.get('tool')).toBe('charla-prueba');
    expect(p.get('email')).toBe('prueba@example.com');
    expect(p.get('api_key')).toBe('clave-ncbi');
  });

  it('usa E-utilities de NCBI por defecto', () => {
    expect(NCBI_BASE_POR_DEFECTO).toBe('https://eutils.ncbi.nlm.nih.gov/entrez/eutils');
  });
});

describe('cliente de NCBI ante fallos', () => {
  it('reintenta una vez ante 429 y sigue', async () => {
    const { fetchImpl, llamadas } = ncbiSimulado({
      fallar: (_l, n) => (n === 1 ? new Response('lento', { status: 429 }) : null),
    });
    const r = await cliente(fetchImpl).buscar('"10.1056/NEJMoa1716197"[aid]');
    expect(r.ids).toEqual(['30184455']);
    expect(llamadas).toHaveLength(2);
  });

  it('lanza ErrorNcbi si el 5xx persiste', async () => {
    const { fetchImpl } = ncbiSimulado({ fallar: () => new Response('caído', { status: 503 }) });
    await expect(cliente(fetchImpl).buscar('x')).rejects.toBeInstanceOf(ErrorNcbi);
  });

  it('lanza ErrorNcbi sin reintentar si no hay red (el respaldo no puede esperar)', async () => {
    const { fetchImpl, llamadas } = ncbiSimulado({ fallar: () => new TypeError('fetch failed') });
    await expect(cliente(fetchImpl).buscar('x')).rejects.toBeInstanceOf(ErrorNcbi);
    expect(llamadas).toHaveLength(1);
  });

  it('lanza ErrorNcbi si la respuesta no es JSON', async () => {
    const { fetchImpl } = ncbiSimulado({ fallar: () => new Response('<html>desafío</html>', { status: 200 }) });
    await expect(cliente(fetchImpl).buscar('x')).rejects.toBeInstanceOf(ErrorNcbi);
  });

  it('respeta el intervalo entre peticiones (3 por segundo sin clave)', async () => {
    const { fetchImpl } = ncbiSimulado();
    const esperas: number[] = [];
    let reloj = 1000;
    const c = crearClienteNcbi({
      tool: 't',
      email: 'e@example.com',
      fetchImpl,
      ahora: () => reloj,
      dormir: async (ms) => {
        esperas.push(ms);
        reloj += ms;
      },
    });
    await c.buscar('"10.1093/cid/ciad1893"[aid]');
    await c.buscar('"10.1093/cid/ciad1893"[aid]');
    expect(esperas).toEqual([350]);
  });

  it('se detiene si el presentador cancela', async () => {
    const { fetchImpl } = ncbiSimulado();
    const control = new AbortController();
    control.abort('respaldo');
    await expect(cliente(fetchImpl, { signal: control.signal }).buscar('x')).rejects.toBeInstanceOf(ErrorNcbi);
  });
});

describe('confirmar que un resultado es el artículo citado', () => {
  const ref2 = REFERENCIAS.find((r) => r.n === 2)!;
  it('por DOI, sin importar mayúsculas ni prefijos', () => {
    expect(esLaReferencia({ pmid: '1', titulo: 'otro', doi: 'https://doi.org/10.1056/nejmoa1716197' }, ref2)).toBe(true);
  });
  it('por título exacto, sin importar puntuación ni etiquetas', () => {
    expect(esLaReferencia({ pmid: '1', titulo: '<i>Baloxavir</i> Marboxil for Uncomplicated Influenza in Adults and Adolescents.' }, ref2)).toBe(true);
  });
  it('un título que solo contiene palabras de la cita no basta', () => {
    expect(esLaReferencia({ pmid: '1', titulo: 'Influenza.' }, ref2)).toBe(false);
    expect(esLaReferencia({ pmid: '1', titulo: '' }, ref2)).toBe(false);
  });
  it('normaliza DOI y títulos', () => {
    expect(normalizarDoi(' doi: 10.1002/14651858.CD008965.pub4. ')).toBe('10.1002/14651858.cd008965.pub4');
    expect(normalizarTitulo('Síntesis: “ÁCIDO” — prueba')).toBe('sintesis acido prueba');
  });
});

describe('clave de NCBI rechazada', () => {
  function ncbiQueRechazaLaClave() {
    const pedidas: URL[] = [];
    const fetchImpl = (async (entrada: string) => {
      const u = new URL(entrada);
      pedidas.push(u);
      if (u.searchParams.has('api_key')) {
        return Response.json({ error: 'API key invalid', 'api-key': u.searchParams.get('api_key'), type: 'invalid' }, { status: 400 });
      }
      return Response.json({ esearchresult: { count: '1', idlist: ['123'] } });
    }) as unknown as typeof fetch;
    return { pedidas, fetchImpl };
  }

  it('si NCBI rechaza la clave, repite sin ella y sigue sin ella', async () => {
    const { pedidas, fetchImpl } = ncbiQueRechazaLaClave();
    const c = cliente(fetchImpl, { apiKey: 'clave-mal-copiada' });
    expect(await c.buscar('influenza')).toEqual({ total: 1, ids: ['123'] });
    expect(await c.buscar('oseltamivir')).toEqual({ total: 1, ids: ['123'] });
    expect(pedidas.map((u) => u.searchParams.has('api_key'))).toEqual([true, false, false]);
  });

  it('otro 400 sigue siendo un error, con el motivo de NCBI y sin la clave', async () => {
    const fetchImpl = (async () =>
      Response.json({ error: 'Invalid query syntax', 'api-key': 'secreta' }, { status: 400 })) as unknown as typeof fetch;
    const c = cliente(fetchImpl, { apiKey: 'secreta' });
    const error = await c.buscar('x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ErrorNcbi);
    expect((error as Error).message).toBe('NCBI respondió HTTP 400: Invalid query syntax');
    expect((error as Error).message).not.toContain('secreta');
  });
});
