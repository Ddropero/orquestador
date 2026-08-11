import type { SourceIds } from './ids.js';

/**
 * Un trabajo recuperado de una fuente.
 *
 * `Source` describe el REGISTRO bibliográfico, no su contenido. El contenido (los
 * fragmentos textuales que respaldan afirmaciones) vive en `Span`, y la relación
 * entre ambos es lo que hace auditable el sistema.
 */

/** Diseño del estudio. `unknown` es un valor legítimo y frecuente: nunca se adivina. */
export type StudyDesign =
  | 'rct'
  | 'non-randomized-trial'
  | 'cohort'
  | 'case-control'
  | 'cross-sectional'
  | 'diagnostic-accuracy'
  | 'systematic-review'
  | 'meta-analysis'
  | 'guideline'
  | 'case-report'
  | 'narrative-review'
  | 'qualitative'
  | 'economic'
  | 'unknown';

/**
 * Estado editorial de un trabajo.
 *
 * El orden importa y está codificado en `dedupe.mergeSources`: al fusionar dos
 * copias del mismo trabajo, el estado NUNCA mejora. Si una copia dice retractada,
 * la fusión está retractada.
 *
 * `unknown` significa "no comprobado", no "limpio". La diferencia es todo el punto:
 * una salida que trata lo no comprobado como limpio miente por omisión.
 */
export type EditorialStatus =
  | 'retracted'
  | 'withdrawn'
  | 'concern'
  | 'corrected'
  | 'ok'
  | 'unknown';

/** Estados que impiden citar el trabajo como evidencia de apoyo. */
export const BLOCKING_EDITORIAL: readonly EditorialStatus[] = ['retracted', 'withdrawn'];

export function isBlocking(status: EditorialStatus): boolean {
  return BLOCKING_EDITORIAL.includes(status);
}

export interface EditorialRecord {
  status: EditorialStatus;
  /** Texto del aviso, cuando el registro lo publica. */
  notice?: string;
  /** ISO 8601. Ausente mientras no se haya comprobado. */
  checkedAt?: string;
  /**
   * Contra qué registros se comprobó (`crossref`, `pubmed`, …).
   *
   * Vacío significa que no se comprobó contra ninguno. Se guarda explícitamente
   * porque "comprobado contra Crossref y salió limpio" y "no se pudo preguntar"
   * son afirmaciones distintas, y la salida tiene que poder distinguirlas.
   */
  checkedAgainst: string[];
}

export interface Source {
  /** Clave estable derivada del identificador externo más fiable. Ver `sourceKey`. */
  id: string;
  ids: SourceIds;
  title: string;
  authors: string[];
  year?: number;
  journal?: string;
  abstract?: string;
  design: StudyDesign;
  editorial: EditorialRecord;
  /** Licencia declarada por la fuente. Condiciona si el texto se puede almacenar. */
  license?: string;
  /** Clave en R2 del texto completo, si se pudo obtener y la licencia lo permite. */
  fullTextKey?: string;
  /** Qué adaptador lo recuperó (`pubmed`, `europepmc`, …). */
  retrievedFrom: string;
  /** ISO 8601. */
  retrievedAt: string;
  openAccess: boolean;
}

/** Estado editorial de partida: no comprobado, no "limpio". */
export function uncheckedEditorial(): EditorialRecord {
  return { status: 'unknown', checkedAgainst: [] };
}
