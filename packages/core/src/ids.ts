/**
 * Identificadores.
 *
 * El DOI se normaliza SIEMPRE a minúsculas y sin prefijo de resolver, porque es la
 * clave con la que se deduplica. Dos registros del mismo trabajo que difieran solo
 * en `https://doi.org/` o en mayúsculas serían dos trabajos distintos para el
 * deduplicador, y eso infla el recuento de evidencia con copias del mismo estudio.
 */

/** Identificadores externos de un trabajo. Todos opcionales: hay literatura sin DOI. */
export interface SourceIds {
  /** DOI normalizado: minúsculas, sin `doi:` ni `https://doi.org/`. */
  doi?: string;
  /** PMID, solo dígitos. */
  pmid?: string;
  /** PMCID en mayúsculas, con el prefijo `PMC`. */
  pmcid?: string;
  /** Registro de ensayo clínico (NCT…, ISRCTN…), cuando lo declara. */
  trialId?: string;
}

const DOI_PREFIXES = [/^https?:\/\/(dx\.)?doi\.org\//i, /^doi:\s*/i];

/**
 * Normaliza un DOI. Devuelve `undefined` si no parece un DOI, en vez de devolver
 * basura: un DOI inválido usado como clave de identidad fusiona trabajos distintos.
 */
export function normalizeDoi(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  let doi = raw.trim();
  for (const prefix of DOI_PREFIXES) doi = doi.replace(prefix, '');
  doi = doi.trim().replace(/[.,;]+$/, '').toLowerCase();
  // Todo DOI empieza por "10." seguido del prefijo de registrante y una barra.
  return /^10\.\d{4,9}\/\S+$/.test(doi) ? doi : undefined;
}

/** Normaliza un PMID. Solo dígitos, sin ceros a la izquierda. */
export function normalizePmid(raw: string | number | null | undefined): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  const pmid = String(raw).trim().replace(/^0+/, '');
  return /^\d{1,9}$/.test(pmid) ? pmid : undefined;
}

/** Normaliza un PMCID a la forma `PMC1234567`. */
export function normalizePmcid(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const digits = String(raw).trim().toUpperCase().replace(/^PMC/, '');
  return /^\d{1,9}$/.test(digits) ? `PMC${digits}` : undefined;
}

/**
 * Identificador estable de un registro dentro del sistema.
 *
 * Se deriva del identificador externo más fiable disponible, de modo que el mismo
 * trabajo recuperado desde PubMed y desde Europe PMC produzca el MISMO `id` y el
 * deduplicador no tenga que adivinar.
 */
export function sourceKey(ids: SourceIds, fallback: string): string {
  if (ids.doi) return `doi:${ids.doi}`;
  if (ids.pmid) return `pmid:${ids.pmid}`;
  if (ids.pmcid) return `pmcid:${ids.pmcid}`;
  return `local:${fallback}`;
}
