import { describe, it, expect } from 'vitest';
import { lanzar, consultar, etapasDelResultado, cifrasDelResultado, hayCifras, enlaceRun, ErrorEvidentia } from '../src/evidentia.js';
import { sanear } from '../src/eventos.js';

/** Forma real del `output` de un run `ask` terminado, según apps/api/src/pipeline.ts de Evidentia. */
const SALIDA = {
  runId: 'abc123def456',
  status: 'complete',
  mode: 'ask',
  humanReviewed: false,
  warning: 'Resultado NO revisado por un humano.',
  pico: {
    population: 'quemadura de espesor parcial superficial',
    intervention: 'miel',
    comparator: 'sulfadiazina de plata',
    outcome: 'días hasta epitelizar',
  },
  retrieval: { pubmed: 31, europepmc: 12, conResumen: { pubmed: 28, europepmc: 10 } },
  dedupe: { unique: 38, duplicates: 5, fuzzyMerges: 1 },
  integrity: { checked: 20, unchecked: 18, retracted: 1, flagged: 0 },
  synthesis: {
    afirmaciones: [{ texto: 'La miel epitelizó antes que la sulfadiazina.', respaldo: 'honey healed faster', soporte: 'SUPPORTS' }],
    escaladas: [],
    descartadas: { total: 3 },
  },
};

function fetchFalso(respuestas: Record<string, () => Response>) {
  const vistas: { url: string; init?: RequestInit }[] = [];
  const f = (async (url: RequestInfo | URL, init?: RequestInit) => {
    vistas.push({ url: String(url), ...(init ? { init } : {}) });
    const clave = `${init?.method ?? 'GET'} ${new URL(String(url)).pathname}`;
    const r = respuestas[clave];
    return r ? r() : new Response('no', { status: 404 });
  }) as typeof fetch;
  return { f, vistas };
}

describe('Evidentia', () => {
  it('lanza en modo ask con la pregunta y devuelve el runId', async () => {
    const { f, vistas } = fetchFalso({
      'POST /runs': () => Response.json({ runId: 'abc123def456', status: { status: 'queued' } }, { status: 202 }),
    });
    const r = await lanzar('https://evidentia.example/', '¿Miel o sulfadiazina?', f);
    expect(r).toEqual({ runId: 'abc123def456', estado: 'queued' });
    expect(vistas[0]!.url).toBe('https://evidentia.example/runs');
    expect(JSON.parse(String(vistas[0]!.init?.body))).toEqual({ mode: 'ask', question: '¿Miel o sulfadiazina?' });
  });

  it('rechaza un runId raro y las respuestas que no son JSON', async () => {
    const malo = fetchFalso({ 'POST /runs': () => Response.json({ runId: '../../etc' }, { status: 202 }) });
    await expect(lanzar('https://e.example', 'pregunta larga', malo.f)).rejects.toBeInstanceOf(ErrorEvidentia);
    const html = fetchFalso({ 'POST /runs': () => new Response('<html>desafío</html>') });
    await expect(lanzar('https://e.example', 'pregunta larga', html.f)).rejects.toBeInstanceOf(ErrorEvidentia);
    const caido = fetchFalso({ 'POST /runs': () => new Response('x', { status: 500 }) });
    await expect(lanzar('https://e.example', 'pregunta larga', caido.f)).rejects.toBeInstanceOf(ErrorEvidentia);
  });

  it('lee el estado y el resultado de GET /runs/:id', async () => {
    const { f } = fetchFalso({
      'GET /runs/abc123def456': () => Response.json({ runId: 'abc123def456', status: { status: 'complete', output: SALIDA } }),
    });
    const r = await consultar('https://e.example', 'abc123def456', f);
    expect(r.estado).toBe('complete');
    expect(r.output).toEqual(SALIDA);
  });

  it('arma el enlace a la interfaz de Evidentia', () => {
    expect(enlaceRun('https://e.example/', 'abc123def456')).toBe('https://e.example/ui#abc123def456');
  });

  it('las etapas llevan solo cifras: ningún texto clínico del resultado llega al público', () => {
    const etapas = etapasDelResultado(SALIDA);
    const todo = JSON.stringify(etapas);
    expect(todo).toContain('31 referencias de PubMed y 12 de Europe PMC');
    expect(todo).toContain('38 referencias únicas');
    expect(todo).toContain('20 comprobadas contra retractaciones · 1 retractada');
    expect(todo).toContain('1 afirmación con respaldo textual');
    expect(todo).toContain('No revisado por un humano');
    for (const prohibido of ['miel', 'sulfadiazina', 'epitelizó', 'honey', 'quemadura']) {
      expect(todo.toLowerCase()).not.toContain(prohibido);
    }
  });

  it('con un resultado incompleto no inventa cifras', () => {
    const etapas = etapasDelResultado({ retrieval: { pubmed: 'muchas' } });
    expect(etapas.find((e) => e.etapa.startsWith('Búsqueda'))).not.toHaveProperty('detalle');
    expect(etapasDelResultado(null)).toHaveLength(6);
  });

  it('las cifras del embudo salen de las mismas fuentes que las etapas', () => {
    expect(cifrasDelResultado(SALIDA)).toEqual({
      pubmed: 31,
      europepmc: 12,
      unicas: 38,
      comprobadas: 20,
      retractadas: 1,
      afirmaciones: 1,
      escaladas: 0,
    });
  });

  it('el embudo lleva solo enteros: ningún texto del resultado, y pasa por sanear intacto', () => {
    const cifras = cifrasDelResultado(SALIDA);
    for (const v of Object.values(cifras)) expect(Number.isInteger(v)).toBe(true);
    const e = sanear({ ...cifras, tipo: 'evidentia_embudo' }, 1, 1);
    expect(e).toEqual({ ...cifras, tipo: 'evidentia_embudo', ts: 1, seq: 1 });
    const todo = JSON.stringify(e).toLowerCase();
    for (const prohibido of ['miel', 'sulfadiazina', 'epitelizó', 'honey', 'quemadura', 'supports']) {
      expect(todo).not.toContain(prohibido);
    }
  });

  it('con un resultado incompleto o raro no inventa cifras (ni ceros)', () => {
    expect(cifrasDelResultado(null)).toEqual({});
    expect(cifrasDelResultado('complete')).toEqual({});
    expect(
      cifrasDelResultado({
        retrieval: { pubmed: 'muchas', europepmc: 12 },
        dedupe: { unique: -3 },
        integrity: { checked: 2.5, retracted: 0 },
        synthesis: { afirmaciones: 'tres', escaladas: [{ texto: 'x' }, { texto: 'y' }] },
      }),
    ).toEqual({ europepmc: 12, retractadas: 0, escaladas: 2 });
    expect(cifrasDelResultado({ retrieval: { pubmed: 5_000_000 } })).toEqual({});
  });

  it('un embudo vacío no se difunde', () => {
    expect(hayCifras({})).toBe(false);
    expect(hayCifras(null)).toBe(false);
    expect(hayCifras(undefined)).toBe(false);
    expect(hayCifras({ escaladas: 0 })).toBe(true);
    expect(hayCifras(cifrasDelResultado(SALIDA))).toBe(true);
  });
});
