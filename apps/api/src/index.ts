import { UNREVIEWED_WARNING } from '@evidentia/core';
import { isRunMode, type Env, type StartRequest } from './env.js';

export { EvidencePipeline } from './pipeline.js';

/**
 * Worker HTTP.
 *
 * Fino a propósito: valida, arranca la instancia de Workflow y devuelve el
 * identificador. Todo el trabajo real vive en los pasos, porque una petición HTTP
 * no puede durar los minutos que tarda una búsqueda ni las semanas que tarda una
 * compuerta humana.
 */

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), { status, headers: JSON_HEADERS });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    try {
      if (path === '/health') return await health(env);
      if (path === '/runs' && request.method === 'POST') return await startRun(request, env);

      const runMatch = path.match(/^\/runs\/([^/]+)$/);
      if (runMatch?.[1] && request.method === 'GET') return await getRun(runMatch[1], env);

      if (path === '/') {
        return json({
          service: 'evidentia',
          description: 'Orquestador de evidencia científica para decisiones clínicas.',
          endpoints: {
            'GET /health': 'Estado del servicio y sus enlaces.',
            'POST /runs': 'Arranca una ejecución. Cuerpo: { mode, question }.',
            'GET /runs/:runId': 'Estado y resultado de una ejecución.',
          },
        });
      }

      return json({ error: 'not_found', path }, 404);
    } catch (error) {
      return json(
        { error: 'internal_error', message: error instanceof Error ? error.message : String(error) },
        500,
      );
    }
  },
} satisfies ExportedHandler<Env>;

/**
 * Comprueba los enlaces de verdad, no solo que el Worker esté vivo.
 *
 * Un `/health` que devuelve 200 sin tocar D1 solo dice que el runtime arrancó. El
 * fallo que importa —una migración sin aplicar, un enlace mal escrito— no aparece
 * hasta la primera ejecución real, cuando ya cuesta caro.
 */
async function health(env: Env): Promise<Response> {
  const checks: Record<string, string> = {};

  try {
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM runs').first<{ n: number }>();
    checks['d1'] = `ok (${row?.n ?? 0} ejecuciones)`;
  } catch (error) {
    checks['d1'] = `error: ${error instanceof Error ? error.message : String(error)}`;
  }

  checks['r2'] = env.CORPUS ? 'enlazado' : 'AUSENTE';
  checks['workflow'] = env.PIPELINE ? 'enlazado' : 'AUSENTE';
  checks['vectorize'] = env.VECTORS ? 'enlazado' : 'AUSENTE';
  checks['ai'] = env.AI ? 'enlazado' : 'AUSENTE';

  // La identificación cortés no es opcional: sin ella NCBI limita a 3 peticiones/s
  // y puede bloquear la IP, y el fallo aparecería mucho después y lejos de aquí.
  checks['contact_email'] =
    env.CONTACT_EMAIL && !env.CONTACT_EMAIL.includes('PENDIENTE') ? 'configurado' : 'SIN CONFIGURAR';
  checks['ncbi_api_key'] = env.NCBI_API_KEY ? 'presente (10 pet./s)' : 'ausente (3 pet./s)';

  return json({ status: 'ok', service: 'evidentia', checks });
}

async function startRun(request: Request, env: Env): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'invalid_json', message: 'El cuerpo debe ser JSON.' }, 400);
  }

  const body = (payload ?? {}) as Record<string, unknown>;
  const mode = body['mode'];
  const question = body['question'];

  if (!isRunMode(mode)) {
    return json(
      { error: 'invalid_mode', message: 'mode debe ser: ask, case, protocol o surveil.' },
      400,
    );
  }

  if (typeof question !== 'string' || question.trim().length < 10) {
    return json(
      { error: 'invalid_question', message: 'question es obligatoria y debe tener al menos 10 caracteres.' },
      400,
    );
  }

  const rawTarget = body['declaredRecallTarget'];
  const declaredRecallTarget =
    typeof rawTarget === 'number' && rawTarget > 0 && rawTarget <= 1 ? rawTarget : 0.95;

  const params: StartRequest = {
    mode,
    question: question.trim(),
    declaredRecallTarget,
  };

  const instance = await env.PIPELINE.create({ params });

  return json(
    {
      runId: instance.id,
      mode,
      status: 'running',
      poll: `/runs/${instance.id}`,
      ...(mode === 'ask' || mode === 'case' ? { warning: UNREVIEWED_WARNING } : {}),
    },
    202,
  );
}

async function getRun(runId: string, env: Env): Promise<Response> {
  let instance;
  try {
    instance = await env.PIPELINE.get(runId);
  } catch {
    return json({ error: 'run_not_found', runId }, 404);
  }

  const status = await instance.status();

  // El estado de Workflows se retiene 30 días; D1 dura lo que dure la auditoría.
  // Se devuelven los dos y se dice de dónde sale cada cosa.
  const persisted = await env.DB.prepare(
    'SELECT mode, question, status, created_at, completed_at FROM runs WHERE id = ?',
  )
    .bind(runId)
    .first<{
      mode: string;
      question: string;
      status: string;
      created_at: string;
      completed_at: string | null;
    }>();

  return json({
    runId,
    workflow: {
      status: status.status,
      ...(status.output !== undefined ? { output: status.output } : {}),
      ...(status.error !== undefined && status.error !== null ? { error: status.error } : {}),
    },
    ...(persisted ? { persisted } : {}),
  });
}
