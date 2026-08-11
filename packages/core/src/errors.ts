/**
 * La distinción que sostiene la credibilidad del sistema:
 * "no pude preguntar" NO es "no existe".
 *
 * Si una caída de Crossref se registra como NOT_FOUND, el sistema acusa de citas
 * fabricadas a toda la bibliografía que tocó durante la caída. Es el fallo más
 * caro que puede cometer una herramienta de integridad, porque destruye la
 * confianza en la herramienta y de paso la del autor acusado.
 *
 * Por eso el estado de una comprobación tiene TRES valores, no dos.
 */

export type ResolutionStatus =
  /** El registro existe y se confirmó. */
  | 'FOUND'
  /** Se preguntó, la fuente respondió, y no existe. Es una afirmación positiva. */
  | 'NOT_FOUND'
  /**
   * No se pudo determinar: red caída, tiempo agotado, límite de peticiones, 5xx.
   * No dice NADA sobre si el registro existe.
   */
  | 'UNRESOLVED';

/** Error de red o de la fuente. Siempre se traduce a UNRESOLVED, nunca a NOT_FOUND. */
export class UnresolvedError extends Error {
  override readonly name = 'UnresolvedError';
  constructor(
    /** Qué fuente falló (`crossref`, `pubmed`, …). */
    readonly source: string,
    /** Por qué. Va al registro de auditoría. */
    readonly reason: string,
    override readonly cause?: unknown,
  ) {
    super(`[${source}] no se pudo resolver: ${reason}`);
  }
}

/**
 * Traduce un fallo cualquiera a `UNRESOLVED`.
 *
 * Deliberadamente NO intenta distinguir un 404 de un fallo de red para decidir
 * NOT_FOUND: un 404 de un endpoint mal formado, de un proxy o de un servicio en
 * mantenimiento es indistinguible de un 404 legítimo desde aquí. Solo el adaptador
 * de cada fuente, que conoce su contrato, tiene derecho a afirmar NOT_FOUND.
 */
export function toUnresolved(source: string, error: unknown): UnresolvedError {
  if (error instanceof UnresolvedError) return error;
  const reason = error instanceof Error ? error.message : String(error);
  return new UnresolvedError(source, reason.slice(0, 300), error);
}

/** Códigos HTTP que nunca justifican concluir NOT_FOUND. */
export function isTransientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}
