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
