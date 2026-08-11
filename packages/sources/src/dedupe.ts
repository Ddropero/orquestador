import type { Source } from '@evidentia/core';

/**
 * Deduplicación de referencias.
 *
 * Determinista primero (DOI, PMID, PMCID), difusa solo como respaldo. El orden
 * importa: emparejar por metadatos cuando existe un identificador es introducir
 * falsos positivos gratis.
 */
export interface DedupeResult {
  unique: Source[];
  duplicates: number;
  /** Pares fusionados por coincidencia difusa. Se registran para poder auditarlos. */
  fuzzyMerges: { kept: string; dropped: string; similarity: number }[];
}

const FUZZY_THRESHOLD = 0.92;

export function dedupe(sources: Source[]): DedupeResult {
  const byId = new Map<string, Source>();
  const order: string[] = [];
  const fuzzyMerges: DedupeResult['fuzzyMerges'] = [];
  let duplicates = 0;

  for (const s of sources) {
    const keys = identityKeys(s);
    const existingKey = keys.find((k) => byId.has(k));

    if (existingKey) {
      const existing = byId.get(existingKey)!;
      const merged = mergeSources(existing, s);
      for (const k of identityKeys(merged)) byId.set(k, merged);
      duplicates++;
      continue;
    }

    for (const k of keys) byId.set(k, s);
    order.push(keys[0]!);
  }

  // Segunda pasada: difusa, solo entre los que NO comparten identificador.
  const unique: Source[] = [];
  for (const key of order) {
    const candidate = byId.get(key);
    if (!candidate) continue;

    const twin = unique.find((u) => {
      // Si ambos tienen DOI y son distintos, NO son el mismo trabajo. No se compara.
      if (u.ids.doi && candidate.ids.doi && u.ids.doi !== candidate.ids.doi) return false;
      if (u.year && candidate.year && Math.abs(u.year - candidate.year) > 1) return false;
      return similarity(u.title, candidate.title) >= FUZZY_THRESHOLD;
    });

    if (twin) {
      fuzzyMerges.push({
        kept: twin.id,
        dropped: candidate.id,
        similarity: Number(similarity(twin.title, candidate.title).toFixed(3)),
      });
      duplicates++;
      const idx = unique.indexOf(twin);
      unique[idx] = mergeSources(twin, candidate);
      continue;
    }

    unique.push(candidate);
  }

  return { unique, duplicates, fuzzyMerges };
}

/** Claves de identidad, de más fiable a menos. */
function identityKeys(s: Source): string[] {
  const keys: string[] = [];
  if (s.ids.doi) keys.push(`doi:${s.ids.doi}`);
  if (s.ids.pmid) keys.push(`pmid:${s.ids.pmid}`);
  if (s.ids.pmcid) keys.push(`pmcid:${s.ids.pmcid.toUpperCase()}`);
  if (keys.length === 0) keys.push(`id:${s.id}`);
  return keys;
}

/**
 * Fusiona dos registros del mismo trabajo. Conserva el más informativo campo a
 * campo, y NUNCA degrada el estado editorial: si una de las dos copias dice que
 * está retractada, la fusión está retractada.
 */
export function mergeSources(a: Source, b: Source): Source {
  const worseEditorial = ['retracted', 'withdrawn', 'concern', 'corrected', 'ok', 'unknown'];
  const rank = (s: string) => worseEditorial.indexOf(s);
  const editorial = rank(a.editorial.status) <= rank(b.editorial.status) ? a.editorial : b.editorial;

  return {
    ...a,
    ids: { ...b.ids, ...a.ids },
    title: a.title.length >= b.title.length ? a.title : b.title,
    authors: a.authors.length >= b.authors.length ? a.authors : b.authors,
    ...(a.year ?? b.year ? { year: a.year ?? b.year } : {}),
    ...(a.journal ?? b.journal ? { journal: a.journal ?? b.journal } : {}),
    ...(a.abstract ?? b.abstract ? { abstract: a.abstract ?? b.abstract } : {}),
    design: a.design !== 'unknown' ? a.design : b.design,
    editorial: {
      ...editorial,
      checkedAgainst: [...new Set([...a.editorial.checkedAgainst, ...b.editorial.checkedAgainst])],
    },
    ...(a.fullTextKey ?? b.fullTextKey ? { fullTextKey: a.fullTextKey ?? b.fullTextKey } : {}),
    openAccess: a.openAccess || b.openAccess,
  };
}

function similarity(a: string, b: string): number {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  const A = new Set(norm(a).split(' ').filter((w) => w.length > 2));
  const B = new Set(norm(b).split(' ').filter((w) => w.length > 2));
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return (2 * shared) / (A.size + B.size);
}
