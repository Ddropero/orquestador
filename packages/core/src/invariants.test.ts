import { describe, it, expect } from 'vitest';
import { makeClaim } from './claim.js';
import { assertRegime, requiresHuman, type Judgment } from './judgment.js';
import { isPublishable, type Verification } from './verification.js';
import { normalizeDoi, normalizePmcid, normalizePmid, sourceKey } from './ids.js';
import { uncheckedNote } from './provenance.js';
import type { Span } from './span.js';

const span = (id: string): Span => ({
  id,
  sourceId: 'doi:10.1001/jama.2024.0001',
  text: 'Negative pressure wound therapy healed 43% versus 29% with standard care.',
  section: 'results',
  textHash: 'abc123',
  extractedAt: '2026-08-11T00:00:00.000Z',
});

describe('invariante 1 — ninguna afirmación sin su span', () => {
  it('construye la afirmación cuando hay al menos un span', () => {
    const claim = makeClaim({
      id: 'c1',
      runId: 'r1',
      text: 'La TPN acelera la cicatrización.',
      spans: [span('s1')],
    });
    expect(claim.spans).toHaveLength(1);
  });

  it('rechaza una afirmación sin ningún span que la respalde', () => {
    expect(() =>
      makeClaim({ id: 'c2', runId: 'r1', text: 'La TPN acelera la cicatrización.', spans: [] }),
    ).toThrow(/invariante 1/i);
  });

  it('detecta sola que la afirmación lleva una cifra', () => {
    const numeric = makeClaim({ id: 'c3', runId: 'r1', text: 'Cicatrizó el 43%.', spans: [span('s1')] });
    const prose = makeClaim({ id: 'c4', runId: 'r1', text: 'Cicatrizó antes.', spans: [span('s1')] });
    expect(numeric.containsNumeric).toBe(true);
    expect(prose.containsNumeric).toBe(false);
  });
});

describe('invariante 2 — la IA nunca emite el juicio', () => {
  const base: Omit<Judgment, 'by'> = {
    id: 'j1',
    subjectId: 'doi:10.1001/jama.2024.0001',
    instrumentId: 'rob2',
    instrumentVersion: '2019-08-22',
    instrumentUnverified: false,
    domain: 'randomization-process',
    verdict: 'low',
    spanIds: ['s1'],
    emittedAt: '2026-08-11T00:00:00.000Z',
  };

  it('rechaza un juicio de máquina bajo régimen human-judgment', () => {
    const judgment: Judgment = { ...base, by: { kind: 'machine', identifier: 'llama-3.3-70b' } };
    expect(() => assertRegime(judgment, 'human-judgment')).toThrow(/human-judgment/);
  });

  it('acepta el mismo juicio si lo emite una persona', () => {
    const judgment: Judgment = { ...base, by: { kind: 'human', identifier: '0000-0002-1825-0097' } };
    expect(() => assertRegime(judgment, 'human-judgment')).not.toThrow();
  });

  it('bajo ai-assisted exige que la máquina adjunte los spans en que se apoya', () => {
    const sinSpans: Judgment = {
      ...base,
      spanIds: [],
      by: { kind: 'machine', identifier: 'llama-3.3-70b' },
    };
    expect(() => assertRegime(sinSpans, 'ai-assisted')).toThrow(/sin spans/);

    const conSpans: Judgment = { ...base, by: { kind: 'machine', identifier: 'llama-3.3-70b' } };
    expect(() => assertRegime(conSpans, 'ai-assisted')).not.toThrow();
  });

  it('marca como exclusivos de persona la recomendación, la certeza GRADE y el RoB global', () => {
    expect(requiresHuman('recommendation')).toBe(true);
    expect(requiresHuman('grade-certainty')).toBe(true);
    expect(requiresHuman('rob-overall')).toBe(true);
    expect(requiresHuman('data-extraction')).toBe(false);
  });
});

describe('UNRESOLVED no es NOT_FOUND', () => {
  const base: Verification = {
    id: 'v1',
    claimId: 'c1',
    existence: 'FOUND',
    editorialBlocked: false,
    support: 'supports',
    disagreement: false,
    escalated: false,
    runs: [],
  };

  it('publica cuando todo está comprobado y respaldado', () => {
    expect(isPublishable(base).ok).toBe(true);
  });

  it('no publica si no se pudo preguntar, y lo dice como fallo de la fuente', () => {
    const result = isPublishable({ ...base, existence: 'UNRESOLVED' });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/fallo de la fuente/i);
    // Lo que importa: NO acusa de que la referencia no exista.
    expect(result.reason).not.toMatch(/no existe/i);
  });

  it('no publica si la fuente afirmó que no existe, y ahí sí lo dice', () => {
    const result = isPublishable({ ...base, existence: 'NOT_FOUND' });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no existe/i);
  });

  it('no publica una fuente retractada', () => {
    expect(isPublishable({ ...base, editorialBlocked: true }).ok).toBe(false);
  });

  it('no publica mientras un desacuerdo siga sin resolver por una persona', () => {
    expect(isPublishable({ ...base, disagreement: true }).ok).toBe(false);
    expect(isPublishable({ ...base, disagreement: true, resolvedBy: 'orcid:0000' }).ok).toBe(true);
  });
});

describe('normalización de identificadores', () => {
  it('normaliza el DOI venga como venga', () => {
    const expected = '10.1001/jama.2024.0001';
    expect(normalizeDoi('https://doi.org/10.1001/JAMA.2024.0001')).toBe(expected);
    expect(normalizeDoi('doi:10.1001/jama.2024.0001')).toBe(expected);
    expect(normalizeDoi('  10.1001/jama.2024.0001.  ')).toBe(expected);
  });

  it('devuelve undefined en vez de basura cuando no es un DOI', () => {
    expect(normalizeDoi('no soy un doi')).toBeUndefined();
    expect(normalizeDoi('')).toBeUndefined();
    expect(normalizeDoi(null)).toBeUndefined();
  });

  it('normaliza PMID y PMCID', () => {
    expect(normalizePmid('0012345')).toBe('12345');
    expect(normalizePmid(12345)).toBe('12345');
    expect(normalizePmid('abc')).toBeUndefined();
    expect(normalizePmcid('pmc123')).toBe('PMC123');
    expect(normalizePmcid('123')).toBe('PMC123');
  });

  it('deriva la misma clave para el mismo trabajo venga de donde venga', () => {
    const desdePubmed = sourceKey({ doi: '10.1001/x', pmid: '999' }, 'pubmed:999');
    const desdeEpmc = sourceKey({ doi: '10.1001/x', pmcid: 'PMC1' }, 'epmc:1');
    expect(desdePubmed).toBe(desdeEpmc);
  });
});

describe('declaración de lo no comprobado', () => {
  it('declara cuántas referencias quedaron sin comprobar', () => {
    expect(uncheckedNote(7)).toMatch(/7 referencias/);
    expect(uncheckedNote(7)).toMatch(/no es ausencia de retractación/i);
  });

  it('no inventa una garantía cuando se comprobaron todas', () => {
    expect(uncheckedNote(0)).toBeUndefined();
  });
});
