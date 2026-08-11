import type { MethodFilter, Pico, QueryBlock, SearchStrategy } from '@evidentia/core';

/**
 * PICO → cadena booleana de PubMed.
 *
 * La estrategia se construye por BLOQUES conceptuales unidos por AND, cada bloque
 * con sus sinónimos unidos por OR. Es la forma canónica de una búsqueda sistemática
 * y, sobre todo, es auditable: un revisor puede leer cada bloque y decir si falta
 * un término, cosa que no puede hacer con una cadena montada de una pieza.
 *
 * Dos decisiones deliberadas:
 *
 * 1. NO se acota por idioma ni por fecha por defecto. Ambos filtros son sesgos de
 *    selección con muy mala prensa en síntesis de evidencia, y si se aplican tienen
 *    que ser una decisión declarada del protocolo, no un valor por omisión oculto.
 *
 * 2. El comparador NO entra en la cadena. Añadirlo como bloque AND es el error
 *    clásico que hunde la sensibilidad: muchos ensayos no mencionan el comparador
 *    en título ni resumen, y exigirlo los elimina de los resultados.
 */

export interface BuildOptions {
  /** Filtro metodológico validado. Se aplica con AND al final. */
  methodFilter?: MethodFilter;
  /** Sinónimos adicionales por término, si un paso previo los propuso. */
  synonyms?: Record<string, string[]>;
}

export function buildPubmedQuery(pico: Pico, options: BuildOptions = {}): SearchStrategy {
  const caveats: string[] = [];
  const blocks: QueryBlock[] = [];

  const population = buildBlock('population', pico.population, options.synonyms);
  if (population) blocks.push(population);

  const intervention = buildBlock('intervention', pico.intervention, options.synonyms);
  if (intervention) blocks.push(intervention);

  // Los desenlaces se añaden SOLO si hay críticos, y aun así unidos por OR entre
  // sí. Un desenlace es un dato que se extrae del estudio, no un criterio de
  // elegibilidad: filtrar por él pierde estudios que lo midieron sin anunciarlo.
  const critical = pico.outcomes.filter((o) => o.importance === 'critical');
  if (critical.length > 0) {
    const terms = critical.flatMap((o) => fieldTags(o.label));
    if (terms.length > 0) {
      blocks.push({ concept: 'outcome', terms, rendered: `(${terms.join(' OR ')})` });
      caveats.push(
        'Se acotó por desenlaces críticos. Puede perder estudios que midieron el ' +
          'desenlace sin nombrarlo en el título o el resumen.',
      );
    }
  }

  if (pico.studyDesigns.length > 0) {
    const terms = pico.studyDesigns.flatMap((d) => fieldTags(d));
    if (terms.length > 0) {
      blocks.push({ concept: 'design', terms, rendered: `(${terms.join(' OR ')})` });
    }
  }

  if (blocks.length === 0) {
    // Ni población ni intervención utilizables. Se busca la pregunta literal antes
    // que devolver una cadena vacía que traería el corpus entero.
    const literal = sanitize(`${pico.population} ${pico.intervention}`).slice(0, 200);
    caveats.push(
      'No se pudo estructurar la búsqueda por bloques: se usó la pregunta literal. ' +
        'La sensibilidad de esta búsqueda es sustancialmente menor.',
    );
    return {
      query: literal,
      blocks: [],
      syntax: 'pubmed',
      caveats,
    };
  }

  if (!pico.comparator) {
    caveats.push('Sin comparador declarado en el PICO.');
  }

  let query = blocks.map((b) => b.rendered).join(' AND ');

  if (options.methodFilter) {
    query = `(${query}) AND (${options.methodFilter.query})`;
  }

  return {
    query,
    blocks,
    ...(options.methodFilter ? { methodFilter: options.methodFilter } : {}),
    syntax: 'pubmed',
    caveats,
  };
}

/**
 * Monta un bloque conceptual. Cada concepto se busca en `[tiab]` (título y resumen)
 * y como término MeSH, porque ninguno de los dos por separado es suficiente: MeSH
 * no cubre lo publicado en los últimos meses y `tiab` no cubre la indexación.
 */
function buildBlock(
  concept: QueryBlock['concept'],
  raw: string,
  synonyms?: Record<string, string[]>,
): QueryBlock | undefined {
  const phrase = sanitize(raw);
  if (phrase.length < 2) return undefined;

  const variants = new Set<string>([phrase]);
  for (const extra of synonyms?.[raw] ?? synonyms?.[phrase] ?? []) {
    const clean = sanitize(extra);
    if (clean.length >= 2) variants.add(clean);
  }

  const terms = [...variants].flatMap((v) => fieldTags(v));
  if (terms.length === 0) return undefined;

  return { concept, terms, rendered: `(${terms.join(' OR ')})` };
}

/** Cada término entra dos veces: como texto libre y como descriptor MeSH. */
function fieldTags(raw: string): string[] {
  const term = sanitize(raw);
  if (term.length < 2) return [];
  return [`"${term}"[tiab]`, `"${term}"[mh]`];
}

/**
 * Limpia un término para que no rompa la sintaxis de PubMed.
 *
 * Los corchetes y paréntesis son operadores de campo y de agrupación: dejarlos
 * pasar desde texto generado por un modelo produce cadenas que PubMed rechaza, o
 * peor, que interpreta de forma distinta a la que se pretendía.
 */
function sanitize(raw: string): string {
  return raw
    .replace(/["[\]()]/g, ' ')
    .replace(/\b(AND|OR|NOT)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}
