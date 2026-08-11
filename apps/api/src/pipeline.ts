/**
 * El orquestador.
 *
 * Reglas de Workflows que aquí NO son opcionales:
 *  - Los nombres de paso son la clave de caché: deterministas, sin fechas ni azar.
 *  - Todo efecto lateral va dentro de un paso.
 *  - Un paso devuelve como máximo 1 MiB. Por eso los pasos devuelven PUNTEROS a R2,
 *    nunca contenido. Un paso que intente devolver 300 resúmenes revienta.
 *  - `waitForEvent` falla por defecto a las 24 horas. Una compuerta humana necesita
 *    días, así que se fija plazo explícito y se envuelve en try/catch.
 */
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowSleepDuration,
} from 'cloudflare:workers';
import { buildPubmedQuery } from '@evidentia/search';
import { pubmed, europePmc, dedupe } from '@evidentia/sources';
import { createHttpClient, checkEditorialStatus } from '@evidentia/verify';
import type { Source } from '@evidentia/core';
import type { Env, StartRequest } from './env.js';
import { draftPico } from './ai.js';
import { persistRun, persistSources, markRunComplete } from './persist.js';

/** Plazos de las compuertas. Superarlos no debe matar la ejecución. */
const GATE_TIMEOUTS: Record<string, WorkflowSleepDuration> = {
  'gate:strategy': '14 days',
  'gate:screening': '30 days',
  'gate:final': '30 days',
};

/** Cuántos resultados se traen por fuente según el flujo. */
const LIMITS: Record<StartRequest['mode'], number> = {
  ask: 40,
  case: 60,
  protocol: 400,
  surveil: 100,
};

/**
 * Cuántas referencias pasan por la comprobación de retractación.
 *
 * En `ask` se comprueban solo las que se van a mostrar: cada una son dos peticiones
 * externas y el usuario espera una respuesta en minutos. En `protocol` se comprueban
 * TODAS, sin excepción — ahí el coste de citar un estudio retractado es otro.
 */
const EDITORIAL_CHECK_LIMIT: Record<StartRequest['mode'], number> = {
  ask: 20,
  case: 25,
  protocol: Number.MAX_SAFE_INTEGER,
  surveil: 50,
};

export class EvidencePipeline extends WorkflowEntrypoint<Env, StartRequest> {
  override async run(event: WorkflowEvent<StartRequest>, step: WorkflowStep) {
    const params = event.payload;
    const runId = event.instanceId;

    const http = createHttpClient({
      tool: this.env.NCBI_TOOL,
      email: this.env.CONTACT_EMAIL,
      ...(this.env.NCBI_API_KEY ? { ncbiApiKey: this.env.NCBI_API_KEY } : {}),
    });
    const politeConfig = {
      tool: this.env.NCBI_TOOL,
      email: this.env.CONTACT_EMAIL,
      ...(this.env.NCBI_API_KEY ? { ncbiApiKey: this.env.NCBI_API_KEY } : {}),
    };

    // ---- 1. PICO --------------------------------------------------------------
    const picoDraft = await step.do('plan:pico', async () => draftPico(params.question, this.env));

    // ---- 2. Estrategia de búsqueda --------------------------------------------
    const strategy = await step.do('plan:strategy', async () =>
      buildPubmedQuery(
        picoDraft.pico,
        params.mode === 'protocol'
          ? { methodFilter: { id: 'cochrane-rct-sensitive', version: '2023', query: RCT_FILTER } }
          : {},
      ),
    );

    await step.do('persist:plan', async () =>
      persistRun(this.env.DB, {
        runId,
        mode: params.mode,
        question: params.question,
        pico: picoDraft.pico,
        strategy,
        recallTarget: params.declaredRecallTarget,
      }),
    );

    // ---- COMPUERTA 1 -----------------------------------------------------------
    // Solo en `protocol`. `ask` y `case` corren sin detenerse, y su salida sale
    // marcada como no revisada por humano.
    if (params.mode === 'protocol') {
      const approved = await waitForGate(step, 'gate:strategy', GATE_TIMEOUTS['gate:strategy']!);
      if (!approved) {
        return { runId, status: 'abandoned', reason: 'La compuerta de estrategia expiró sin revisión.' };
      }
    }

    // ---- 3. Recuperación --------------------------------------------------------
    // Un paso por fuente: si PubMed falla, Europe PMC ya trajo lo suyo y el paso
    // caído se reintenta solo, sin repetir el que sí funcionó.
    const limit = LIMITS[params.mode];

    const fromPubmed = await step.do('search:pubmed', async () => {
      const r = await pubmed.search(strategy.query, { limit }, http, politeConfig);
      const key = `runs/${runId}/search/pubmed.json`;
      await this.env.CORPUS.put(key, JSON.stringify(r.sources));
      return { r2Key: key, count: r.sources.length, total: r.total, truncated: r.truncated };
    });

    const fromEuropePmc = await step.do('search:europepmc', async () => {
      // Europe PMC no entiende la sintaxis de campos de PubMed: se le manda una
      // consulta simplificada con los conceptos, no el bloque booleano completo.
      const simple = simplifyQuery(picoDraft.pico);
      const r = await europePmc.search(simple, { limit }, http, politeConfig);
      const key = `runs/${runId}/search/europepmc.json`;
      await this.env.CORPUS.put(key, JSON.stringify(r.sources));
      return { r2Key: key, count: r.sources.length, total: r.total, truncated: r.truncated };
    });

    // ---- 4. Deduplicación -------------------------------------------------------
    const deduped = await step.do('dedupe', async () => {
      const all: Source[] = [
        ...(await readSources(this.env.CORPUS, fromPubmed.r2Key)),
        ...(await readSources(this.env.CORPUS, fromEuropePmc.r2Key)),
      ];
      const result = dedupe(all);
      const key = `runs/${runId}/deduped.json`;
      await this.env.CORPUS.put(key, JSON.stringify(result.unique));
      return {
        r2Key: key,
        count: result.unique.length,
        duplicates: result.duplicates,
        fuzzyMerges: result.fuzzyMerges.length,
      };
    });

    // ---- 5. Integridad editorial (E2) ------------------------------------------
    // Determinista, sin IA. Es la comprobación que ninguna herramienta del mercado
    // hace bien y la que más justifica todo el aparato: citar un estudio retractado
    // es el fallo más caro y el que nadie detecta a mano.
    const editorial = await step.do('verify:editorial', async () => {
      const sources = await readSources(this.env.CORPUS, deduped.r2Key);
      const toCheck = sources.slice(0, EDITORIAL_CHECK_LIMIT[params.mode]);
      const checked: Source[] = [];
      let retracted = 0;
      let flagged = 0;

      for (const s of toCheck) {
        const ids = {
          ...(s.ids.doi ? { doi: s.ids.doi } : {}),
          ...(s.ids.pmid ? { pmid: s.ids.pmid } : {}),
        };
        if (!ids.doi && !ids.pmid) {
          checked.push(s);
          continue;
        }
        const r = await checkEditorialStatus(ids, http, politeConfig);
        if (r.blocking) retracted++;
        else if (r.status === 'concern' || r.status === 'corrected') flagged++;

        checked.push({
          ...s,
          editorial: {
            status: r.status,
            ...(r.notice ? { notice: r.notice } : {}),
            checkedAt: new Date().toISOString(),
            checkedAgainst: r.checkedAgainst,
          },
        });
      }

      const rest = sources.slice(toCheck.length);
      const key = `runs/${runId}/verified.json`;
      await this.env.CORPUS.put(key, JSON.stringify([...checked, ...rest]));

      return {
        r2Key: key,
        checked: checked.length,
        unchecked: rest.length,
        retracted,
        flagged,
      };
    });

    await step.do('persist:sources', async () => {
      const sources = await readSources(this.env.CORPUS, editorial.r2Key);
      return persistSources(this.env.DB, runId, sources);
    });

    // ---- 6. Resultado -----------------------------------------------------------
    const summary = await step.do('summarize', async () => {
      const sources = await readSources(this.env.CORPUS, editorial.r2Key);
      const citable = sources.filter(
        (s) => s.editorial.status !== 'retracted' && s.editorial.status !== 'withdrawn',
      );
      return {
        byDesign: countBy(citable, (s) => s.design),
        byYear: countBy(citable, (s) => String(s.year ?? 'sin año')),
        topReferences: citable.slice(0, 15).map((s) => ({
          title: s.title,
          year: s.year,
          journal: s.journal,
          design: s.design,
          doi: s.ids.doi,
          pmid: s.ids.pmid,
          editorial: s.editorial.status,
        })),
      };
    });

    // En `ask` y `case` acaba aquí, marcado explícitamente como no revisado.
    if (params.mode !== 'protocol') {
      await step.do('persist:complete', async () => markRunComplete(this.env.DB, runId, 'complete'));

      return {
        runId,
        status: 'complete',
        mode: params.mode,
        humanReviewed: false,
        warning:
          'Resultado NO revisado por un humano. Sirve para orientarse, no para fundamentar ' +
          'una recomendación ni para publicarse. Para eso está el flujo `protocol`.',
        pico: picoDraft.pico,
        picoAssisted: picoDraft.assisted,
        ...(picoDraft.note ? { picoNote: picoDraft.note } : {}),
        strategy,
        retrieval: {
          pubmed: fromPubmed.count,
          europepmc: fromEuropePmc.count,
          totalAvailable: { pubmed: fromPubmed.total, europepmc: fromEuropePmc.total },
          truncated: fromPubmed.truncated || fromEuropePmc.truncated,
        },
        dedupe: { unique: deduped.count, duplicates: deduped.duplicates, fuzzyMerges: deduped.fuzzyMerges },
        integrity: {
          checked: editorial.checked,
          unchecked: editorial.unchecked,
          retracted: editorial.retracted,
          flagged: editorial.flagged,
          note:
            editorial.unchecked > 0
              ? `${editorial.unchecked} referencias no se comprobaron contra registros de retractación. ` +
                'Ausencia de comprobación no es ausencia de retractación.'
              : undefined,
        },
        summary,
        artifacts: { deduped: deduped.r2Key, verified: editorial.r2Key },
      };
    }

    // ---- Flujo `protocol`: continúa con las compuertas restantes ----------------
    const resolved = await waitForGate(step, 'gate:screening', GATE_TIMEOUTS['gate:screening']!);
    if (!resolved) {
      return { runId, status: 'abandoned', reason: 'Los desacuerdos de cribado no se resolvieron.' };
    }

    // Extracción, valoración y síntesis quedan pendientes de implementar. El motor
    // SOLO adjuntará spans candidatos en la valoración: RoB 2 está en régimen
    // human-judgment y el runner de instrumentos lo hace cumplir.
    const signed = await waitForGate(step, 'gate:final', GATE_TIMEOUTS['gate:final']!);
    if (!signed) {
      return { runId, status: 'awaiting-signature', reason: 'La recomendación no fue firmada.' };
    }

    await step.do('persist:complete', async () => markRunComplete(this.env.DB, runId, 'complete'));

    return {
      runId,
      status: 'complete',
      mode: params.mode,
      humanReviewed: true,
      pico: picoDraft.pico,
      strategy,
      dedupe: { unique: deduped.count, duplicates: deduped.duplicates },
      integrity: editorial,
      summary,
      artifacts: { deduped: deduped.r2Key, verified: editorial.r2Key },
    };
  }
}

/**
 * Espera una compuerta humana sin matar la ejecución si expira.
 *
 * `waitForEvent` LANZA al agotar el plazo. Sin este try/catch, una compuerta
 * desatendida durante el plazo fijado destruye días de trabajo en vez de dejarlo
 * recuperable. Una instancia en espera no consume concurrencia ni cómputo, así que
 * esperar semanas no cuesta nada.
 */
async function waitForGate(
  step: WorkflowStep,
  type: string,
  timeout: WorkflowSleepDuration,
): Promise<boolean> {
  try {
    await step.waitForEvent(type, { type, timeout });
    return true;
  } catch {
    return false;
  }
}

async function readSources(bucket: R2Bucket, key: string): Promise<Source[]> {
  const obj = await bucket.get(key);
  if (!obj) return [];
  return (await obj.json()) as Source[];
}

function countBy<T>(items: T[], fn: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of items) {
    const k = fn(i);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

/** Europe PMC usa su propia sintaxis: se le manda lenguaje natural acotado. */
function simplifyQuery(pico: { population: string; intervention: string }): string {
  const clean = (s: string) => s.replace(/["()[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  return `"${clean(pico.population)}" AND "${clean(pico.intervention)}"`;
}

const RCT_FILTER =
  '(randomized controlled trial[pt] OR controlled clinical trial[pt] OR randomized[tiab] ' +
  'OR placebo[tiab] OR clinical trials as topic[mesh:noexp] OR randomly[tiab] OR trial[ti]) ' +
  'NOT (animals[mh] NOT humans[mh])';
