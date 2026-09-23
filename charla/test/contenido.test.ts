import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { REFERENCIAS, DIAPOSITIVAS, promptResumen, fechaLarga, hoyBogota, CONFIG, type Respaldos } from '../src/contenido.js';
import respaldosJson from '../datos/respaldos.json';

const RESPALDOS = respaldosJson as unknown as Respaldos;
import contenido from '../datos/contenido.json';

const RAIZ = join(__dirname, '..');
const BASE = readFileSync(join(RAIZ, 'base/charla-ia-investigacion.html'), 'utf8');

/** Las REFS tal como están en el script de la presentación base. */
function refsDeLaBase(): { cita: string; doi: string; qTitulo: string; qAutor: string }[] {
  const m = /var REFS = (\[[\s\S]*?\n  \]);/.exec(BASE);
  if (!m) throw new Error('No se encontró REFS en la base');
  return new Function(`return ${m[1]};`)();
}

function seccionesDe(html: string): string[] {
  return html.split(/<section class="slide/).slice(1).map((s) => s.split('</section>')[0]!);
}

function textoPlano(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();
}

describe('las referencias de la demo', () => {
  it('son exactamente las de la presentación base: mismas citas, DOI y consultas', () => {
    const base = refsDeLaBase();
    expect(REFERENCIAS).toHaveLength(5);
    REFERENCIAS.forEach((r, i) => {
      expect(r.n).toBe(i + 1);
      expect({ cita: r.cita, doi: r.doi, qTitulo: r.qTitulo, qAutor: r.qAutor }).toEqual(base[i]);
    });
  });

  it('2 reales y 3 inventadas, y cada título está tal cual dentro de su cita', () => {
    expect(REFERENCIAS.filter((r) => r.fabricada).map((r) => r.n)).toEqual([1, 3, 5]);
    for (const r of REFERENCIAS) {
      expect(r.cita).toContain(r.titulo);
      expect(r.cita.startsWith(r.corta.split(',')[0]!)).toBe(true);
    }
  });

  it('el respaldo de PubMed cuadra con la verdad del ejercicio', () => {
    const p = RESPALDOS.pubmed!;
    expect(p.referencias.map((x) => x.ref)).toEqual([1, 2, 3, 4, 5]);
    for (const v of p.referencias) {
      const ref = REFERENCIAS.find((r) => r.n === v.ref)!;
      expect(v.existe).toBe(!ref.fabricada);
      if (v.existe) {
        expect(v.pmid).toMatch(/^\d+$/);
        expect(v.consultas.at(-1)?.coincide).toBe(true);
      } else {
        expect(v.pmid).toBeUndefined();
        expect(v.consultas.map((c) => c.via)).toEqual(['título', 'DOI', 'autor']);
        expect(v.consultas.every((c) => !c.coincide)).toBe(true);
      }
    }
  });
});

describe('el prompt fijo', () => {
  it('pide el resumen de la referencia 1, con su DOI, en español y de usted', () => {
    const p = promptResumen();
    expect(p).toContain('Resuma');
    expect(p).toContain('los métodos y los resultados principales de este artículo');
    expect(p).toContain(REFERENCIAS[0]!.cita);
    expect(p).toContain(`doi:${REFERENCIAS[0]!.doi}`);
    expect(p).toContain('trate de usted');
  });

  it('usa el modelo pedido para la demo', () => {
    expect(CONFIG.modelo).toBe('claude-sonnet-5');
  });
});

describe('las diapositivas', () => {
  it('son 18 y cada título coincide con el encabezado de su diapositiva', () => {
    const secciones = seccionesDe(BASE);
    expect(secciones).toHaveLength(18);
    expect(DIAPOSITIVAS).toHaveLength(18);
    secciones.forEach((s, i) => {
      const h = /<h[12][^>]*>([\s\S]*?)<\/h[12]>/.exec(s);
      if (i === 2) {
        expect(h).toBeNull();
        return;
      }
      expect(textoPlano(h![1]!)).toBe(DIAPOSITIVAS[i]);
    });
  });
});

describe('fechas', () => {
  it('se escriben en español, sin depender de Intl', () => {
    expect(fechaLarga('2026-09-23')).toBe('23 de septiembre de 2026');
    expect(fechaLarga('2026-10-02')).toBe('2 de octubre de 2026');
  });
  it('el día es el de Bogotá', () => {
    expect(hoyBogota(new Date('2026-10-02T03:00:00Z'))).toBe('2026-10-01');
    expect(hoyBogota(new Date('2026-10-02T06:00:00Z'))).toBe('2026-10-02');
  });
});

describe('sin tuteo en ningún texto visible', () => {
  // Formas de tú que no tienen lectura de usted. «Espera», «revisa» o «verifica»
  // no están: también son tercera persona («Evidentia verifica»).
  const TUTEO = /(?<![\p{L}\p{N}_])(tú|tu|tus|te|ti|contigo|tuyo|tuya|puedes|tienes|quieres|sabes|debes|eres|estás|necesitas|usas|citas|buscas|hazlo|dime|mírala|ábrela|cítala|revísala|vuelve|intenta|espérate|recuerda|olvides|asegúrate|fíjate)(?![\p{L}\p{N}_])/iu;

  const archivos = [
    'base/charla-ia-investigacion.html',
    'datos/contenido.json',
    'datos/respaldos.json',
    ...readdirSync(join(RAIZ, 'web')).map((f) => `web/${f}`),
  ];

  /** Textos entre comillas en JS y texto visible en HTML: lo que puede ver una persona. */
  function textosVisibles(ruta: string, contenidoArchivo: string): string[] {
    if (ruta.endsWith('.json')) {
      const out: string[] = [];
      const recorrer = (v: unknown, clave = ''): void => {
        // Las citas bibliográficas están en inglés: «Berglund TE» no es tuteo.
        if (typeof v === 'string' && !clave.startsWith('_') && !/^(q|doi|url|cita|titulo|corta)/i.test(clave)) out.push(v);
        else if (Array.isArray(v)) v.forEach((x) => recorrer(x, clave));
        else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) recorrer(x, k);
      };
      recorrer(JSON.parse(contenidoArchivo));
      return out;
    }
    if (ruta.endsWith('.html')) {
      const sinScripts = contenidoArchivo.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ');
      const atributos = [...contenidoArchivo.matchAll(/(?:data-notes|title|placeholder|aria-label)="([^"]*)"/g)].map((m) => m[1]!);
      return [textoPlano(sinScripts), ...atributos.map(textoPlano)];
    }
    if (ruta.endsWith('.js')) {
      return [...contenidoArchivo.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)].map((m) => m[1]!).filter((s) => /\s/.test(s));
    }
    return [];
  }

  for (const ruta of archivos) {
    it(`${ruta} trata de usted`, () => {
      const hallazgos = textosVisibles(ruta, readFileSync(join(RAIZ, ruta), 'utf8')).filter((t) => TUTEO.test(t));
      expect(hallazgos).toEqual([]);
    });
  }

  it('los mensajes de error del servidor tratan de usted', () => {
    const src = readdirSync(join(RAIZ, 'src')).filter((f) => f.endsWith('.ts'));
    const hallazgos: string[] = [];
    for (const f of src) {
      const texto = readFileSync(join(RAIZ, 'src', f), 'utf8');
      for (const m of texto.matchAll(/'((?:[^'\\\n]|\\.)*)'/g)) if (/\s/.test(m[1]!) && TUTEO.test(m[1]!)) hallazgos.push(`${f}: ${m[1]}`);
    }
    expect(hallazgos).toEqual([]);
  });

  it('el detector sí detecta el tuteo', () => {
    for (const t of ['¿Tú qué opinas?', 'Revisa tu artículo', 'si puedes', 'tienes que', 'Dime cuál']) expect(TUTEO.test(t)).toBe(true);
    for (const t of ['¿Usted qué opina?', 'Revise su artículo', 'Evidentia verifica', 'tuberculosis', 'estudio']) expect(TUTEO.test(t)).toBe(false);
  });
});

describe('el contenido del kit', () => {
  it('trae un prompt por cada uno de los siete pasos', () => {
    expect(contenido.kit.prompts).toHaveLength(7);
    contenido.kit.prompts.forEach((p, i) => expect(p.startsWith(`Paso 0${i + 1} ·`)).toBe(true));
  });

  it('las líneas rojas son las de la diapositiva 16, textuales', () => {
    const s16 = seccionesDe(BASE)[15]!;
    for (const l of contenido.kit.lineasRojas) {
      expect(textoPlano(s16)).toContain(l.titulo);
      expect(textoPlano(s16)).toContain(l.texto);
    }
  });
});
