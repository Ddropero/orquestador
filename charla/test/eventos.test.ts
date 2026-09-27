import { describe, it, expect } from 'vitest';
import { sanear, compactar, limpiarTexto, LIMITES, type Evento } from '../src/eventos.js';

describe('sanear: lo único que sale hacia el público', () => {
  it('descarta cualquier campo que no sea del contrato', () => {
    const e = sanear({ tipo: 'aviso', texto: 'Hola', prompt: 'secreto', clave: 'sk-ant-xxx', costo: 1 }, 1, 1);
    expect(e).toEqual({ tipo: 'aviso', texto: 'Hola', ts: 1, seq: 1 });
  });

  it('rechaza tipos desconocidos y valores fuera de rango', () => {
    expect(sanear({ tipo: 'costo', usd: 1 }, 1, 1)).toBeNull();
    expect(sanear({ tipo: 'diapositiva', n: 0, titulo: 'x' }, 1, 1)).toBeNull();
    expect(sanear({ tipo: 'demo_inicio', tema: 'otro' }, 1, 1)).toBeNull();
    expect(sanear({ tipo: 'pubmed_consulta', ref: 6, via: 'título', resultados: 0 }, 1, 1)).toBeNull();
    expect(sanear({ tipo: 'pubmed_consulta', ref: 1, via: 'google', resultados: 0 }, 1, 1)).toBeNull();
    expect(sanear({ tipo: 'evidentia_etapa', etapa: 'x', estado: 'quizás' }, 1, 1)).toBeNull();
    expect(sanear(null, 1, 1)).toBeNull();
  });

  it('un "existe" sin PMID válido no se difunde', () => {
    expect(sanear({ tipo: 'pubmed_veredicto', ref: 2, existe: true }, 1, 1)).toBeNull();
    expect(sanear({ tipo: 'pubmed_veredicto', ref: 2, existe: true, pmid: '<script>' }, 1, 1)).toBeNull();
    expect(sanear({ tipo: 'pubmed_veredicto', ref: 2, existe: true, pmid: '30184455' }, 1, 1)).toMatchObject({ pmid: '30184455' });
  });

  it('un "no existe" nunca lleva PMID', () => {
    expect(sanear({ tipo: 'pubmed_veredicto', ref: 3, existe: false, pmid: '12749506' }, 1, 1)).toEqual({
      tipo: 'pubmed_veredicto', ref: 3, existe: false, ts: 1, seq: 1,
    });
  });

  it('marca el respaldo solo si es exactamente true', () => {
    expect(sanear({ tipo: 'claude_texto', texto_parcial: 'a', ensayo: 'sí' }, 1, 1)).not.toHaveProperty('ensayo');
    expect(sanear({ tipo: 'claude_texto', texto_parcial: 'a', ensayo: true }, 1, 1)).toHaveProperty('ensayo', true);
  });

  it('deja los textos sin caracteres de control y con tope de longitud', () => {
    expect(limpiarTexto('a\u0000b\u202e\u2028c', 50)).toBe('a b c');
    expect(limpiarTexto('x'.repeat(500), LIMITES.aviso)).toHaveLength(LIMITES.aviso);
    const e = sanear({ tipo: 'claude_texto', texto_parcial: 'línea 1\r\nlínea 2\u0007' }, 1, 1);
    expect(e).toMatchObject({ texto_parcial: 'línea 1\nlínea 2' });
    expect(sanear({ tipo: 'aviso', texto: '   ' }, 1, 1)).toBeNull();
  });

  it('el HTML llega como texto: sanear no lo interpreta, /vivo lo pinta con textContent', () => {
    const e = sanear({ tipo: 'aviso', texto: '<img src=x onerror=alert(1)>' }, 1, 1);
    expect(e).toMatchObject({ texto: '<img src=x onerror=alert(1)>' });
  });
});

describe('compactar el historial', () => {
  const ev = (seq: number, e: Record<string, unknown>) => sanear(e, seq, seq) as Evento;

  it('solo guarda la última diapositiva y el último texto de Claude', () => {
    let h: Evento[] = [];
    h = compactar(h, ev(1, { tipo: 'diapositiva', n: 1, titulo: 'a' }));
    h = compactar(h, ev(2, { tipo: 'claude_texto', texto_parcial: 'a' }));
    h = compactar(h, ev(3, { tipo: 'diapositiva', n: 2, titulo: 'b' }));
    h = compactar(h, ev(4, { tipo: 'claude_texto', texto_parcial: 'ab' }));
    expect(h.map((e) => e.seq)).toEqual([3, 4]);
  });

  it('una demo nueva reemplaza la anterior del mismo tema y no toca las demás', () => {
    let h: Evento[] = [];
    h = compactar(h, ev(1, { tipo: 'demo_inicio', tema: 'verificacion' }));
    h = compactar(h, ev(2, { tipo: 'pubmed_veredicto', ref: 1, existe: false }));
    h = compactar(h, ev(3, { tipo: 'demo_inicio', tema: 'evidentia' }));
    h = compactar(h, ev(4, { tipo: 'evidentia_etapa', etapa: 'x', estado: 'en curso' }));
    h = compactar(h, ev(5, { tipo: 'demo_inicio', tema: 'verificacion' }));
    expect(h.map((e) => e.seq)).toEqual([3, 4, 5]);
  });

  it('guarda solo los cinco últimos avisos y tiene tope total', () => {
    let h: Evento[] = [];
    for (let i = 1; i <= 8; i++) h = compactar(h, ev(i, { tipo: 'aviso', texto: `a${i}` }));
    expect(h.map((e) => e.seq)).toEqual([4, 5, 6, 7, 8]);
    let g: Evento[] = [];
    for (let i = 1; i <= 30; i++) g = compactar(g, ev(i, { tipo: 'pubmed_consulta', ref: 1, via: 'DOI', resultados: 0 }), 10);
    expect(g).toHaveLength(10);
  });
});

describe('sanear los eventos del proceso y de la votación', () => {
  it('pubmed_buscando: solo referencia y vía, nunca el término ni el DOI', () => {
    const e = sanear({ tipo: 'pubmed_buscando', ref: 3, via: 'DOI', termino: '"10.1093/cid/ciad1893"[aid]', doi: '10.1093/cid/ciad1893' }, 1, 1);
    expect(e).toEqual({ tipo: 'pubmed_buscando', ref: 3, via: 'DOI', ts: 1, seq: 1 });
    expect(JSON.stringify(e)).not.toContain('10.1093');
    expect(sanear({ tipo: 'pubmed_buscando', ref: 3, via: 'autor', ensayo: true }, 1, 1)).toHaveProperty('ensayo', true);
    expect(sanear({ tipo: 'pubmed_buscando', ref: 3, via: 'autor', ensayo: 'sí' }, 1, 1)).not.toHaveProperty('ensayo');
    expect(sanear({ tipo: 'pubmed_buscando', ref: 0, via: 'título' }, 1, 1)).toBeNull();
    expect(sanear({ tipo: 'pubmed_buscando', ref: 6, via: 'título' }, 1, 1)).toBeNull();
    expect(sanear({ tipo: 'pubmed_buscando', ref: 1, via: 'Google' }, 1, 1)).toBeNull();
  });

  it('evidentia_embudo: solo enteros conocidos; nada de texto', () => {
    const e = sanear({ tipo: 'evidentia_embudo', pubmed: 31, europepmc: 12, unicas: 38, escaladas: 0, pico: 'miel', afirmacion: 'La miel…' }, 1, 1);
    expect(e).toEqual({ tipo: 'evidentia_embudo', pubmed: 31, europepmc: 12, unicas: 38, escaladas: 0, ts: 1, seq: 1 });
    expect(sanear({ tipo: 'evidentia_embudo', retractadas: 1, ensayo: true }, 1, 1)).toMatchObject({ retractadas: 1, ensayo: true });
    // Una cifra rara invalida el evento entero: no se difunde a medias.
    for (const malo of [-1, 2.5, '31', Number.NaN, 2_000_000]) {
      expect(sanear({ tipo: 'evidentia_embudo', pubmed: 31, unicas: malo }, 1, 1)).toBeNull();
    }
    expect(sanear({ tipo: 'evidentia_embudo' }, 1, 1)).toBeNull();
    expect(sanear({ tipo: 'evidentia_embudo', pubmed: null, ensayo: true }, 1, 1)).toBeNull();
  });

  it('votacion: estado y ronda, nada más', () => {
    expect(sanear({ tipo: 'votacion', estado: 'abierta', ronda: 2, votantes: ['x'] }, 1, 1)).toEqual({ tipo: 'votacion', estado: 'abierta', ronda: 2, ts: 1, seq: 1 });
    expect(sanear({ tipo: 'votacion', estado: 'pausada', ronda: 2 }, 1, 1)).toBeNull();
    expect(sanear({ tipo: 'votacion', estado: 'cerrada', ronda: 0 }, 1, 1)).toBeNull();
    expect(sanear({ tipo: 'votacion', estado: 'cerrada' }, 1, 1)).toBeNull();
  });

  it('votos: un conteo por cada una de las cinco referencias, ordenados, sin votantes', () => {
    const conteos = [5, 4, 3, 2, 1].map((ref) => ({ ref, si: ref, no: 10 - ref, votante: 'a1B2c3D4e5F6g7H8' }));
    const e = sanear({ tipo: 'votos', ronda: 1, conteos }, 1, 1);
    expect(e).toEqual({
      tipo: 'votos',
      ronda: 1,
      conteos: [1, 2, 3, 4, 5].map((ref) => ({ ref, si: ref, no: 10 - ref })),
      ts: 1,
      seq: 1,
    });
    expect(JSON.stringify(e)).not.toContain('a1B2c3D4e5F6g7H8');
    const cinco = [1, 2, 3, 4, 5].map((ref) => ({ ref, si: 0, no: 0 }));
    expect(sanear({ tipo: 'votos', ronda: 1, conteos: cinco.slice(0, 4) }, 1, 1)).toBeNull();
    expect(sanear({ tipo: 'votos', ronda: 1, conteos: [...cinco.slice(0, 4), { ref: 1, si: 0, no: 0 }] }, 1, 1)).toBeNull();
    expect(sanear({ tipo: 'votos', ronda: 1, conteos: [...cinco.slice(0, 4), { ref: 5, si: -1, no: 0 }] }, 1, 1)).toBeNull();
    expect(sanear({ tipo: 'votos', ronda: 1, conteos: [...cinco.slice(0, 4), null] }, 1, 1)).toBeNull();
    expect(sanear({ tipo: 'votos', ronda: 0, conteos: cinco }, 1, 1)).toBeNull();
  });

  it('votos sin desglose (votación abierta): solo cuántos van, sin nada más', () => {
    expect(sanear({ tipo: 'votos', ronda: 2, total: 44, si: 30, votante: 'a1B2c3D4e5F6g7H8' }, 1, 1)).toEqual({ tipo: 'votos', ronda: 2, total: 44, ts: 1, seq: 1 });
    expect(sanear({ tipo: 'votos', ronda: 2, total: 0 }, 1, 1)).toEqual({ tipo: 'votos', ronda: 2, total: 0, ts: 1, seq: 1 });
    for (const malo of [-1, 2.5, '44', null, Number.NaN, 10_000_000]) expect(sanear({ tipo: 'votos', ronda: 2, total: malo }, 1, 1)).toBeNull();
    expect(sanear({ tipo: 'votos', ronda: 2 }, 1, 1)).toBeNull();
    expect(sanear({ tipo: 'votos', ronda: 0, total: 1 }, 1, 1)).toBeNull();
    // Con desglose, el total sobra: se descarta y queda solo lo del contrato.
    const cinco = [1, 2, 3, 4, 5].map((ref) => ({ ref, si: 1, no: 0 }));
    expect(sanear({ tipo: 'votos', ronda: 2, conteos: cinco, total: 5 }, 1, 1)).toEqual({ tipo: 'votos', ronda: 2, conteos: cinco, ts: 1, seq: 1 });
    // Unos conteos inválidos no se salvan con un total.
    expect(sanear({ tipo: 'votos', ronda: 2, conteos: cinco.slice(0, 4), total: 4 }, 1, 1)).toBeNull();
  });
});

describe('compactar los eventos nuevos', () => {
  const ev = (seq: number, e: Record<string, unknown>) => sanear(e, seq, seq) as Evento;
  const ceros = [1, 2, 3, 4, 5].map((ref) => ({ ref, si: 0, no: 0 }));

  it('del paso en curso de PubMed solo queda el último, y una verificación nueva lo borra', () => {
    let h: Evento[] = [];
    h = compactar(h, ev(1, { tipo: 'demo_inicio', tema: 'verificacion' }));
    h = compactar(h, ev(2, { tipo: 'pubmed_buscando', ref: 1, via: 'título' }));
    h = compactar(h, ev(3, { tipo: 'pubmed_consulta', ref: 1, via: 'título', resultados: 0 }));
    h = compactar(h, ev(4, { tipo: 'pubmed_buscando', ref: 1, via: 'DOI' }));
    expect(h.map((e) => e.seq)).toEqual([1, 3, 4]);
    h = compactar(h, ev(5, { tipo: 'demo_inicio', tema: 'verificacion' }));
    expect(h.map((e) => e.seq)).toEqual([5]);
  });

  it('del embudo solo queda el último, y una corrida nueva de Evidentia lo borra', () => {
    let h: Evento[] = [];
    h = compactar(h, ev(1, { tipo: 'evidentia_embudo', pubmed: 1, ensayo: true }));
    h = compactar(h, ev(2, { tipo: 'evidentia_embudo', pubmed: 31 }));
    expect(h.map((e) => e.seq)).toEqual([2]);
    h = compactar(h, ev(3, { tipo: 'demo_inicio', tema: 'evidentia' }));
    expect(h.map((e) => e.seq)).toEqual([3]);
  });

  it('de la votación quedan su último estado y sus últimos totales; una ronda nueva empieza de cero', () => {
    let h: Evento[] = [];
    h = compactar(h, ev(1, { tipo: 'votacion', estado: 'abierta', ronda: 1 }));
    h = compactar(h, ev(2, { tipo: 'votos', ronda: 1, total: 0 }));
    h = compactar(h, ev(3, { tipo: 'votos', ronda: 1, conteos: ceros }));
    h = compactar(h, ev(4, { tipo: 'votacion', estado: 'cerrada', ronda: 1 }));
    // Al cerrar se conservan los totales de esa ronda.
    expect(h.map((e) => e.seq)).toEqual([3, 4]);
    h = compactar(h, ev(5, { tipo: 'votacion', estado: 'abierta', ronda: 2 }));
    expect(h.map((e) => e.seq)).toEqual([5]);
  });
});
