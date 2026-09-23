/**
 * Los eventos de la sala: lo ÚNICO que ve el público.
 *
 * Formato `{tipo, ts, seq, ...}`. Cada tipo tiene una lista cerrada de campos y
 * `sanear()` descarta todo lo demás antes de difundir: si mañana alguien pasa por
 * error un objeto con el prompt o con la clave, no sale de aquí.
 *
 * Campos añadidos al contrato original, y por qué:
 *  - `seq` (todos): número creciente para que /vivo no pinte dos veces el mismo
 *    evento cuando llega por WebSocket y por sondeo.
 *  - `ensayo` (claude_texto, pubmed_*): marca que el dato es el respaldo grabado en
 *    el ensayo y no una respuesta en vivo. /vivo lo etiqueta.
 *  - `coincide` (pubmed_consulta): una búsqueda puede devolver artículos que NO son
 *    el citado. La referencia 3 lo hace por título. Contar resultados no basta.
 *  - `detalle` (evidentia_etapa): cifras de la etapa, construidas por el servidor.
 */
import type { Via } from './contenido.js';

export type Tema = 'resumen' | 'verificacion' | 'evidentia';
export type EstadoEtapa = 'en curso' | 'completada' | 'falló' | 'sin terminar';

interface Base {
  ts: number;
  seq: number;
}

export type Evento =
  | (Base & { tipo: 'diapositiva'; n: number; titulo: string })
  | (Base & { tipo: 'demo_inicio'; tema: Tema })
  | (Base & { tipo: 'claude_texto'; texto_parcial: string; ensayo?: boolean })
  | (Base & { tipo: 'pubmed_consulta'; ref: number; via: Via; resultados: number; coincide: boolean; ensayo?: boolean })
  | (Base & { tipo: 'pubmed_veredicto'; ref: number; existe: boolean; pmid?: string; ensayo?: boolean })
  | (Base & { tipo: 'evidentia_etapa'; etapa: string; estado: EstadoEtapa; detalle?: string })
  | (Base & { tipo: 'aviso'; texto: string });

/** Un evento antes de que la sala le ponga `ts` y `seq`. */
export type EventoNuevo = Evento extends infer E ? (E extends Evento ? Omit<E, 'ts' | 'seq'> : never) : never;

export const TIPOS = [
  'diapositiva',
  'demo_inicio',
  'claude_texto',
  'pubmed_consulta',
  'pubmed_veredicto',
  'evidentia_etapa',
  'aviso',
] as const;

const TEMAS: readonly Tema[] = ['resumen', 'verificacion', 'evidentia'];
const VIAS: readonly Via[] = ['título', 'DOI', 'autor'];
const ESTADOS: readonly EstadoEtapa[] = ['en curso', 'completada', 'falló', 'sin terminar'];

export const LIMITES = {
  texto_parcial: 6000,
  aviso: 280,
  titulo: 160,
  etapa: 80,
  detalle: 200,
} as const;

/**
 * Deja un texto apto para pintarse con `textContent`: sin caracteres de control
 * salvo el salto de línea, sin espacios sobrantes y con tope de longitud.
 */
export function limpiarTexto(valor: unknown, maximo: number, conSaltos = false): string {
  if (typeof valor !== 'string') return '';
  // Fuera también los controles bidireccionales: permitirían que un texto se viera
  // en pantalla distinto de lo que dice.
  let s = valor.normalize('NFC').replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '');
  s = conSaltos
    ? s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u2028\u2029]/g, '')
    : s.replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, ' ').replace(/\s+/g, ' ');
  s = s.trim();
  return s.length > maximo ? s.slice(0, maximo) : s;
}

function entero(valor: unknown, min: number, max: number): number | null {
  return typeof valor === 'number' && Number.isInteger(valor) && valor >= min && valor <= max ? valor : null;
}

/**
 * Construye la versión pública de un evento con SOLO sus campos permitidos.
 * Devuelve `null` si algo no cuadra: un evento dudoso no se difunde.
 */
export function sanear(entrada: unknown, ts: number, seq: number): Evento | null {
  if (!entrada || typeof entrada !== 'object') return null;
  const e = entrada as Record<string, unknown>;
  const base = { ts, seq };

  switch (e['tipo']) {
    case 'diapositiva': {
      const n = entero(e['n'], 1, 99);
      const titulo = limpiarTexto(e['titulo'], LIMITES.titulo);
      return n === null || !titulo ? null : { ...base, tipo: 'diapositiva', n, titulo };
    }
    case 'demo_inicio': {
      const tema = e['tema'];
      return TEMAS.includes(tema as Tema) ? { ...base, tipo: 'demo_inicio', tema: tema as Tema } : null;
    }
    case 'claude_texto': {
      const texto = limpiarTexto(e['texto_parcial'], LIMITES.texto_parcial, true);
      if (!texto) return null;
      return {
        ...base,
        tipo: 'claude_texto',
        texto_parcial: texto,
        ...(e['ensayo'] === true ? { ensayo: true } : {}),
      };
    }
    case 'pubmed_consulta': {
      const ref = entero(e['ref'], 1, 5);
      const resultados = entero(e['resultados'], 0, 100_000_000);
      const via = e['via'];
      if (ref === null || resultados === null || !VIAS.includes(via as Via)) return null;
      return {
        ...base,
        tipo: 'pubmed_consulta',
        ref,
        via: via as Via,
        resultados,
        coincide: e['coincide'] === true,
        ...(e['ensayo'] === true ? { ensayo: true } : {}),
      };
    }
    case 'pubmed_veredicto': {
      const ref = entero(e['ref'], 1, 5);
      if (ref === null || typeof e['existe'] !== 'boolean') return null;
      const pmid = typeof e['pmid'] === 'string' && /^\d{1,9}$/.test(e['pmid']) ? e['pmid'] : undefined;
      // Un "existe" sin PMID no se puede comprobar desde el público: no se difunde.
      if (e['existe'] && !pmid) return null;
      return {
        ...base,
        tipo: 'pubmed_veredicto',
        ref,
        existe: e['existe'],
        ...(e['existe'] && pmid ? { pmid } : {}),
        ...(e['ensayo'] === true ? { ensayo: true } : {}),
      };
    }
    case 'evidentia_etapa': {
      const etapa = limpiarTexto(e['etapa'], LIMITES.etapa);
      const estado = e['estado'];
      if (!etapa || !ESTADOS.includes(estado as EstadoEtapa)) return null;
      const detalle = limpiarTexto(e['detalle'], LIMITES.detalle);
      return {
        ...base,
        tipo: 'evidentia_etapa',
        etapa,
        estado: estado as EstadoEtapa,
        ...(detalle ? { detalle } : {}),
      };
    }
    case 'aviso': {
      const texto = limpiarTexto(e['texto'], LIMITES.aviso);
      return texto ? { ...base, tipo: 'aviso', texto } : null;
    }
    default:
      return null;
  }
}

/**
 * Historial que se entrega a quien llega tarde. Se compacta para que no crezca:
 * de la diapositiva y del texto de Claude solo importa el último; una demo nueva
 * reemplaza la anterior del mismo tema.
 */
export function compactar(historial: Evento[], nuevo: Evento, maximo = 200): Evento[] {
  let h = historial;

  if (nuevo.tipo === 'diapositiva') h = h.filter((e) => e.tipo !== 'diapositiva');
  if (nuevo.tipo === 'claude_texto') h = h.filter((e) => e.tipo !== 'claude_texto');
  if (nuevo.tipo === 'demo_inicio') {
    const borrar: Evento['tipo'][] =
      nuevo.tema === 'resumen'
        ? ['claude_texto']
        : nuevo.tema === 'verificacion'
          ? ['pubmed_consulta', 'pubmed_veredicto']
          : ['evidentia_etapa'];
    h = h.filter((e) => !borrar.includes(e.tipo) && !(e.tipo === 'demo_inicio' && e.tema === nuevo.tema));
  }
  if (nuevo.tipo === 'aviso') {
    const avisos = h.filter((e) => e.tipo === 'aviso');
    if (avisos.length >= 5) {
      const masViejo = avisos[0];
      h = h.filter((e) => e !== masViejo);
    }
  }

  h = [...h, nuevo];
  return h.length > maximo ? h.slice(h.length - maximo) : h;
}
