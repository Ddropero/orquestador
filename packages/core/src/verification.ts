import type { ResolutionStatus } from './errors.js';

/**
 * E0–E5: las capas de verificación de una afirmación.
 *
 *   E0  existencia         ¿la referencia existe? (determinista)
 *   E1  correspondencia    ¿los metadatos coinciden con lo citado?
 *   E2  integridad         ¿está retractada o bajo aviso? (determinista)
 *   E3  entailment         ¿el span respalda de verdad la afirmación?
 *   E4  desacuerdo         ¿dos pasadas independientes dicen lo mismo?
 *   E5  compuerta humana   escala a persona cuando E3/E4 no concluyen
 *
 * E0 y E2 son deterministas y no negociables. E3 usa modelos, y por eso E4 existe:
 * una sola pasada de un modelo sobre "¿este texto respalda esta afirmación?" no es
 * evidencia de nada. Dos pasadas que discrepan escalan a E5 en vez de elegir una.
 */

export type SupportVerdict =
  /** El span afirma lo que la afirmación dice. */
  | 'supports'
  /** El span dice lo contrario. */
  | 'contradicts'
  /** El span habla del tema pero no permite concluir. */
  | 'insufficient'
  /** El span no viene al caso. */
  | 'unrelated';

/** Una pasada individual de verificación. Se guardan todas, no solo la ganadora. */
export interface VerificationRun {
  /** Qué la ejecutó: identificador de modelo, o de la persona. */
  by: string;
  kind: 'human' | 'machine';
  verdict: SupportVerdict;
  /** Confianza declarada por el evaluador, si la declara. */
  confidence?: number;
  rationale?: string;
  /** ISO 8601. */
  ranAt: string;
}

export interface Verification {
  id: string;
  claimId: string;
  /** E0. `UNRESOLVED` cuando no se pudo preguntar — nunca se convierte en NOT_FOUND. */
  existence: ResolutionStatus;
  /** E2. Si el trabajo está retractado o retirado, la afirmación no se publica. */
  editorialBlocked: boolean;
  /** E3. Ausente mientras no se haya evaluado. */
  support?: SupportVerdict;
  /** E4. Dos pasadas independientes llegaron a veredictos distintos. */
  disagreement: boolean;
  /** E5. Está esperando a una persona. */
  escalated: boolean;
  escalationReason?: string;
  /** Quién la resolvió, cuando se resolvió. */
  resolvedBy?: string;
  resolvedAt?: string;
  /** Todas las pasadas, en orden. Es el registro de auditoría de la verificación. */
  runs: VerificationRun[];
}

/**
 * Decide si una afirmación puede publicarse.
 *
 * Es deliberadamente conservadora: cualquier cosa que no sea un "sí" claro impide
 * publicar. `UNRESOLVED` bloquea igual que `NOT_FOUND` — no porque sean lo mismo,
 * sino porque ninguno de los dos autoriza a publicar. La diferencia entre ambos
 * está en el motivo que se le comunica al usuario, no en el permiso.
 */
export function isPublishable(v: Verification): { ok: boolean; reason?: string } {
  if (v.editorialBlocked) {
    return { ok: false, reason: 'La fuente está retractada o retirada.' };
  }
  if (v.existence === 'NOT_FOUND') {
    return { ok: false, reason: 'La referencia no existe en los registros consultados.' };
  }
  if (v.existence === 'UNRESOLVED') {
    return {
      ok: false,
      reason:
        'No se pudo comprobar la existencia de la referencia (fallo de la fuente, no ' +
        'ausencia del registro). Vuelve a intentarlo antes de concluir nada.',
    };
  }
  if (v.escalated && !v.resolvedBy) {
    return { ok: false, reason: 'Escalada a revisión humana y todavía sin resolver.' };
  }
  if (v.disagreement && !v.resolvedBy) {
    return { ok: false, reason: 'Las pasadas de verificación discrepan y nadie lo ha resuelto.' };
  }
  if (v.support !== 'supports') {
    return { ok: false, reason: `El fragmento no respalda la afirmación (${v.support ?? 'sin evaluar'}).` };
  }
  return { ok: true };
}

/** Detecta discrepancia entre pasadas automáticas. Dos veredictos distintos escalan. */
export function detectDisagreement(runs: VerificationRun[]): boolean {
  const machineVerdicts = new Set(runs.filter((r) => r.kind === 'machine').map((r) => r.verdict));
  return machineVerdicts.size > 1;
}
