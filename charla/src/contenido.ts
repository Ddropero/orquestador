/**
 * Contenido fijo de la charla. Una sola fuente: `datos/*.json`, que también
 * alimenta las páginas en la construcción. Así el servidor y la diapositiva no
 * pueden contar dos versiones distintas de la misma referencia.
 */
import contenidoJson from '../datos/contenido.json';
import configJson from '../datos/config.json';
import type { CifrasEmbudo, FuenteChat } from './eventos.js';

export interface Referencia {
  n: number;
  cita: string;
  titulo: string;
  corta: string;
  doi: string;
  qTitulo: string;
  qAutor: string;
  fabricada: boolean;
}

export type Via = 'título' | 'DOI' | 'autor';

export interface ConsultaRegistrada {
  via: Via;
  resultados: number;
  coincide: boolean;
}

export interface VerificacionRegistrada {
  ref: number;
  consultas: ConsultaRegistrada[];
  existe: boolean;
  pmid?: string;
}

export interface Respaldos {
  claude: { texto: string; fecha: string; modelo?: string } | null;
  pubmed: { fecha: string; origen?: string; referencias: VerificacionRegistrada[] } | null;
  /** `cifras`: el embudo del run del ensayo, para mostrarlo si Evidentia falla en vivo. */
  evidentia: { runId: string; fecha: string; cifras?: CifrasEmbudo } | null;
  /** La demo del chat con PubMed tal como salió en el ensayo: resultados de la consulta, lo leído y la respuesta. */
  chat: { fecha: string; modelo?: string; resultados: number; fuentes: FuenteChat[]; texto: string } | null;
}

export const REFERENCIAS: readonly Referencia[] = contenidoJson.referencias;
export const TEMA = contenidoJson.tema;
export const DIAPOSITIVAS: readonly string[] = contenidoJson.diapositivas;
export const RESUMEN = contenidoJson.resumen;
export const PREGUNTA_EVIDENTIA = contenidoJson.evidentia.pregunta;
/** Demostración 2 de 3: la pregunta, la consulta fija a PubMed y la instrucción para Claude. */
export const CHAT = contenidoJson.chat;
export const PASOS = contenidoJson.pasos.lista;
/**
 * La diapositiva de la demostración 1 (la lista de cinco, `id="demo"` en la base).
 * La votación del público es sobre esa lista: pasar a una diapositiva posterior la cierra.
 */
export const DIAPOSITIVA_DEMO = 3;

export const CONFIG = configJson;

/** El prompt que recibe Claude. Fijo, del lado del servidor, sin nada del cliente. */
export function promptResumen(): string {
  const ref = REFERENCIAS.find((r) => r.n === RESUMEN.referencia);
  if (!ref) throw new Error('La referencia del resumen no existe en el contenido.');
  return `${RESUMEN.instruccion}\n\n${ref.cita} doi:${ref.doi}`;
}

const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

/** "2026-09-23" → "23 de septiembre de 2026". Sin Intl: el resultado no puede variar. */
export function fechaLarga(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const mes = MESES[Number(m[2]) - 1];
  return mes ? `${Number(m[3])} de ${mes} de ${m[1]}` : iso;
}

/** Fecha de hoy en Bogotá, en ISO corto. La charla ocurre allí y el sello debe coincidir. */
export function hoyBogota(ahora = new Date()): string {
  const bogota = new Date(ahora.getTime() - 5 * 60 * 60 * 1000);
  return bogota.toISOString().slice(0, 10);
}
