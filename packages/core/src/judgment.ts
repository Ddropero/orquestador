/**
 * INVARIANTE 2 — La IA nunca emite el juicio.
 *
 * Riesgo de sesgo, certeza GRADE y recomendación los emite una persona. No es
 * cautela decorativa, son las cifras:
 *
 *   Concordancia κ de la IA con evaluadores humanos (2025–2026):
 *     RoB 2                   0,06 – 0,13   ← peor que el azar en algunos dominios
 *     Newcastle-Ottawa (RAG)  0,08 – 0,27
 *     RoB 1                   0,27 – 0,39
 *     RoB Cochrane (GPT-4o)   0,43
 *     Concordancia sustancial ≥ 0,60
 *
 *   Exactitud en extracción de datos:
 *     IA, datos numéricos     47 – 88%
 *     Solo humano                   89,0%
 *     IA + humano                   91,0%   ← aquí sí se automatiza
 *
 * El régimen permitido se declara en cada instrumento YAML (`automation.regime`)
 * en `evidentia-instruments`, y `assertRegime` lo hace cumplir en ejecución.
 */

export type AutomationRegime =
  /** La IA puede emitirlo sola. Solo para tareas mecánicas y reversibles. */
  | 'automated'
  /** La IA propone, una persona confirma cada elemento. */
  | 'ai-assisted'
  /** La IA solo adjunta fragmentos candidatos. El veredicto lo pone una persona. */
  | 'human-judgment';

export interface JudgeRef {
  kind: 'human' | 'machine';
  /** Identificador estable: ORCID de la persona, o id de modelo con versión. */
  identifier: string;
}

export interface Judgment {
  id: string;
  /** Qué se juzga: un `Source.id`, un `Claim.id`, o el `runId` de la síntesis. */
  subjectId: string;
  /** Instrumento aplicado (`rob2`, `grade`, `amstar2`, …) y su versión exacta. */
  instrumentId: string;
  instrumentVersion: string;
  /**
   * El instrumento se aplicó sin poder verificar su integridad contra el repo de
   * instrumentos. El juicio vale, pero la salida tiene que decirlo.
   */
  instrumentUnverified: boolean;
  /** Dominio dentro del instrumento (p. ej. `randomization-process` en RoB 2). */
  domain: string;
  verdict: string;
  rationale?: string;
  /** Los spans en los que se apoya. La IA los adjunta; el veredicto no es suya. */
  spanIds: string[];
  by: JudgeRef;
  /** ISO 8601. */
  emittedAt: string;
}

/**
 * Hace cumplir el invariante 2 en tiempo de ejecución.
 *
 * Se llama ANTES de escribir cualquier juicio. Un `Judgment` con `by.kind === 'machine'`
 * bajo régimen `human-judgment` no se guarda: lanza. No hay bandera de configuración
 * para desactivarlo, y esa ausencia es intencionada.
 */
export function assertRegime(judgment: Judgment, regime: AutomationRegime): void {
  if (regime === 'human-judgment' && judgment.by.kind === 'machine') {
    throw new Error(
      `El instrumento ${judgment.instrumentId}@${judgment.instrumentVersion} declara régimen ` +
        `"human-judgment" en el dominio "${judgment.domain}", pero el juicio venía firmado por ` +
        `la máquina "${judgment.by.identifier}". La concordancia de la IA con evaluadores ` +
        'humanos en este tipo de instrumento es κ 0,06–0,13: peor que el azar. ' +
        'La IA puede adjuntar spans candidatos; el veredicto lo emite una persona.',
    );
  }

  if (regime === 'ai-assisted' && judgment.by.kind === 'machine' && judgment.spanIds.length === 0) {
    throw new Error(
      `El instrumento ${judgment.instrumentId}@${judgment.instrumentVersion} admite régimen ` +
        '"ai-assisted", pero un juicio de máquina sin spans no se puede confirmar. ' +
        'Adjunta los fragmentos en los que se apoya para que una persona los revise.',
    );
  }
}

/** Los juicios que exigen persona en cualquier instrumento, sea cual sea su régimen. */
export const ALWAYS_HUMAN = ['recommendation', 'grade-certainty', 'rob-overall'] as const;

export function requiresHuman(domain: string): boolean {
  return (ALWAYS_HUMAN as readonly string[]).includes(domain);
}
