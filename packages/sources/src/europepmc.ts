import type { Source, SourceIds } from '@evidentia/core';
import { normalizeDoi, normalizePmcid, normalizePmid, sourceKey, uncheckedEditorial } from '@evidentia/core';
import type { HttpClient, PoliteConfig } from '@evidentia/verify';
import { classifyDesign, parseYear, type SearchOptions, type SearchResult, type SourceAdapter } from './registry.js';

/**
 * Adaptador de Europe PMC.
 *
 * Está por dos razones que PubMed no cubre: indexa preprints y literatura europea
 * que PubMed no tiene, y declara la licencia de cada trabajo, que es lo que permite
 * decidir si su texto completo se puede almacenar.
 *
 * Su sintaxis NO es la de PubMed. Las etiquetas de campo `[tiab]` y `[mh]` no
 * significan nada aquí, así que el orquestador le manda una consulta simplificada
 * en vez de la cadena booleana completa. Mandarle la de PubMed devuelve cero
 * resultados sin dar error, que es la peor forma de fallar.
 */

const ENDPOINT = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search';

/** Licencias cuyo texto completo se puede almacenar y volver a publicar en cita. */
const STORABLE_LICENSES = ['cc0', 'cc-by', 'cc by', 'cc-by-sa', 'cc by-sa'];

async function search(
  query: string,
  options: SearchOptions,
  http: HttpClient,
  config: PoliteConfig,
): Promise<SearchResult> {
  const params = new URLSearchParams({
    query,
    format: 'json',
    resultType: 'core',
    pageSize: String(Math.min(options.limit, 100)),
    // `email` no es obligatorio aquí, pero identificarse evita el límite anónimo.
    email: config.email,
  });

  const response = await http.getJson<EpmcEnvelope>(`${ENDPOINT}?${params}`);
  const body = response.body;
  const results = body?.resultList?.result ?? [];
  const total = body?.hitCount ?? 0;

  const retrievedAt = new Date().toISOString();
  const sources: Source[] = [];

  for (const record of results) {
    if (!record.title) continue;
    sources.push(toSource(record, retrievedAt));
  }

  return { sources, total, truncated: total > sources.length };
}

function toSource(record: EpmcRecord, retrievedAt: string): Source {
  const ids: SourceIds = {};

  const doi = normalizeDoi(record.doi);
  if (doi) ids.doi = doi;
  const pmid = normalizePmid(record.pmid);
  if (pmid) ids.pmid = pmid;
  const pmcid = normalizePmcid(record.pmcid);
  if (pmcid) ids.pmcid = pmcid;

  const year = parseYear(record.pubYear ?? record.firstPublicationDate);
  const license = record.license?.toLowerCase();

  const authors = (record.authorList?.author ?? [])
    .map((a) => a.fullName ?? [a.lastName, a.initials].filter(Boolean).join(' '))
    .filter((name): name is string => Boolean(name));

  const publicationTypes = record.pubTypeList?.pubType ?? [];

  return {
    id: sourceKey(ids, `epmc:${record.id ?? record.title ?? 'sin-id'}`),
    ids,
    title: (record.title ?? '').replace(/\.$/, '').trim(),
    authors,
    ...(year !== undefined ? { year } : {}),
    ...(record.journalTitle ? { journal: record.journalTitle } : {}),
    ...(record.abstractText ? { abstract: record.abstractText } : {}),
    design: classifyDesign(publicationTypes),
    editorial: uncheckedEditorial(),
    ...(license ? { license } : {}),
    retrievedFrom: 'europepmc',
    retrievedAt,
    openAccess: record.isOpenAccess === 'Y',
  };
}

/** Si la licencia permite almacenar el texto completo. Ante la duda, no. */
export function canStoreFullText(license: string | undefined): boolean {
  if (!license) return false;
  const normalized = license.toLowerCase().trim();
  return STORABLE_LICENSES.some((allowed) => normalized.startsWith(allowed));
}

export const europePmc: SourceAdapter = {
  id: 'europepmc',
  name: 'Europe PMC',
  license: 'fulltext-conditional',
  licenseNote:
    'Europe PMC declara la licencia de cada trabajo. El texto completo solo se almacena ' +
    'cuando la licencia lo permite (ver canStoreFullText); en el resto se guardan ' +
    'únicamente metadatos e identificadores.',
  search,
};

interface EpmcRecord {
  id?: string;
  doi?: string;
  pmid?: string;
  pmcid?: string;
  title?: string;
  journalTitle?: string;
  pubYear?: string;
  firstPublicationDate?: string;
  abstractText?: string;
  license?: string;
  isOpenAccess?: string;
  authorList?: { author?: { fullName?: string; lastName?: string; initials?: string }[] };
  pubTypeList?: { pubType?: string[] };
}

interface EpmcEnvelope {
  hitCount?: number;
  resultList?: { result?: EpmcRecord[] };
}
