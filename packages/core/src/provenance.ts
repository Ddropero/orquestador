/**
 * Declaración de uso de IA.
 *
 * Cada vez que un modelo toca el material se deja constancia de qué modelo, en qué
 * etapa, para qué, y con cuánta supervisión humana. No es transparencia decorativa:
 * es el requisito de TRIPOD-LLM y de las políticas editoriales de ICMJE y COPE, y
 * es lo que permite a un revisor par decidir cuánto se fía de cada parte.
 *
 * Se registra también cuando el modelo FALLA y se cayó al respaldo determinista,
 * porque "aquí no intervino IA" también es información.
 */

export type Supervision =
  /** Ninguna. Solo admisible donde el régimen del instrumento lo permite. */
  | 'none'
  /** Una persona revisó una muestra. */
  | 'sampled'
  /** Una persona revisó el 100% de la salida. */
  | 'full-review'
  /** La IA solo preparó material; la decisión la tomó una persona. */
  | 'human-decided';

export interface AiDisclosure {
  id: string;
  /** Qué se produjo con ayuda de IA: `runId`, `Claim.id`, `Source.id`… */
  subjectId: string;
  runId?: string;
  /** El sistema, p. ej. `cloudflare-workers-ai`. */
  system: string;
  model: string;
  modelVersion?: string;
  /** Etapa del flujo: `pico-drafting`, `screening`, `extraction`, `entailment`… */
  stage: string;
  /** Para qué se usó, en una frase legible. */
  purpose: string;
  supervision: Supervision;
  /** Parámetros que afectan la reproducibilidad (temperatura, max_tokens…). */
  parameters: Record<string, unknown>;
  /** Limitaciones conocidas de este uso concreto. */
  limitations?: string;
  /** ISO 8601. */
  ranAt: string;
}

/**
 * La advertencia que acompaña a toda salida no revisada por humanos.
 *
 * Va en `ask` y `case` sin excepción. Un resultado que no la lleva es un resultado
 * que se puede confundir con uno revisado, y esa confusión es exactamente el daño
 * que el sistema existe para evitar.
 */
export const UNREVIEWED_WARNING =
  'Resultado NO revisado por un humano. Sirve para orientarse, no para fundamentar ' +
  'una recomendación ni para publicarse. Para eso está el flujo `protocol`.';

/**
 * Redacta la nota sobre referencias no comprobadas contra registros de retractación.
 *
 * Devuelve `undefined` cuando se comprobaron todas — no una frase tranquilizadora.
 * Declarar "0 sin comprobar" y no decir nada son equivalentes; inventar un
 * "todas verificadas ✓" invita a confiar más de lo que el dato aguanta.
 */
export function uncheckedNote(unchecked: number): string | undefined {
  if (unchecked <= 0) return undefined;
  return (
    `${unchecked} referencias no se comprobaron contra registros de retractación. ` +
    'Ausencia de comprobación no es ausencia de retractación.'
  );
}
