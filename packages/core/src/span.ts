/**
 * Un fragmento textual exacto de una fuente.
 *
 * `Span` es la unidad que hace defendible el sistema. No es una referencia
 * bibliográfica ni un resumen: es el texto literal, con su posición, tal como
 * aparece en el documento. Un revisor par puede abrir la fuente y encontrarlo.
 */

export type SpanSection =
  | 'title'
  | 'abstract'
  | 'methods'
  | 'results'
  | 'discussion'
  | 'conclusion'
  | 'table'
  | 'figure'
  | 'other';

export interface Span {
  id: string;
  /** `Source.id` del que salió. */
  sourceId: string;
  /** El texto LITERAL. No parafraseado, no normalizado, no recortado por el modelo. */
  text: string;
  section: SpanSection;
  /** Desplazamiento en el texto del que se extrajo, si se conoce. */
  charStart?: number;
  charEnd?: number;
  page?: number;
  /**
   * Hash del texto. Permite detectar que la fuente cambió bajo nuestros pies:
   * un span cuyo hash ya no coincide con el documento dejó de ser verificable.
   */
  textHash: string;
  /** ISO 8601. */
  extractedAt: string;
}

/** SHA-256 en hexadecimal del texto normalizado en espacios. */
export async function hashSpanText(text: string): Promise<string> {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const bytes = new TextEncoder().encode(normalized);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
