/**
 * Un NCBI de mentira que responde con el mismo formato JSON que E-utilities.
 * Lo usan las pruebas unitarias; el simulador de extremo a extremo usa el mismo JSON.
 */
import datos from './ncbi.json';

type Esearch = { count: number; ids: string[]; phrasesnotfound?: string[] };

export interface Llamada {
  ruta: string;
  params: URLSearchParams;
}

export function ncbiSimulado(opciones: { fallar?: (llamada: Llamada, n: number) => Response | Error | null } = {}) {
  const llamadas: Llamada[] = [];
  const fetchImpl = (async (entrada: RequestInfo | URL): Promise<Response> => {
    const url = new URL(String(entrada));
    const ruta = url.pathname.split('/').pop() ?? '';
    const llamada = { ruta, params: url.searchParams };
    llamadas.push(llamada);
    const falla = opciones.fallar?.(llamada, llamadas.length);
    if (falla instanceof Error) throw falla;
    if (falla) return falla;

    if (ruta === 'esearch.fcgi') {
      const term = url.searchParams.get('term') ?? '';
      const r = (datos.esearch as Record<string, Esearch>)[term];
      if (!r) return Response.json({ esearchresult: { ERROR: `término no previsto: ${term}` } });
      return Response.json({
        esearchresult: {
          count: String(r.count),
          retmax: String(r.ids.length),
          idlist: r.ids,
          ...(r.phrasesnotfound ? { errorlist: { phrasesnotfound: r.phrasesnotfound, fieldsnotfound: [] } } : {}),
        },
      });
    }
    if (ruta === 'esummary.fcgi') {
      const ids = (url.searchParams.get('id') ?? '').split(',').filter(Boolean);
      const result: Record<string, unknown> = { uids: ids };
      for (const id of ids) {
        const d = (datos.esummary as Record<string, { title: string; doi?: string }>)[id];
        result[id] = {
          uid: id,
          title: d?.title ?? '',
          articleids: [{ idtype: 'pubmed', value: id }, ...(d?.doi ? [{ idtype: 'doi', value: d.doi }] : [])],
          ...(d?.doi ? { elocationid: `doi: ${d.doi}` } : {}),
        };
      }
      return Response.json({ header: { type: 'esummary' }, result });
    }
    return new Response('no', { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, llamadas };
}
