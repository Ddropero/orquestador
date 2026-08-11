import type { Source, StudyDesign } from '@evidentia/core';
import type { HttpClient, PoliteConfig } from '@evidentia/verify';

/**
 * Registro de adaptadores de fuente.
 *
 * Cada adaptador declara su RÉGIMEN DE LICENCIA junto al código, no en un
 * documento aparte. Lo que se puede almacenar y lo que solo se puede consultar al
 * vuelo cambia por fuente, y una integración que no lo declara acaba guardando
 * texto completo que no tenía derecho a guardar.
 */

export interface SearchOptions {
  limit: number;
  /** Desplazamiento para paginar. */
  offset?: number;
}

export interface SearchResult {
  sources: Source[];
  /** Cuántos resultados dice tener la fuente en total. */
  total: number;
  /** Había más de los que se trajeron. La salida tiene que poder decirlo. */
  truncated: boolean;
}

export type LicenseRegime =
  /** Metadatos y resúmenes almacenables. */
  | 'metadata-storable'
  /** Texto completo almacenable cuando la licencia del trabajo lo permite. */
  | 'fulltext-conditional'
  /** Solo consulta al vuelo; nada se persiste más allá de los identificadores. */
  | 'query-only';

export interface SourceAdapter {
  id: string;
  name: string;
  license: LicenseRegime;
  /** Nota sobre los términos, para que quede junto al código que los cumple. */
  licenseNote: string;
  search(
    query: string,
    options: SearchOptions,
    http: HttpClient,
    config: PoliteConfig,
  ): Promise<SearchResult>;
}

/**
 * Mapea el tipo de publicación declarado por la fuente a un diseño de estudio.
 *
 * Ante la duda devuelve `unknown`. Adivinar el diseño es tentador porque rellena
 * la tabla, pero el diseño condiciona el instrumento de riesgo de sesgo que se
 * aplica después: un ensayo mal etiquetado como cohorte se valora con el
 * instrumento equivocado y el error se propaga hasta la recomendación.
 */
export function classifyDesign(publicationTypes: string[]): StudyDesign {
  const types = publicationTypes.map((t) => t.toLowerCase());
  const has = (needle: string) => types.some((t) => t.includes(needle));

  if (has('meta-analysis')) return 'meta-analysis';
  if (has('systematic review')) return 'systematic-review';
  if (has('practice guideline') || has('guideline')) return 'guideline';
  if (has('randomized controlled trial')) return 'rct';
  if (has('controlled clinical trial') || has('clinical trial')) return 'non-randomized-trial';
  if (has('case reports')) return 'case-report';
  if (has('review')) return 'narrative-review';
  if (has('observational study')) return 'cohort';
  if (has('comparative study')) return 'cohort';
  return 'unknown';
}

/** Año a partir de una fecha de publicación en cualquiera de sus mil formatos. */
export function parseYear(raw: string | number | null | undefined): number | undefined {
  if (raw === null || raw === undefined) return undefined;
  const match = String(raw).match(/(1[89]\d{2}|20\d{2}|21\d{2})/);
  if (!match) return undefined;
  const year = Number(match[1]);
  return Number.isFinite(year) ? year : undefined;
}
