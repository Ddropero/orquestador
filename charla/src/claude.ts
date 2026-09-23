/**
 * La única llamada a la API de Claude de todo el proyecto.
 *
 * Prompt fijo (ver `promptResumen`), sin herramientas, sin búsqueda y sin prompt de
 * sistema: así responde un chatbot sin acceso a bases de datos ante un artículo
 * que no existe. Solo el presentador autenticado llega hasta aquí.
 */
import Anthropic from '@anthropic-ai/sdk';

export class ErrorResumen extends Error {
  override name = 'ErrorResumen';
}

export interface OpcionesResumen {
  apiKey: string;
  baseURL?: string;
  modelo: string;
  prompt: string;
  signal: AbortSignal;
  /** Recibe el texto acumulado, no el fragmento: /vivo reemplaza, no concatena. */
  alTexto: (acumulado: string) => void;
  precio: { entrada: number; salida: number };
}

export interface ResultadoResumen {
  texto: string;
  modelo: string;
  entrada: number;
  salida: number;
  /** Estimado con el precio publicado por millón de tokens. El real está en la consola de Anthropic. */
  usd: number;
}

export function costoUsd(entrada: number, salida: number, precio: { entrada: number; salida: number }): number {
  return Math.round(((entrada * precio.entrada + salida * precio.salida) / 1_000_000) * 1_000_000) / 1_000_000;
}

export async function generarResumen(o: OpcionesResumen): Promise<ResultadoResumen> {
  const cliente = new Anthropic({
    apiKey: o.apiKey,
    ...(o.baseURL ? { baseURL: o.baseURL } : {}),
    // Un reintento cabe dentro de los 25 s; más, no. El plazo lo corta `signal`.
    maxRetries: 1,
    timeout: 25_000,
  });

  const flujo = cliente.messages.stream(
    {
      model: o.modelo,
      // Cuatro o cinco líneas. El tope evita que una respuesta desbocada coma la demo.
      max_tokens: 1024,
      // Sin pensamiento extendido: en tarima cuenta el primer token, y aquí no hay
      // herramientas que puedan salir mal con él apagado.
      thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: o.prompt }],
    },
    { signal: o.signal },
  );

  flujo.on('text', (_fragmento, acumulado) => o.alTexto(acumulado));

  const final = await flujo.finalMessage();
  if (final.stop_reason === 'refusal') throw new ErrorResumen('El modelo declinó responder.');

  const texto = final.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  if (!texto) throw new ErrorResumen('El modelo devolvió una respuesta vacía.');

  const entrada = final.usage.input_tokens ?? 0;
  const salida = final.usage.output_tokens ?? 0;
  return { texto, modelo: final.model, entrada, salida, usd: costoUsd(entrada, salida, o.precio) };
}

/** Descripción para el registro. Nunca incluye la clave ni el prompt. */
export function describirError(error: unknown): string {
  if (error instanceof Anthropic.RateLimitError) return 'límite de tasa de Anthropic (429)';
  if (error instanceof Anthropic.AuthenticationError) return 'clave de Anthropic rechazada (401)';
  if (error instanceof Anthropic.APIUserAbortError) return 'consulta cancelada';
  if (error instanceof Anthropic.APIConnectionTimeoutError) return 'tiempo agotado con Anthropic';
  if (error instanceof Anthropic.APIConnectionError) return 'sin conexión con Anthropic';
  if (error instanceof Anthropic.APIError) return `error de la API de Anthropic (${error.status ?? 'sin estado'})`;
  if (error instanceof ErrorResumen) return error.message;
  return error instanceof Error ? error.name : 'error desconocido';
}
