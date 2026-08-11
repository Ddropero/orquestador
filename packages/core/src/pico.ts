/**
 * PICO y la estrategia de búsqueda que se deriva de él.
 *
 * La estrategia se guarda ENTERA y en texto, no solo sus resultados. Una revisión
 * que no publica su cadena de búsqueda no es reproducible, y una que la publica
 * pero la reconstruye después no es honesta: es la cadena que se ejecutó la que
 * hay que poder auditar.
 */

export type OutcomeImportance = 'critical' | 'important' | 'not-important';

export interface Outcome {
  label: string;
  /** Jerarquía GRADE. Determina qué desenlaces mandan en la certeza global. */
  importance: OutcomeImportance;
}

export interface Pico {
  population: string;
  intervention: string;
  comparator?: string;
  outcomes: Outcome[];
  /** Diseños a los que se acota la búsqueda. Vacío = sin acotar. */
  studyDesigns: string[];
}

/** Un bloque conceptual de la búsqueda, con los términos que lo componen. */
export interface QueryBlock {
  /** Qué concepto PICO representa. */
  concept: 'population' | 'intervention' | 'comparator' | 'outcome' | 'design';
  /** Los términos, ya con su etiqueta de campo. */
  terms: string[];
  /** El bloque montado, con los OR resueltos. */
  rendered: string;
}

/**
 * Filtro metodológico aplicado, con su identidad y versión.
 *
 * Va identificado y versionado porque los filtros validados (Cochrane, SIGN)
 * cambian entre revisiones, y "se usó el filtro de Cochrane" sin decir cuál no
 * permite reproducir la búsqueda.
 */
export interface MethodFilter {
  id: string;
  version: string;
  query: string;
}

export interface SearchStrategy {
  /** La cadena EXACTA que se envió a la fuente. */
  query: string;
  /** Los bloques de los que salió, para poder auditar cómo se montó. */
  blocks: QueryBlock[];
  methodFilter?: MethodFilter;
  /** Sintaxis a la que corresponde `query`. */
  syntax: 'pubmed' | 'europepmc';
  /**
   * Limitaciones conocidas de esta estrategia. Se rellena cuando el PICO venía
   * sin estructurar y la búsqueda es literal, entre otros casos.
   */
  caveats: string[];
}
