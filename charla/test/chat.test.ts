import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { crearClienteNcbi, extraerArticulos, textoXml } from '../src/pubmed.js';
import { promptChat, revisarCitas, fuenteDe } from '../src/chat.js';
import { sanear, compactar, type Evento } from '../src/eventos.js';
import { CHAT } from '../src/contenido.js';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
/** Respuesta real de efetch para los tres PMID de la consulta fija, guardada el 29 de septiembre de 2026. */
const XML = readFileSync(join(RAIZ, 'test/fixtures/efetch-chat.xml'), 'utf8');
const PMIDS = ['24811411', '17163267', '25640810'];

describe('leer los artículos de PubMed (efetch)', () => {
  it('saca PMID, título, revista, año y resumen de cada artículo', () => {
    const a = extraerArticulos(XML);
    expect(a.map((x) => x.pmid).sort()).toEqual([...PMIDS].sort());
    const bmj = a.find((x) => x.pmid === '24811411')!;
    expect(bmj.titulo).toBe(
      'Oseltamivir for influenza in adults and children: systematic review of clinical study reports and summary of regulatory comments.',
    );
    expect(bmj.revista).toBe('BMJ');
    expect(bmj.anio).toBe(2014);
    // Las secciones del resumen conservan su etiqueta y las entidades quedan resueltas.
    expect(bmj.resumen).toContain('RESULTS: ');
    expect(bmj.resumen).toContain('16.8 hours');
    expect(bmj.resumen).toContain('P<0.001');
    const lancet = a.find((x) => x.pmid === '25640810')!;
    expect(lancet.revista).toBe('Lancet');
    expect(lancet.anio).toBe(2015);
  });

  it('el PMID es el del artículo, no el de los comentarios que cita', () => {
    // El XML de la Lancet trae decenas de <PMID> en «Comment in»: manda el primero.
    const lancet = extraerArticulos(XML).find((x) => x.titulo.startsWith('Oseltamivir treatment for influenza in adults'));
    expect(lancet?.pmid).toBe('25640810');
  });

  it('textoXml quita etiquetas y resuelve entidades sin confundir «&lt;» con una etiqueta', () => {
    expect(textoXml('<i>Influenza</i> A &amp; B, P&lt;0.05, 5&#x2009;mg y &#8805;2')).toBe('Influenza A & B, P<0.05, 5 mg y ≥2');
    expect(textoXml(undefined)).toBe('');
  });

  it('el cliente pide efetch en XML con tool y email, y devuelve en el orden pedido', async () => {
    const pedidas: URL[] = [];
    const fetchImpl = (async (entrada: string) => {
      pedidas.push(new URL(entrada));
      return new Response(XML, { status: 200, headers: { 'content-type': 'text/xml' } });
    }) as unknown as typeof fetch;
    const c = crearClienteNcbi({ tool: 'charla-prueba', email: 'prueba@example.com', fetchImpl, dormir: async () => {}, ahora: () => 0 });
    const leidos = await c.leer(['25640810', '24811411']);
    expect(leidos.map((a) => a.pmid)).toEqual(['25640810', '24811411']);
    const u = pedidas[0]!;
    expect(u.pathname.endsWith('/efetch.fcgi')).toBe(true);
    expect(u.searchParams.get('retmode')).toBe('xml');
    expect(u.searchParams.get('tool')).toBe('charla-prueba');
    expect(u.searchParams.get('email')).toBe('prueba@example.com');
  });

  it('una página que no es de PubMed (un desafío antibot) es un error, no cero artículos', async () => {
    const fetchImpl = (async () => new Response('<html>desafío</html>', { status: 200 })) as unknown as typeof fetch;
    const c = crearClienteNcbi({ tool: 't', email: 'e@example.com', fetchImpl, dormir: async () => {}, ahora: () => 0 });
    await expect(c.leer(['1'])).rejects.toThrow(/no es de PubMed/);
  });

  it('la búsqueda del chat pide solo los primeros por relevancia', async () => {
    const pedidas: URL[] = [];
    const fetchImpl = (async (entrada: string) => {
      pedidas.push(new URL(entrada));
      return Response.json({ esearchresult: { count: '3', idlist: PMIDS } });
    }) as unknown as typeof fetch;
    const c = crearClienteNcbi({ tool: 't', email: 'e@example.com', fetchImpl, dormir: async () => {}, ahora: () => 0 });
    const r = await c.buscar(CHAT.consulta, { retmax: CHAT.articulos, orden: 'relevance' });
    expect(r).toEqual({ total: 3, ids: PMIDS });
    expect(pedidas[0]!.searchParams.get('term')).toBe(CHAT.consulta);
    expect(pedidas[0]!.searchParams.get('retmax')).toBe('3');
    expect(pedidas[0]!.searchParams.get('sort')).toBe('relevance');
  });
});

describe('el prompt y las citas del chat', () => {
  const articulos = extraerArticulos(XML);

  it('el prompt lleva la instrucción fija, la pregunta y los resúmenes con su PMID; nada más', () => {
    const p = promptChat(CHAT.instruccion, CHAT.pregunta, articulos);
    expect(p.startsWith(CHAT.instruccion)).toBe(true);
    expect(p).toContain(`Pregunta: ${CHAT.pregunta}`);
    for (const a of articulos) {
      expect(p).toContain(`PMID ${a.pmid}`);
      expect(p).toContain(a.titulo);
    }
    expect(CHAT.instruccion).toMatch(/SOLO los resúmenes/);
    expect(CHAT.instruccion).toMatch(/trate de usted/);
  });

  it('recorta un resumen muy largo para que el prompt no se dispare', () => {
    const largo = { ...articulos[0]!, resumen: 'x'.repeat(10_000) };
    expect(promptChat('i', 'p', [largo]).length).toBeLessThan(4_000);
  });

  it('las citas a PMID leídos se conservan, en orden y sin repetir', () => {
    const r = revisarCitas('Acorta los síntomas [PMID 24811411] unas 17 horas [PMID 25640810] y [PMID 24811411].', PMIDS);
    expect(r.citados).toEqual(['24811411', '25640810']);
    expect(r.ajenos).toEqual([]);
    expect(r.texto).toBe('Acorta los síntomas [PMID 24811411] unas 17 horas [PMID 25640810] y [PMID 24811411].');
  });

  it('un PMID que no salió de la búsqueda se retira del texto y se informa', () => {
    const r = revisarCitas('Reduce complicaciones [PMID 99999999] y síntomas (PMID: 24811411).', PMIDS);
    expect(r.ajenos).toEqual(['99999999']);
    expect(r.citados).toEqual(['24811411']);
    expect(r.texto).not.toContain('99999999');
    expect(r.texto).toContain('[cita retirada: ese PMID no salió de la búsqueda]');
    expect(r.texto).toContain('(PMID 24811411)');
  });

  it('la fuente pública es el artículo de PubMed, sin el resumen', () => {
    const f = fuenteDe(articulos[0]!);
    expect(Object.keys(f).sort()).toEqual(['anio', 'pmid', 'revista', 'titulo']);
  });
});

describe('los eventos del chat', () => {
  const t = 1000;

  it('chat_paso: paso, estado y cifra conocidos; nada más', () => {
    expect(sanear({ tipo: 'chat_paso', paso: 'busqueda', estado: 'completada', cifra: 3, prompt: 'x' }, t, 1)).toEqual({
      ts: t,
      seq: 1,
      tipo: 'chat_paso',
      paso: 'busqueda',
      estado: 'completada',
      cifra: 3,
    });
    expect(sanear({ tipo: 'chat_paso', paso: 'otro', estado: 'completada' }, t, 1)).toBeNull();
    expect(sanear({ tipo: 'chat_paso', paso: 'lectura', estado: 'completada', cifra: -1 }, t, 1)).toBeNull();
    expect(sanear({ tipo: 'chat_paso', paso: 'lectura', estado: 'completada', cifra: 2, ensayo: true }, t, 1)).toMatchObject({ ensayo: true });
  });

  it('chat_fuentes: cada fuente con PMID y título; una fuente dudosa tumba el evento', () => {
    const bien = sanear(
      { tipo: 'chat_fuentes', fuentes: [{ pmid: '24811411', titulo: 'Título', revista: 'BMJ', anio: 2014, resumen: 'no debe salir' }] },
      t,
      2,
    );
    expect(bien).toEqual({ ts: t, seq: 2, tipo: 'chat_fuentes', fuentes: [{ pmid: '24811411', titulo: 'Título', revista: 'BMJ', anio: 2014 }] });
    expect(sanear({ tipo: 'chat_fuentes', fuentes: [{ pmid: 'abc', titulo: 'T', revista: 'R' }] }, t, 2)).toBeNull();
    expect(sanear({ tipo: 'chat_fuentes', fuentes: [{ pmid: '1', titulo: '', revista: 'R' }] }, t, 2)).toBeNull();
    expect(sanear({ tipo: 'chat_fuentes', fuentes: [] }, t, 2)).toBeNull();
    const seis = Array.from({ length: 6 }, (_, i) => ({ pmid: String(i + 1), titulo: 'T', revista: 'R' }));
    expect(sanear({ tipo: 'chat_fuentes', fuentes: seis }, t, 2)).toBeNull();
    const repetidas = [{ pmid: '1', titulo: 'T', revista: 'R' }, { pmid: '1', titulo: 'T', revista: 'R' }];
    expect(sanear({ tipo: 'chat_fuentes', fuentes: repetidas }, t, 2)).toBeNull();
  });

  it('chat_texto: texto limpio y con tope, como el de Claude', () => {
    expect(sanear({ tipo: 'chat_texto', texto_parcial: 'Hola‮ mundo' }, t, 3)).toEqual({ ts: t, seq: 3, tipo: 'chat_texto', texto_parcial: 'Hola mundo' });
    expect(sanear({ tipo: 'chat_texto', texto_parcial: '' }, t, 3)).toBeNull();
  });

  it('compactar: del chat queda el último de cada paso, las últimas fuentes y el último texto; una pregunta nueva lo borra', () => {
    let h: Evento[] = [];
    let seq = 0;
    const add = (e: Record<string, unknown>) => {
      h = compactar(h, sanear(e, t, ++seq)!);
    };
    add({ tipo: 'demo_inicio', tema: 'resumen' });
    add({ tipo: 'claude_texto', texto_parcial: 'demo 1' });
    add({ tipo: 'demo_inicio', tema: 'chat' });
    add({ tipo: 'chat_paso', paso: 'busqueda', estado: 'en curso' });
    add({ tipo: 'chat_paso', paso: 'busqueda', estado: 'completada', cifra: 3 });
    add({ tipo: 'chat_fuentes', fuentes: [{ pmid: '1', titulo: 'T', revista: 'R' }] });
    add({ tipo: 'chat_texto', texto_parcial: 'a' });
    add({ tipo: 'chat_texto', texto_parcial: 'ab' });
    expect(h.filter((e) => e.tipo === 'chat_paso')).toHaveLength(1);
    expect(h.filter((e) => e.tipo === 'chat_texto')).toHaveLength(1);
    // El texto de la demo 1 no se toca: la comparación del modelo frente a PubMed sigue ahí.
    expect(h.some((e) => e.tipo === 'claude_texto')).toBe(true);
    add({ tipo: 'demo_inicio', tema: 'chat' });
    expect(h.some((e) => e.tipo.startsWith('chat_'))).toBe(false);
    expect(h.some((e) => e.tipo === 'claude_texto')).toBe(true);
  });
});
