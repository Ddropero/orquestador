import type { EditorialStatus } from '@evidentia/core';
import { UnresolvedError } from '@evidentia/core';
import type { HttpClient, PoliteConfig } from './http.js';

/**
 * E2 — Integridad editorial.
 *
 * Comprueba si un trabajo está retractado, retirado, bajo expresión de preocupación
 * o corregido. Es determinista: no interviene ningún modelo.
 *
 * Es la comprobación que más justifica todo el aparato. Citar un estudio retractado
 * es el fallo más caro de una síntesis y el que nadie detecta a mano, porque el PDF
 * que tienes descargado no se entera de que lo retractaron el mes pasado.
 *
 * REGLA QUE NO SE NEGOCIA: si no se pudo preguntar, el estado es `unknown` y el
 * registro NO aparece en `checkedAgainst`. Nunca `ok`. Una caída de Crossref que se
 * registre como "limpio" es peor que no comprobar nada, porque produce una garantía
 * falsa.
 */

export interface EditorialCheck {
  status: EditorialStatus;
  notice?: string;
  /** El estado impide citar el trabajo como apoyo. */
  blocking: boolean;
  /**
   * Registros que respondieron de verdad. Un registro que falló NO aparece aquí.
   * Si el array está vacío, no se comprobó nada, por mucho que `status` diga
   * `unknown`.
   */
  checkedAgainst: string[];
  /** Registros que se intentaron y fallaron, con el motivo. Va a la auditoría. */
  unresolved: { registry: string; reason: string }[];
}

/** Gravedad: menor índice, peor estado. Al combinar, gana el peor. */
const SEVERITY: EditorialStatus[] = ['retracted', 'withdrawn', 'concern', 'corrected', 'ok', 'unknown'];

function worst(a: EditorialStatus, b: EditorialStatus): EditorialStatus {
  return SEVERITY.indexOf(a) <= SEVERITY.indexOf(b) ? a : b;
}

export async function checkEditorialStatus(
  ids: { doi?: string; pmid?: string },
  http: HttpClient,
  _config: PoliteConfig,
): Promise<EditorialCheck> {
  const checkedAgainst: string[] = [];
  const unresolved: { registry: string; reason: string }[] = [];
  const notices: string[] = [];
  let status: EditorialStatus = 'unknown';

  if (ids.doi) {
    try {
      const result = await checkCrossref(ids.doi, http);
      checkedAgainst.push('crossref');
      status = worst(status, result.status);
      if (result.notice) notices.push(result.notice);
    } catch (error) {
      unresolved.push({
        registry: 'crossref',
        reason: error instanceof UnresolvedError ? error.reason : String(error).slice(0, 200),
      });
    }
  }

  if (ids.pmid) {
    try {
      const result = await checkPubmed(ids.pmid, http);
      checkedAgainst.push('pubmed');
      status = worst(status, result.status);
      if (result.notice) notices.push(result.notice);
    } catch (error) {
      unresolved.push({
        registry: 'pubmed',
        reason: error instanceof UnresolvedError ? error.reason : String(error).slice(0, 200),
      });
    }
  }

  // Sin ningún registro que haya respondido, el estado se queda en `unknown` aunque
  // alguna rama lo hubiera dejado en `ok`.
  if (checkedAgainst.length === 0) status = 'unknown';

  return {
    status,
    ...(notices.length > 0 ? { notice: notices.join(' · ') } : {}),
    blocking: status === 'retracted' || status === 'withdrawn',
    checkedAgainst,
    unresolved,
  };
}

interface RegistryResult {
  status: EditorialStatus;
  notice?: string;
}

/**
 * Crossref. Las retractaciones viajan en `update-to` / `updated-by`, donde el
 * `type` del vínculo dice de qué clase de aviso se trata.
 */
async function checkCrossref(doi: string, http: HttpClient): Promise<RegistryResult> {
  const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}?mailto=${encodeURIComponent(http.config.email)}`;
  const response = await http.getJson<CrossrefEnvelope>(url);

  // Un 404 de Crossref significa que ese DOI no está registrado. Es una afirmación
  // sobre el registro, no sobre la integridad del trabajo: no lo marca como limpio.
  if (response.notFound || !response.body) return { status: 'unknown' };

  const work = response.body.message;
  if (!work) return { status: 'unknown' };

  const updates = [...(work['update-to'] ?? []), ...(work['updated-by'] ?? [])];
  let status: EditorialStatus = 'ok';
  const notices: string[] = [];

  for (const update of updates) {
    const type = (update.type ?? '').toLowerCase();
    const mapped = mapCrossrefUpdate(type);
    if (mapped) {
      status = worst(status, mapped);
      notices.push(`crossref:${type}${update.DOI ? ` (${update.DOI})` : ''}`);
    }
  }

  // Algunos editores solo anteponen "RETRACTED:" al título.
  const title = work.title?.[0] ?? '';
  if (/^\s*(retracted|withdrawn)\b/i.test(title)) {
    status = worst(status, /withdrawn/i.test(title) ? 'withdrawn' : 'retracted');
    notices.push('crossref:título marcado');
  }

  return { status, ...(notices.length > 0 ? { notice: notices.join(', ') } : {}) };
}

function mapCrossrefUpdate(type: string): EditorialStatus | undefined {
  if (type === 'retraction' || type === 'partial_retraction') return 'retracted';
  if (type === 'withdrawal' || type === 'removal') return 'withdrawn';
  if (type === 'expression_of_concern') return 'concern';
  if (type === 'correction' || type === 'corrigendum' || type === 'erratum') return 'corrected';
  return undefined;
}

/**
 * PubMed. El estado editorial va en `pubtype` del esummary, que es donde la NLM
 * marca "Retracted Publication" y compañía.
 */
async function checkPubmed(pmid: string, http: HttpClient): Promise<RegistryResult> {
  const params = new URLSearchParams({
    db: 'pubmed',
    id: pmid,
    retmode: 'json',
    tool: http.config.tool,
    email: http.config.email,
  });
  if (http.config.ncbiApiKey) params.set('api_key', http.config.ncbiApiKey);

  const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?${params}`;
  const response = await http.getJson<PubmedSummaryEnvelope>(url);

  if (response.notFound || !response.body) return { status: 'unknown' };

  const record = response.body.result?.[pmid];
  if (!record) return { status: 'unknown' };

  const pubTypes = (record.pubtype ?? []).map((t) => t.toLowerCase());
  let status: EditorialStatus = 'ok';
  const notices: string[] = [];

  if (pubTypes.includes('retracted publication')) {
    status = worst(status, 'retracted');
    notices.push('pubmed:retracted publication');
  }
  if (pubTypes.some((t) => t.includes('expression of concern'))) {
    status = worst(status, 'concern');
    notices.push('pubmed:expression of concern');
  }
  if (pubTypes.some((t) => t.includes('corrected and republished'))) {
    status = worst(status, 'corrected');
    notices.push('pubmed:corrected and republished');
  }
  if (/^\s*(retracted|withdrawn)\b/i.test(record.title ?? '')) {
    status = worst(status, 'retracted');
    notices.push('pubmed:título marcado');
  }

  return { status, ...(notices.length > 0 ? { notice: notices.join(', ') } : {}) };
}

interface CrossrefEnvelope {
  message?: {
    title?: string[];
    'update-to'?: { type?: string; DOI?: string }[];
    'updated-by'?: { type?: string; DOI?: string }[];
  };
}

interface PubmedSummaryEnvelope {
  result?: Record<string, { title?: string; pubtype?: string[] } | undefined>;
}
