/**
 * La votación del público: ¿existe cada una de las cinco referencias?
 *
 * Lógica pura (sin almacenamiento ni red) para poder probarla entera. La sala la
 * usa así:
 *  - Una papeleta por votante y ronda (`voto:<ronda>:<votante>`), con lo que ese
 *    votante marcó en cada referencia. Cambiar de opinión resta del conteo
 *    anterior y suma en el nuevo: nadie cuenta dos veces.
 *  - Los conteos y el número de votantes viven junto al estado de la votación y
 *    se guardan en la misma escritura que la papeleta: si el objeto se desaloja a
 *    mitad de la votación, al volver cuadran.
 *  - Cada red (la IP pública desde la que llega el voto) tiene su propio tope de
 *    votantes nuevos por ronda. El votante lo inventa el celular, así que un
 *    script puede fabricar miles; lo que no puede fabricar es la red. El tope por
 *    red es el aforo entero (todo el auditorio puede estar detrás de la IP del
 *    hotel), pero una sola red no llena nunca la ronda: el resto sigue votando.
 *    Cambiar el voto no gasta cupo.
 *  - Mientras la votación está abierta, al público solo le llega cuántos votos van,
 *    sin el desglose por referencia: ni en pantalla ni en los datos que recibe la
 *    página. El desglose sale al cerrar.
 *
 * El votante es un identificador al azar que el celular genera y guarda: no es una
 * persona ni una cuenta, y no sale nunca de la sala. De la red solo se guarda un
 * resumen criptográfico con sal al azar de la ronda, y se borra con la ronda.
 */
import { TOTAL_REFERENCIAS, type ConteoVotos, type EstadoVotacion } from './eventos.js';

/** Tope de votantes distintos por ronda: un auditorio lleno cabe de sobra; un bot no llena el almacenamiento. */
export const TOPE_VOTANTES = 3000;
/**
 * Tope de votantes nuevos por red y ronda: el aforo pensado para la sala (600
 * celulares, como los límites de tasa), todos detrás de una sola IP si hace falta.
 * Con 3000 de tope general, llenar la ronda exige cinco redes distintas.
 */
export const TOPE_VOTANTES_POR_RED = 600;
/** Un voto legítimo ocupa menos de 150 bytes. */
export const MAX_CUERPO_VOTO = 512;
/** Los totales se difunden como mucho una vez por segundo mientras la votación está abierta. */
export const INTERVALO_VOTOS_MS = 1000;
/** Prefijo de las papeletas en el almacenamiento de la sala. */
export const PREFIJO_PAPELETA = 'voto:';
/** Prefijo de los contadores de votantes nuevos por red. */
export const PREFIJO_RED = 'red:';

const VOTANTE = /^[A-Za-z0-9_-]{16,64}$/;

export interface Voto {
  votante: string;
  ronda: number;
  ref: number;
  existe: boolean;
}

/** Lo que un votante marcó en cada referencia de la ronda: número de referencia → existe. */
export type Papeleta = Record<string, boolean>;

export interface Votacion {
  estado: EstadoVotacion;
  ronda: number;
  conteos: ConteoVotos[];
  /** Votantes distintos de la ronda. */
  votantes: number;
}

export type RechazoVoto = 'votacion_cerrada' | 'votacion_llena';

/** `nuevo`: el voto es el primero de ese votante en la ronda (cuenta en el tope de su red). */
export type ResultadoVoto =
  | { ok: true; votacion: Votacion; papeleta: Papeleta; cambio: boolean; nuevo: boolean }
  | { ok: false; error: RechazoVoto };

export function conteosVacios(): ConteoVotos[] {
  return Array.from({ length: TOTAL_REFERENCIAS }, (_, i) => ({ ref: i + 1, si: 0, no: 0 }));
}

export function clavePapeleta(ronda: number, votante: string): string {
  return `${PREFIJO_PAPELETA}${ronda}:${votante}`;
}

/**
 * Clave del contador de una red en una ronda: SHA-256 de la sal de la ronda y la
 * IP, recortado. La IP no se guarda; con la sal borrada al abrir otra ronda, el
 * resumen tampoco se puede cruzar con el de otra ronda.
 */
export async function claveRed(ronda: number, sal: string, ip: string): Promise<string> {
  const resumen = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${sal}|${ip}`)));
  const hex = Array.from(resumen.subarray(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
  return `${PREFIJO_RED}${ronda}:${hex}`;
}

/** Una ronda nueva, con número mayor que la última que existió (aunque la sala se haya reiniciado). */
export function abrirVotacion(ultimaRonda: number): Votacion {
  const previa = Number.isSafeInteger(ultimaRonda) && ultimaRonda > 0 ? ultimaRonda : 0;
  return { estado: 'abierta', ronda: previa + 1, conteos: conteosVacios(), votantes: 0 };
}

export function cerrarVotacion(v: Votacion): Votacion {
  return { ...v, estado: 'cerrada', conteos: v.conteos.map((c) => ({ ...c })) };
}

/**
 * Valida el cuerpo de `POST /api/sala/voto` ya interpretado como JSON. Solo toma
 * los cuatro campos del contrato; lo demás se ignora y no se guarda.
 */
export function validarVoto(entrada: unknown): Voto | null {
  if (!entrada || typeof entrada !== 'object' || Array.isArray(entrada)) return null;
  const e = entrada as Record<string, unknown>;
  const { votante, ronda, ref, existe } = e;
  if (typeof votante !== 'string' || !VOTANTE.test(votante)) return null;
  if (typeof ronda !== 'number' || !Number.isSafeInteger(ronda) || ronda < 1) return null;
  if (typeof ref !== 'number' || !Number.isInteger(ref) || ref < 1 || ref > TOTAL_REFERENCIAS) return null;
  if (typeof existe !== 'boolean') return null;
  return { votante, ronda, ref, existe };
}

/** El texto del cuerpo → voto válido, o `null` si no es JSON o no cumple el contrato. */
export function interpretarVoto(texto: string): Voto | null {
  if (texto.length === 0 || texto.length > MAX_CUERPO_VOTO) return null;
  try {
    return validarVoto(JSON.parse(texto));
  } catch {
    return null;
  }
}

/**
 * Lee el cuerpo sin pasar de `maximo` bytes: ni `content-length` mentiroso ni un
 * cuerpo por trozos sin fin llenan la memoria del Worker. `null` si se pasa.
 */
export async function leerCuerpoLimitado(request: Request, maximo = MAX_CUERPO_VOTO): Promise<string | null> {
  const declarado = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declarado) && declarado > maximo) return null;
  if (!request.body) return '';
  const lector = request.body.getReader();
  const trozos: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await lector.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximo) {
      await lector.cancel().catch(() => {});
      return null;
    }
    trozos.push(value);
  }
  const todo = new Uint8Array(total);
  let i = 0;
  for (const t of trozos) {
    todo.set(t, i);
    i += t.byteLength;
  }
  return new TextDecoder().decode(todo);
}

/**
 * Registra un voto nuevo o cambiado. No muta nada: devuelve la votación y la
 * papeleta nuevas, y `cambio: false` si el voto repite lo que ya estaba (no hace
 * falta ni escribir ni difundir).
 *
 * Se rechaza con `votacion_cerrada` si no hay votación abierta o el voto es de otra
 * ronda (un celular que se quedó con la anterior), y con `votacion_llena` si es un
 * votante nuevo y la ronda ya tiene el tope, o su red ya tiene el suyo
 * (`deLaRed`: votantes nuevos que ya entraron desde esa red en esta ronda). Quien
 * ya votó puede seguir cambiando sus votos aunque la ronda o su red estén llenas.
 */
export function registrarVoto(
  v: Votacion | null,
  papeleta: Papeleta | undefined,
  voto: Voto,
  tope = TOPE_VOTANTES,
  deLaRed = 0,
  topeRed = TOPE_VOTANTES_POR_RED,
): ResultadoVoto {
  if (!v || v.estado !== 'abierta' || v.ronda !== voto.ronda) return { ok: false, error: 'votacion_cerrada' };
  const nuevo = papeleta === undefined;
  if (nuevo && (v.votantes >= tope || deLaRed >= topeRed)) return { ok: false, error: 'votacion_llena' };

  const clave = String(voto.ref);
  const anterior = papeleta?.[clave];
  if (anterior === voto.existe) return { ok: true, votacion: v, papeleta: papeleta ?? {}, cambio: false, nuevo: false };

  const conteos = v.conteos.map((c) => {
    if (c.ref !== voto.ref) return c;
    const x = { ...c };
    if (anterior === true) x.si = Math.max(0, x.si - 1);
    if (anterior === false) x.no = Math.max(0, x.no - 1);
    if (voto.existe) x.si += 1;
    else x.no += 1;
    return x;
  });
  return {
    ok: true,
    votacion: { ...v, conteos, votantes: v.votantes + (nuevo ? 1 : 0) },
    papeleta: { ...papeleta, [clave]: voto.existe },
    cambio: true,
    nuevo,
  };
}

/** Votos emitidos en la ronda, sumando todas las referencias (un votante puede emitir hasta cinco). */
export function totalVotos(conteos: readonly ConteoVotos[]): number {
  return conteos.reduce((s, c) => s + c.si + c.no, 0);
}

/**
 * El evento `votos` que se difunde al público. Abierta: solo el total de votos,
 * para que nadie, ni leyendo los datos de la página, vote según lo que va ganando.
 * Cerrada: el desglose por referencia.
 */
export function eventoVotos(v: Votacion): { tipo: 'votos'; ronda: number; total: number } | { tipo: 'votos'; ronda: number; conteos: ConteoVotos[] } {
  return v.estado === 'abierta'
    ? { tipo: 'votos', ronda: v.ronda, total: totalVotos(v.conteos) }
    : { tipo: 'votos', ronda: v.ronda, conteos: v.conteos.map((c) => ({ ...c })) };
}

/** Milisegundos que faltan para poder difundir los totales otra vez (0: ya). */
export function esperaParaDifundir(ultima: number, ahora: number, intervalo = INTERVALO_VOTOS_MS): number {
  return Math.max(0, ultima + intervalo - ahora);
}

/** Lo que ve el presentador en `GET /api/presentador/estado`. */
export function resumenVotacion(v: Votacion | null): {
  estado: EstadoVotacion | null;
  ronda: number | null;
  conteos: ConteoVotos[] | null;
  votantes: number;
} {
  return v
    ? { estado: v.estado, ronda: v.ronda, conteos: v.conteos.map((c) => ({ ...c })), votantes: v.votantes }
    : { estado: null, ronda: null, conteos: null, votantes: 0 };
}
