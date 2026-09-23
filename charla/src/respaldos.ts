/**
 * Los respaldos del ensayo, leídos del mismo archivo que se embebió en la página del
 * presentador (`public/_privado/respaldos.json`, escrito por la construcción). Así la
 * etiqueta y el texto que ve el público son siempre los mismos que ve el ponente.
 */
import type { Respaldos } from './contenido.js';

const VACIO: Respaldos = { claude: null, pubmed: null, evidentia: null };
let cache: Respaldos | null = null;

export async function cargarRespaldos(env: { ASSETS: Fetcher }): Promise<Respaldos> {
  if (cache) return cache;
  try {
    const res = await env.ASSETS.fetch('https://assets.invalid/_privado/respaldos.json');
    if (!res.ok) return VACIO;
    const r = (await res.json()) as Partial<Respaldos>;
    cache = { claude: r.claude ?? null, pubmed: r.pubmed ?? null, evidentia: r.evidentia ?? null };
    return cache;
  } catch {
    return VACIO;
  }
}
