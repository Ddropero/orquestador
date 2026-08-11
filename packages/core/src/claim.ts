import type { Span } from './span.js';

/**
 * INVARIANTE 1 — Ninguna afirmación se publica sin su span.
 *
 * El invariante vive en el TIPO, no en la disciplina de quien escribe el código.
 * `spans` es una tupla no vacía: `[Span, ...Span[]]`. Un `Claim` sin respaldo no
 * es que esté prohibido — es que no se puede construir. TypeScript rechaza
 * `spans: []` en tiempo de compilación.
 *
 * La razón de ponerlo aquí y no en una validación es que una validación se puede
 * saltar, olvidar o desactivar bajo presión de entrega. Un tipo no.
 */

/** Al menos un elemento, garantizado por el compilador. */
export type NonEmpty<T> = [T, ...T[]];

export interface Claim {
  id: string;
  /** `runId` de la ejecución que la produjo. */
  runId: string;
  /** La afirmación, en prosa. */
  text: string;
  /**
   * Los fragmentos textuales que la respaldan. AL MENOS UNO, por construcción.
   */
  spans: NonEmpty<Span>;
  /**
   * Si contiene una cifra. Las cifras se verifican al 100% contra el span, porque
   * la exactitud de la IA en datos numéricos cae al 47–88%.
   */
  containsNumeric: boolean;
  /**
   * Si alimenta un juicio metodológico (RoB, GRADE, recomendación). Marcarlo
   * dispara el régimen de supervisión humana del instrumento correspondiente.
   */
  feedsJudgment: boolean;
  /** ISO 8601. */
  createdAt: string;
}

/**
 * Único constructor de `Claim`. Acepta un array normal y estrecha a tupla no vacía,
 * o falla. Es la frontera entre datos de fuera (donde el array puede venir vacío)
 * y el modelo de dentro (donde no puede).
 */
export function makeClaim(input: {
  id: string;
  runId: string;
  text: string;
  spans: Span[];
  containsNumeric?: boolean;
  feedsJudgment?: boolean;
  createdAt?: string;
}): Claim {
  const [first, ...rest] = input.spans;
  if (!first) {
    throw new Error(
      `La afirmación "${input.text.slice(0, 80)}…" no tiene ningún fragmento textual que la ` +
        'respalde. Una afirmación sin span no se publica: es el invariante 1 del sistema.',
    );
  }

  return {
    id: input.id,
    runId: input.runId,
    text: input.text,
    spans: [first, ...rest],
    containsNumeric: input.containsNumeric ?? /\d/.test(input.text),
    feedsJudgment: input.feedsJudgment ?? false,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

/** Las fuentes distintas que respaldan una afirmación. */
export function claimSourceIds(claim: Claim): string[] {
  return [...new Set(claim.spans.map((s) => s.sourceId))];
}
