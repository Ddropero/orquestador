import type { Pico } from '@evidentia/core';
import type { Env } from './env.js';

/**
 * Estructuración de la pregunta en PICO.
 *
 * DISEÑO DEFENSIVO DELIBERADO: si el modelo falla, devuelve algo inválido o la
 * cuenta topa el límite de peticiones, esta función NO propaga el error — cae a
 * una extracción determinista y marca `assisted: false`.
 *
 * El motivo es que un fallo de IA no debe dejar al clínico sin respuesta. Una
 * búsqueda con términos literales es peor que una bien estructurada, pero es
 * infinitamente mejor que un error 500. Y el resultado dice cuál de las dos fue.
 */
export interface PicoDraft {
  pico: Pico;
  assisted: boolean;
  model?: string;
  note?: string;
}

const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

export async function draftPico(question: string, env: Env): Promise<PicoDraft> {
  try {
    const response = (await env.AI.run(MODEL, {
      messages: [
        {
          role: 'system',
          content:
            'Eres un metodólogo de síntesis de evidencia. Estructuras preguntas clínicas en formato PICO. ' +
            'Respondes SOLO con JSON válido, sin texto alrededor. Usa terminología médica en inglés para los ' +
            'campos population e intervention, porque alimentan una búsqueda en PubMed. Los desenlaces van en español. ' +
            'No inventes desenlaces que la pregunta no implique.',
        },
        {
          role: 'user',
          content:
            `Pregunta clínica: "${question}"\n\n` +
            'Devuelve JSON con esta forma exacta:\n' +
            '{"population":"...","intervention":"...","comparator":"...",' +
            '"outcomes":[{"label":"...","importance":"critical|important|not-important"}],' +
            '"synonyms":{"<término>":["sinónimo1","sinónimo2"]}}',
        },
      ],
      max_tokens: 800,
      temperature: 0.1,
    })) as { response?: string };

    const parsed = extractJson(response?.response ?? '');
    if (!parsed) return fallback(question, 'El modelo no devolvió JSON interpretable.');

    const pico = coercePico(parsed);
    if (!pico) return fallback(question, 'El JSON del modelo no tenía la forma esperada.');

    return { pico, assisted: true, model: MODEL };
  } catch (error) {
    return fallback(question, `Fallo al invocar el modelo: ${String(error).slice(0, 200)}`);
  }
}

/**
 * Extrae el primer objeto JSON del texto. Los modelos añaden prosa o vallas de
 * código incluso cuando se les pide que no lo hagan.
 */
function extractJson(text: string): Record<string, unknown> | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function coercePico(raw: Record<string, unknown>): Pico | undefined {
  const population = typeof raw['population'] === 'string' ? raw['population'].trim() : '';
  const intervention = typeof raw['intervention'] === 'string' ? raw['intervention'].trim() : '';
  if (!population || !intervention) return undefined;

  const rawOutcomes = Array.isArray(raw['outcomes']) ? raw['outcomes'] : [];
  const outcomes = rawOutcomes
    .filter((o): o is Record<string, unknown> => typeof o === 'object' && o !== null)
    .map((o) => ({
      label: String(o['label'] ?? '').trim(),
      importance: normalizeImportance(o['importance']),
    }))
    .filter((o) => o.label.length > 0);

  if (outcomes.length === 0) return undefined;

  const comparator = typeof raw['comparator'] === 'string' ? raw['comparator'].trim() : '';

  return {
    population,
    intervention,
    ...(comparator ? { comparator } : {}),
    outcomes,
    studyDesigns: [],
  };
}

function normalizeImportance(v: unknown): 'critical' | 'important' | 'not-important' {
  const s = String(v ?? '').toLowerCase();
  if (s.startsWith('crit')) return 'critical';
  if (s.startsWith('not')) return 'not-important';
  return 'important';
}

/**
 * Respaldo determinista. La pregunta entera se usa como término de búsqueda y el
 * desenlace queda explícitamente sin especificar — no se inventa uno.
 */
function fallback(question: string, note: string): PicoDraft {
  return {
    pico: {
      population: question.slice(0, 200),
      intervention: question.slice(0, 200),
      outcomes: [{ label: 'Sin especificar (PICO no estructurado)', importance: 'important' }],
      studyDesigns: [],
    },
    assisted: false,
    note: `${note} Se usó la pregunta literal como término de búsqueda; la sensibilidad de esta búsqueda es menor.`,
  };
}

/** Extrae los sinónimos que propuso el modelo, si los propuso. */
export function extractSynonyms(raw: unknown): Record<string, string[]> {
  if (typeof raw !== 'object' || raw === null) return {};
  const syn = (raw as Record<string, unknown>)['synonyms'];
  if (typeof syn !== 'object' || syn === null) return {};
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(syn as Record<string, unknown>)) {
    if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === 'string');
  }
  return out;
}
