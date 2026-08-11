import { z } from 'zod';

/**
 * ESQUEMA DE METADATOS DEL ÍNDICE VECTORIAL — CONGELADO.
 *
 * ⚠️ Esta es la única decisión irreversible del montaje. Vectorize:
 *   · indexa SOLO los primeros 64 bytes de cada valor de tipo string,
 *   · admite un máximo de 10 índices de metadatos por índice vectorial,
 *   · NO aplica un índice nuevo a los vectores ya cargados.
 *
 * Añadir un filtro después obliga a reindexar el corpus entero. Por eso los
 * valores son códigos cortos y de vocabulario cerrado, y por eso este archivo
 * es la fuente de verdad: `infra/vectorize-setup.sh` se deriva de aquí.
 *
 * Ranuras usadas: 9 de 10. La décima se deja libre a propósito.
 */

/** 1 · year — number. Filtros de rango por fecha de publicación. */

/** 2 · design — el diseño del estudio, en código corto. */
export const VecDesign = z.enum([
  'rct', 'nrsi', 'coh', 'cc', 'xs', 'dta', 'sr', 'ma', 'gl', 'cs', 'nr', 'qual', 'econ', 'unk',
]);

/** 3 · source — de qué fuente vino el registro. */
export const VecSource = z.enum([
  'pubmed', 'epmc', 'crossref', 'ctgov', 'openfda', 'openalex', 'minsalud', 'scielo', 'manual',
]);

/** 4 · lang — ISO 639-1. */
export const VecLang = z.enum(['es', 'en', 'pt', 'fr', 'de', 'it', 'other']);

/** 5 · rob — riesgo de sesgo. 'na' cuando aún no se ha valorado: nunca se asume bajo. */
export const VecRob = z.enum(['low', 'some', 'high', 'na']);

/** 6 · age — grupo etario predominante de la población estudiada. */
export const VecAge = z.enum(['neonate', 'ped', 'adolescent', 'adult', 'older', 'mixed', 'unk']);

/** 7 · region — dónde se hizo el estudio. Importa para la evidencia indirecta de GRADE. */
export const VecRegion = z.enum([
  'co', 'latam', 'us', 'ca', 'eu', 'uk', 'asia', 'africa', 'oceania', 'multi', 'unk',
]);

/**
 * 8 · condition — la condición clínica.
 *
 * Aquí NO usamos una lista cerrada, porque el orquestador arranca con cualquier
 * pregunta nueva y fijar el vocabulario ahora lo ataría a un dominio.
 *
 * La solución es usar el **descriptor MeSH principal** en minúsculas, sin espacios.
 * Es un vocabulario ya controlado, mantenido por la NLM, y cabe de sobra en los
 * 64 bytes indexables. Así el filtro sirve igual para heridas, rehabilitación o
 * cualquier campo al que se extienda el sistema, sin decidir hoy cuál será.
 *
 * Ejemplos: 'diabetic-foot' · 'low-back-pain' · 'stroke-rehabilitation'
 */
export const VecCondition = z
  .string()
  .min(2)
  .max(60, 'Vectorize solo indexa 64 bytes: usa el descriptor MeSH, no una frase')
  .regex(/^[a-z0-9-]+$/, 'Descriptor MeSH en minúsculas separado por guiones');

/** 9 · setting — ámbito de atención. Cambia la aplicabilidad de muchas intervenciones. */
export const VecSetting = z.enum(['inpatient', 'outpatient', 'home', 'icu', 'primary', 'mixed', 'unk']);

/** 10 · RANURA LIBRE — reservada deliberadamente. No la gastes sin pensarlo. */

export const VectorMetadata = z.object({
  year: z.number().int().min(1800).max(2200),
  design: VecDesign,
  source: VecSource,
  lang: VecLang,
  rob: VecRob,
  age: VecAge,
  region: VecRegion,
  condition: VecCondition,
  setting: VecSetting,
});

export type VectorMetadata = z.infer<typeof VectorMetadata>;

/** Longitud máxima indexable por Vectorize para un valor de tipo string. */
export const VECTORIZE_INDEXED_BYTES = 64;

/**
 * Comprueba que ningún valor supere los bytes indexables.
 * Un valor más largo no falla al insertarse: falla SILENCIOSAMENTE al filtrarse,
 * que es peor. Por eso se valida antes de escribir.
 */
export function assertIndexable(meta: VectorMetadata): void {
  const encoder = new TextEncoder();
  for (const [key, value] of Object.entries(meta)) {
    if (typeof value !== 'string') continue;
    const bytes = encoder.encode(value).length;
    if (bytes > VECTORIZE_INDEXED_BYTES) {
      throw new Error(
        `El metadato "${key}" ocupa ${bytes} bytes y Vectorize solo indexa ${VECTORIZE_INDEXED_BYTES}. ` +
          `El filtrado por este campo fallaría en silencio. Valor: "${value}"`,
      );
    }
  }
}
