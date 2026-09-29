/**
 * Demostración 2 de 3: el mismo tipo de chat que en la demo 1, pero con PubMed.
 *
 * La búsqueda la hace el servidor con una consulta fija (`datos/contenido.json`
 * → chat.consulta); Claude solo recibe los resúmenes que devolvió PubMed y debe
 * citar cada afirmación con su PMID. Después se comprueba lo que citó: un PMID
 * que no salió de la búsqueda no llega al público como si fuera una fuente.
 */
import type { ArticuloLeido } from './pubmed.js';

/** Tope del resumen de cada artículo en el prompt: los de Cochrane pasan de 3000 caracteres. */
const MAX_RESUMEN = 3500;

/** Fuente que ve el público: un artículo real que leyó el modelo, con su PMID. */
export interface Fuente {
  pmid: string;
  titulo: string;
  revista: string;
  anio?: number;
}

export function fuenteDe(a: ArticuloLeido): Fuente {
  return { pmid: a.pmid, titulo: a.titulo, revista: a.revista, ...(a.anio ? { anio: a.anio } : {}) };
}

/** El prompt que recibe Claude. Fijo, del lado del servidor: la pregunta, la instrucción y los resúmenes. */
export function promptChat(instruccion: string, pregunta: string, articulos: readonly ArticuloLeido[]): string {
  const bloques = articulos.map((a) => {
    const resumen = a.resumen.length > MAX_RESUMEN ? `${a.resumen.slice(0, MAX_RESUMEN)}…` : a.resumen;
    return [
      `PMID ${a.pmid} · ${a.revista}${a.anio ? ` · ${a.anio}` : ''}`,
      `Título: ${a.titulo}`,
      `Resumen: ${resumen || '(PubMed no tiene resumen de este artículo)'}`,
    ].join('\n');
  });
  return `${instruccion}\n\nPregunta: ${pregunta}\n\nResúmenes de PubMed:\n\n${bloques.join('\n\n')}`;
}

/** «[PMID 123]», como pide la instrucción, pero también «PMID: 123» o «(PMID 123)» si el modelo no la sigue al pie de la letra. */
const CITA = /(\[\s*)?\bPMID\s*:?\s*(\d{1,9})(\s*\])?/gi;

/**
 * Revisa la respuesta del modelo contra los PMID que de verdad leyó:
 *  - `citados`: los PMID leídos que cita, en orden de aparición y sin repetir;
 *  - `ajenos`: los que cita sin haberlos leído. Se reemplazan en el texto por una
 *    marca visible, para que el público no vea como fuente algo que no salió de
 *    la búsqueda.
 */
export function revisarCitas(texto: string, leidos: readonly string[]): { texto: string; citados: string[]; ajenos: string[] } {
  const validos = new Set(leidos);
  const citados: string[] = [];
  const ajenos: string[] = [];
  const limpio = texto.replace(CITA, (_cita, abre: string | undefined, pmid: string, cierra: string | undefined) => {
    const conCorchetes = Boolean(abre && cierra);
    if (validos.has(pmid)) {
      if (!citados.includes(pmid)) citados.push(pmid);
      return conCorchetes ? `[PMID ${pmid}]` : `${abre ?? ''}PMID ${pmid}${cierra ?? ''}`;
    }
    if (!ajenos.includes(pmid)) ajenos.push(pmid);
    return `${conCorchetes ? '' : (abre ?? '')}[cita retirada: ese PMID no salió de la búsqueda]${conCorchetes ? '' : (cierra ?? '')}`;
  });
  return { texto: limpio, citados, ajenos };
}
