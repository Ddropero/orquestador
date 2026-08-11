/**
 * Enlaces del Worker y forma de la petición de arranque.
 */

export interface Env {
  /** Workers AI. Solo estructura el PICO; nunca emite un juicio. */
  AI: Ai;
  /** D1. Fuente de verdad operativa: el estado de Workflows solo dura 30 días. */
  DB: D1Database;
  /** R2. Los pasos devuelven punteros aquí porque el retorno topa en 1 MiB. */
  CORPUS: R2Bucket;
  /** El orquestador. */
  PIPELINE: Workflow;
  /** Índice vectorial con su esquema de metadatos congelado. */
  VECTORS: VectorizeIndex;

  /** Identificación exigida por NCBI en cada petición. */
  NCBI_TOOL: string;
  CONTACT_EMAIL: string;
  /** Opcional. Sube el límite de NCBI de 3 a 10 peticiones/s. */
  NCBI_API_KEY?: string;
}

export type RunMode = 'ask' | 'case' | 'protocol' | 'surveil';

export interface StartRequest {
  mode: RunMode;
  question: string;
  /**
   * Sensibilidad que el protocolo declara perseguir.
   *
   * Se declara ANTES de buscar y se guarda con la ejecución. Declarar el objetivo
   * después de ver los resultados es ajustar la vara al resultado, que es
   * precisamente lo que una revisión reproducible no puede hacer.
   */
  declaredRecallTarget: number;
}

export const RUN_MODES: RunMode[] = ['ask', 'case', 'protocol', 'surveil'];

export function isRunMode(value: unknown): value is RunMode {
  return typeof value === 'string' && (RUN_MODES as string[]).includes(value);
}
