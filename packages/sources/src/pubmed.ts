import type { Source, SourceIds } from '@evidentia/core';
import { normalizeDoi, normalizePmcid, normalizePmid, sourceKey, uncheckedEditorial } from '@evidentia/core';
import type { HttpClient, PoliteConfig } from '@evidentia/verify';
import { classifyDesign, parseYear, type SearchOptions, type SearchResult, type SourceAdapter } from './registry.js';

/**
 * Adaptador de PubMed (E-utilities).
 *
 * Dos peticiones por búsqueda: `esearch` devuelve los PMID, `esummary` sus
 * metadatos. No se usa `efetch` porque devuelve XML y aquí solo hacen falta
 * metadatos; el texto, cuando se necesita, viene por Europe PMC o por PMC.
 *
 * `tool` y `email` van en TODAS las peticiones. NCBI lo exige y, sin ellos,
 * limita a 3 peticiones/s y puede bloquear la IP del Worker.
 */

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';

/** NCBI trunca `esummary` con lotes grandes; 200 por petición va sobrado. */
const MAX_BATCH = 200;

async function search(
  query: string,
  options: SearchOptions,
  http: HttpClient,
  config: PoliteConfig,
): Promise<SearchResult> {
  const retmax = Math.min(options.limit, MAX_BATCH);

  const searchParams = new URLSearchParams({
    db: 'pubmed',
    term: query,
    retmode: 'json',
    retmax: String(retmax),
    retstart: String(options.offset ?? 0),
    sort: 'relevance',
    tool: config.tool,
    email: config.email,
  });
  if (config.ncbiApiKey) searchParams.set('api_key', config.ncbiApiKey);

  const searchResponse = await http.getJson<ESearchEnvelope>(`${EUTILS}/esearch.fcgi?${searchParams}`);
  const esearch = searchResponse.body?.esearchresult;
  const idList = esearch?.idlist ?? [];
  const total = Number(esearch?.count ?? 0);

  if (idList.length === 0) {
    return { sources: [], total, truncated: false };
  }

  const summaryParams = new URLSearchParams({
    db: 'pubmed',
    id: idList.join(','),
    retmode: 'json',
    tool: config.tool,
    email: config.email,
  });
  if (config.ncbiApiKey) summaryParams.set('api_key', config.ncbiApiKey);

  const summaryResponse = await http.getJson<ESummaryEnvelope>(`${EUTILS}/esummary.fcgi?${summaryParams}`);
  const result = summaryResponse.body?.result;

  const retrievedAt = new Date().toISOString();
  const sources: Source[] = [];

  for (const pmid of idList) {
    const record = result?.[pmid];
    if (!record || !record.title) continue;
    sources.push(toSource(pmid, record, retrievedAt));
  }

  return {
    sources,
    total,
    truncated: total > sources.length,
  };
}

function toSource(pmid: string, record: ESummaryRecord, retrievedAt: string): Source {
  const ids: SourceIds = {};

  const normalizedPmid = normalizePmid(pmid);
  if (normalizedPmid) ids.pmid = normalizedPmid;

  for (const articleId of record.articleids ?? []) {
    if (articleId.idtype === 'doi') {
      const doi = normalizeDoi(articleId.value);
      if (doi) ids.doi = doi;
    }
    if (articleId.idtype === 'pmc') {
      const pmcid = normalizePmcid(articleId.value);
      if (pmcid) ids.pmcid = pmcid;
    }
  }

  const year = parseYear(record.pubdate ?? record.epubdate);
  const authors = (record.authors ?? [])
    .filter((a) => a.authtype === 'Author')
    .map((a) => a.name)
    .filter((name): name is string => Boolean(name));

  return {
    id: sourceKey(ids, `pubmed:${pmid}`),
    ids,
    // PubMed envuelve algunos títulos en corchetes cuando el original no es inglés.
    title: (record.title ?? '').replace(/\.$/, '').trim(),
    authors,
    ...(year !== undefined ? { year } : {}),
    ...(record.fulljournalname || record.source
      ? { journal: record.fulljournalname ?? record.source }
      : {}),
    design: classifyDesign(record.pubtype ?? []),
    // Se recupera SIN comprobar: el estado editorial lo pone el paso E2.
    editorial: uncheckedEditorial(),
    retrievedFrom: 'pubmed',
    retrievedAt,
    // PubMed no declara la licencia; que exista PMCID no implica acceso abierto.
    openAccess: false,
  };
}

export const pubmed: SourceAdapter = {
  id: 'pubmed',
  name: 'PubMed (NCBI E-utilities)',
  license: 'metadata-storable',
  licenseNote:
    'Los metadatos de PubMed son de dominio público. Los resúmenes conservan el copyright ' +
    'del editor: se almacenan para el proceso pero no se redistribuyen íntegros.',
  search,
};

interface ESearchEnvelope {
  esearchresult?: { count?: string; idlist?: string[] };
}

interface ESummaryRecord {
  title?: string;
  pubdate?: string;
  epubdate?: string;
  source?: string;
  fulljournalname?: string;
  pubtype?: string[];
  authors?: { name?: string; authtype?: string }[];
  articleids?: { idtype?: string; value?: string }[];
}

interface ESummaryEnvelope {
  result?: Record<string, ESummaryRecord | undefined>;
}
