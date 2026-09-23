/**
 * Verificación de referencias contra PubMed con NCBI E-utilities.
 *
 * Por cada referencia: búsqueda por título, luego por DOI (`"<doi>"[aid]`) y luego
 * por autor. Hasta aquí, lo mismo que la demo original.
 *
 * Lo que se añade, y es la lección de la charla aplicada al propio código: que una
 * búsqueda devuelva resultados NO prueba que la referencia exista. Cada resultado
 * se abre (esummary) y se confirma contra el DOI o el título citados. Sin esa
 * confirmación, la referencia 3 —inventada— "aparecía en PubMed por título",
 * porque su consulta encuentra un ensayo real de diclofenaco frente a ibuprofeno
 * de 2003 (PMID 12749506) que no es el artículo citado.
 */
import type { Referencia, VerificacionRegistrada, ConsultaRegistrada, Via } from './contenido.js';

export const NCBI_BASE_POR_DEFECTO = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';

/** Resultados por búsqueda que se abren para confirmar. La consulta por título de la ref. 4 trae 13. */
const RETMAX = 20;

export class ErrorNcbi extends Error {
  override name = 'ErrorNcbi';
}

export interface Articulo {
  pmid: string;
  titulo: string;
  doi?: string;
}

export interface ClienteNcbi {
  buscar(termino: string): Promise<{ total: number; ids: string[] }>;
  resumir(ids: string[]): Promise<Articulo[]>;
}

export interface OpcionesNcbi {
  base?: string;
  tool: string;
  email: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Cancela todo lo pendiente (el presentador pidió el respaldo). */
  signal?: AbortSignal;
  dormir?: (ms: number) => Promise<void>;
  ahora?: () => number;
}

const dormirReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function crearClienteNcbi(o: OpcionesNcbi): ClienteNcbi {
  const base = (o.base ?? NCBI_BASE_POR_DEFECTO).replace(/\/+$/, '');
  const fetchImpl = o.fetchImpl ?? fetch;
  const dormir = o.dormir ?? dormirReal;
  const ahora = o.ahora ?? Date.now;
  const timeoutMs = o.timeoutMs ?? 5000;
  // NCBI permite 3 peticiones/s sin clave y 10 con clave. Se queda un poco por debajo.
  const intervalo = o.apiKey ? 110 : 350;
  let ultima = 0;

  async function pedir(ruta: 'esearch.fcgi' | 'esummary.fcgi', params: Record<string, string>): Promise<unknown> {
    const url = new URL(`${base}/${ruta}`);
    url.searchParams.set('db', 'pubmed');
    url.searchParams.set('retmode', 'json');
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set('tool', o.tool);
    url.searchParams.set('email', o.email);
    if (o.apiKey) url.searchParams.set('api_key', o.apiKey);

    for (let intento = 0; intento < 2; intento++) {
      if (o.signal?.aborted) throw new ErrorNcbi('cancelada');
      const espera = ultima + intervalo - ahora();
      if (espera > 0) await dormir(espera);
      ultima = ahora();

      let res: Response;
      try {
        const limite = AbortSignal.timeout(timeoutMs);
        res = await fetchImpl(url.toString(), {
          headers: { accept: 'application/json' },
          signal: o.signal ? AbortSignal.any([limite, o.signal]) : limite,
        });
      } catch (error) {
        // Sin reintento: si NCBI no contesta en 5 s, esperar otros 5 deja al ponente
        // en silencio. Quien llama pasa al respaldo del ensayo.
        throw new ErrorNcbi(`sin respuesta de NCBI (${error instanceof Error ? error.name : 'error'})`);
      }
      if ((res.status === 429 || res.status >= 500) && intento === 0) {
        await dormir(600);
        continue;
      }
      if (!res.ok) throw new ErrorNcbi(`NCBI respondió HTTP ${res.status}`);
      try {
        return await res.json();
      } catch {
        throw new ErrorNcbi('NCBI devolvió una respuesta que no es JSON');
      }
    }
    throw new ErrorNcbi('NCBI no respondió tras el reintento');
  }

  return {
    async buscar(termino) {
      const datos = (await pedir('esearch.fcgi', { term: termino, retmax: String(RETMAX) })) as {
        esearchresult?: {
          count?: string;
          idlist?: string[];
          ERROR?: string;
          errorlist?: { phrasesnotfound?: string[]; fieldsnotfound?: string[] };
          warninglist?: { quotedphrasesnotfound?: string[] };
        };
      };
      const r = datos?.esearchresult;
      if (!r || r.ERROR) throw new ErrorNcbi(`esearch falló${r?.ERROR ? `: ${r.ERROR}` : ''}`);
      // Si NCBI no encuentra un término, lo QUITA y busca con el resto: un autor
      // inventado se convertiría en "todos los artículos de influenza". Las
      // consultas de la demo son conjunciones, así que un término sin resultados
      // significa que la consulta, tal como está escrita, no tiene ninguno.
      const faltantes = [
        ...(r.errorlist?.phrasesnotfound ?? []),
        ...(r.errorlist?.fieldsnotfound ?? []),
        ...(r.warninglist?.quotedphrasesnotfound ?? []),
      ].filter((t) => typeof t === 'string' && t.trim() !== '');
      if (faltantes.length > 0) return { total: 0, ids: [] };
      const total = Number.parseInt(r.count ?? '0', 10);
      const ids = (r.idlist ?? []).filter((id) => /^\d{1,9}$/.test(id));
      return { total: Number.isFinite(total) && total >= 0 ? total : ids.length, ids };
    },

    async resumir(ids) {
      if (ids.length === 0) return [];
      const datos = (await pedir('esummary.fcgi', { id: ids.join(',') })) as {
        result?: Record<string, unknown> & { uids?: string[] };
      };
      const r = datos?.result;
      if (!r) throw new ErrorNcbi('esummary falló');
      const articulos: Articulo[] = [];
      for (const uid of r.uids ?? []) {
        const doc = r[uid] as
          | { title?: string; articleids?: { idtype?: string; value?: string }[]; elocationid?: string }
          | undefined;
        if (!doc || !/^\d{1,9}$/.test(uid)) continue;
        const doiId = doc.articleids?.find((a) => a.idtype === 'doi')?.value;
        const doiEloc = /doi:\s*(\S+)/i.exec(doc.elocationid ?? '')?.[1];
        const doi = doiId ?? doiEloc;
        articulos.push({ pmid: uid, titulo: doc.title ?? '', ...(doi ? { doi } : {}) });
      }
      return articulos;
    },
  };
}

export function normalizarTitulo(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/<[^>]*>/g, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function normalizarDoi(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, '')
    .replace(/^doi:\s*/, '')
    .replace(/[.\s]+$/, '');
}

/** ¿Este artículo de PubMed ES la referencia citada? Por DOI exacto o por título exacto. */
export function esLaReferencia(a: Articulo, ref: Referencia): boolean {
  if (a.doi && normalizarDoi(a.doi) === normalizarDoi(ref.doi)) return true;
  const t = normalizarTitulo(a.titulo);
  return t.length > 0 && t === normalizarTitulo(ref.titulo);
}

export function pasosDeBusqueda(ref: Referencia): { via: Via; termino: string }[] {
  return [
    { via: 'título', termino: ref.qTitulo },
    { via: 'DOI', termino: `"${ref.doi}"[aid]` },
    { via: 'autor', termino: ref.qAutor },
  ];
}

/**
 * Verifica una referencia. Avisa de cada consulta según ocurre para que el público
 * vea el proceso, no solo el veredicto. Lanza `ErrorNcbi` si PubMed no contesta:
 * quien llama decide pasar al respaldo.
 */
export async function verificarReferencia(
  ref: Referencia,
  cliente: ClienteNcbi,
  alConsultar: (c: ConsultaRegistrada) => void | Promise<void>,
): Promise<VerificacionRegistrada> {
  const consultas: ConsultaRegistrada[] = [];
  for (const paso of pasosDeBusqueda(ref)) {
    const { total, ids } = await cliente.buscar(paso.termino);
    let pmid: string | undefined;
    if (ids.length > 0) {
      const articulos = await cliente.resumir(ids);
      pmid = articulos.find((a) => esLaReferencia(a, ref))?.pmid;
    }
    const consulta: ConsultaRegistrada = { via: paso.via, resultados: total, coincide: Boolean(pmid) };
    consultas.push(consulta);
    await alConsultar(consulta);
    if (pmid) return { ref: ref.n, consultas, existe: true, pmid };
  }
  return { ref: ref.n, consultas, existe: false };
}
