/**
 * Enlaces y secretos del Worker de la charla.
 *
 * Los secretos viven SOLO aquí, como secretos del Worker (`wrangler secret put`).
 * Nada de esto viaja al navegador: ni la clave de Anthropic, ni el token del
 * presentador, ni la de NCBI.
 */
import type { Sala } from './sala.js';

export interface Env {
  /** Archivos estáticos de `public/`. El Worker decide qué se sirve y a quién. */
  ASSETS: Fetcher;
  /** La sala: difunde los eventos del presentador al público. */
  SALA: DurableObjectNamespace<Sala>;

  /** Límites de tasa. Opcionales para que las pruebas unitarias corran sin ellos. */
  LIMITE_LECTURA?: RateLimit;
  LIMITE_WS?: RateLimit;
  LIMITE_ENTRADA?: RateLimit;
  LIMITE_PRESENTADOR?: RateLimit;

  /** Secretos. */
  ANTHROPIC_API_KEY?: string;
  PRESENTER_TOKEN?: string;
  NCBI_API_KEY?: string;

  /** NCBI exige `tool` y `email` en cada petición. */
  NCBI_TOOL: string;
  CONTACT_EMAIL: string;

  /**
   * Bases de los servicios externos. En producción se dejan sin definir y se usan
   * los valores por defecto; las pruebas de extremo a extremo las apuntan a
   * simuladores locales.
   */
  EVIDENTIA_URL?: string;
  NCBI_BASE_URL?: string;
  ANTHROPIC_BASE_URL?: string;
  /**
   * "1" solo en `wrangler dev` (lo ponen `npm run dev` y las pruebas). Con la ruta
   * del dominio propio declarada, wrangler dev presenta las peticiones como
   * http://charla.davidduque.com, así que el host no sirve para saber que es local.
   * En producción no existe: manda HTTPS y la cookie es __Host- y Secure.
   */
  LOCAL?: string;
}
