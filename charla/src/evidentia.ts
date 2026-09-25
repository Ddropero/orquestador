/**
 * Integración con Evidentia (repo Ddropero/evidentia, Worker `evidentia-api`).
 *
 * Esquema tomado de `apps/api/src/index.ts` de ese repo, no supuesto:
 *   POST /runs      { mode, question }  → 202 { runId, status: InstanceStatus }
 *   GET  /runs/:id                      → 200 { runId, status: InstanceStatus }
 *   /ui#<runId>                         → la interfaz muestra ese resultado
 * donde InstanceStatus = { status, output?, error? } de Cloudflare Workflows y
 * `status` ∈ queued | running | paused | errored | terminated | complete |
 * waiting | waitingForPause | unknown.
 *
 * `GET /runs/:id` no informa el paso en curso: mientras corre solo se sabe que
 * corre. Las etapas finas salen del `output` cuando termina.
 */

export const TERMINALES_FALLIDOS = ['errored', 'terminated'] as const;
export const ETAPA_ENVIO = 'Pregunta enviada a Evidentia';
export const ETAPA_TRABAJO = 'PICO, búsqueda, verificación y síntesis';

export class ErrorEvidentia extends Error {
  override name = 'ErrorEvidentia';
}

function limpiarBase(base: string): string {
  return base.replace(/\/+$/, '');
}

export function enlaceRun(base: string, runId: string): string {
  return `${limpiarBase(base)}/ui#${encodeURIComponent(runId)}`;
}

function runIdValido(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{6,128}$/.test(v);
}

async function pedirJson(url: string, init: RequestInit, fetchImpl: typeof fetch, timeoutMs: number): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new ErrorEvidentia(`sin respuesta de Evidentia (${error instanceof Error ? error.name : 'error'})`);
  }
  if (!res.ok) throw new ErrorEvidentia(`Evidentia respondió HTTP ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new ErrorEvidentia('Evidentia devolvió algo que no es JSON (¿desafío antibot de la zona?)');
  }
}

export async function lanzar(
  base: string,
  pregunta: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 15_000,
): Promise<{ runId: string; estado: string }> {
  const datos = (await pedirJson(
    `${limpiarBase(base)}/runs`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ mode: 'ask', question: pregunta }),
    },
    fetchImpl,
    timeoutMs,
  )) as { runId?: unknown; status?: { status?: unknown } };
  if (!runIdValido(datos?.runId)) throw new ErrorEvidentia('Evidentia no devolvió un runId válido');
  const estado = typeof datos.status?.status === 'string' ? datos.status.status : 'unknown';
  return { runId: datos.runId, estado };
}

export async function consultar(
  base: string,
  runId: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 8_000,
): Promise<{ estado: string; output?: unknown }> {
  const datos = (await pedirJson(
    `${limpiarBase(base)}/runs/${encodeURIComponent(runId)}`,
    { headers: { accept: 'application/json' } },
    fetchImpl,
    timeoutMs,
  )) as { status?: { status?: unknown; output?: unknown } };
  const estado = typeof datos?.status?.status === 'string' ? datos.status.status : 'unknown';
  return { estado, ...(datos?.status?.output !== undefined ? { output: datos.status.output } : {}) };
}

function conteo(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 1_000_000 ? v : null;
}

function plural(n: number, uno: string, varios: string): string {
  return `${n} ${n === 1 ? uno : varios}`;
}

export interface EtapaDerivada {
  etapa: string;
  estado: 'completada';
  detalle?: string;
}

/**
 * Etapas visibles a partir del resultado final. Solo cifras construidas aquí:
 * ningún texto del resultado (PICO, afirmaciones, citas) llega al público, porque
 * es una síntesis NO revisada por un humano y no debe circular como evidencia.
 */
export function etapasDelResultado(output: unknown): EtapaDerivada[] {
  const o = (output && typeof output === 'object' ? output : {}) as Record<string, any>;
  const etapas: EtapaDerivada[] = [];
  const conDetalle = (etapa: string, detalle: string | null): EtapaDerivada =>
    detalle ? { etapa, estado: 'completada', detalle } : { etapa, estado: 'completada' };

  etapas.push(conDetalle('Pregunta estructurada en PICO', null));

  const pm = conteo(o['retrieval']?.['pubmed']);
  const ep = conteo(o['retrieval']?.['europepmc']);
  etapas.push(
    conDetalle(
      'Búsqueda en PubMed y Europe PMC',
      pm !== null && ep !== null ? `${plural(pm, 'referencia', 'referencias')} de PubMed y ${ep} de Europe PMC` : null,
    ),
  );

  const unicas = conteo(o['dedupe']?.['unique']);
  etapas.push(conDetalle('Deduplicación', unicas !== null ? plural(unicas, 'referencia única', 'referencias únicas') : null));

  const revisadas = conteo(o['integrity']?.['checked']);
  const retractadas = conteo(o['integrity']?.['retracted']);
  etapas.push(
    conDetalle(
      'Integridad editorial',
      revisadas !== null && retractadas !== null
        ? `${plural(revisadas, 'comprobada', 'comprobadas')} contra retractaciones · ${plural(retractadas, 'retractada', 'retractadas')}`
        : null,
    ),
  );

  const s = o['synthesis'];
  const afirmaciones = Array.isArray(s?.['afirmaciones']) ? (s['afirmaciones'] as unknown[]).length : null;
  const escaladas = Array.isArray(s?.['escaladas']) ? (s['escaladas'] as unknown[]).length : null;
  etapas.push(
    conDetalle(
      'Síntesis con cita literal',
      afirmaciones !== null
        ? `${plural(afirmaciones, 'afirmación', 'afirmaciones')} con respaldo textual` +
            (escaladas !== null ? ` · ${escaladas} ${escaladas === 1 ? 'espera' : 'esperan'} revisión humana` : '')
        : null,
    ),
  );

  etapas.push(conDetalle('Resultado', 'No revisado por un humano: no es una recomendación clínica.'));
  return etapas;
}
