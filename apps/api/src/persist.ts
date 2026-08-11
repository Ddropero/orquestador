import type { Pico, SearchStrategy, Source } from '@evidentia/core';

/**
 * Persistencia en D1.
 *
 * D1 es la fuente de verdad operativa: el estado interno de Workflows se retiene
 * solo 30 días, y el registro de auditoría de una revisión tiene que durar años.
 *
 * Todas las escrituras son IDEMPOTENTES por (run_id, id). Un paso de Workflows
 * puede reintentarse tras un fallo parcial, y una escritura no idempotente
 * convertiría un reintento en datos duplicados.
 */

export async function persistRun(
  db: D1Database,
  input: {
    runId: string;
    mode: string;
    question: string;
    pico: Pico;
    strategy: SearchStrategy;
    recallTarget: number;
  },
): Promise<{ ok: true }> {
  await db
    .prepare(
      `INSERT INTO runs (id, mode, question, pico_json, strategy_json, recall_target, status, created_at)
       VALUES (?,?,?,?,?,?,'running',?)
       ON CONFLICT(id) DO UPDATE SET
         pico_json = excluded.pico_json,
         strategy_json = excluded.strategy_json`,
    )
    .bind(
      input.runId,
      input.mode,
      input.question,
      JSON.stringify(input.pico),
      JSON.stringify(input.strategy),
      input.recallTarget,
      new Date().toISOString(),
    )
    .run();
  return { ok: true };
}

export async function persistSources(
  db: D1Database,
  runId: string,
  sources: Source[],
): Promise<{ inserted: number }> {
  if (sources.length === 0) return { inserted: 0 };

  const stmt = db.prepare(
    `INSERT INTO sources
       (id, run_id, doi, pmid, pmcid, title, year, journal, design,
        editorial_status, editorial_notice, editorial_checked_at,
        license, full_text_key, retrieved_from, retrieved_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       editorial_status = excluded.editorial_status,
       editorial_notice = excluded.editorial_notice,
       editorial_checked_at = excluded.editorial_checked_at`,
  );

  // D1 limita a 1.000 consultas por invocación del Worker; los lotes de 100 dejan
  // margen de sobra y mantienen las transacciones cortas.
  let inserted = 0;
  for (let i = 0; i < sources.length; i += 100) {
    const batch = sources.slice(i, i + 100).map((s) =>
      stmt.bind(
        `${runId}:${s.id}`,
        runId,
        s.ids.doi ?? null,
        s.ids.pmid ?? null,
        s.ids.pmcid ?? null,
        s.title,
        s.year ?? null,
        s.journal ?? null,
        s.design,
        s.editorial.status,
        s.editorial.notice ?? null,
        s.editorial.checkedAt ?? null,
        s.license ?? null,
        s.fullTextKey ?? null,
        s.retrievedFrom,
        s.retrievedAt,
      ),
    );
    await db.batch(batch);
    inserted += batch.length;
  }

  return { inserted };
}

export async function markRunComplete(
  db: D1Database,
  runId: string,
  status: string,
): Promise<{ ok: true }> {
  await db
    .prepare('UPDATE runs SET status = ?, completed_at = ? WHERE id = ?')
    .bind(status, new Date().toISOString(), runId)
    .run();
  return { ok: true };
}
