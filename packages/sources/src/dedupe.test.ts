import { describe, it, expect } from 'vitest';
import { dedupe, mergeSources } from './dedupe.js';
import type { Source } from '@evidentia/core';

function src(p: Partial<Source> & { id: string }): Source {
  return {
    ids: {},
    title: 'Un título cualquiera sobre algo clínico',
    authors: [],
    design: 'unknown',
    editorial: { status: 'unknown', checkedAgainst: [] },
    retrievedFrom: 'test',
    retrievedAt: '2026-08-10T00:00:00.000Z',
    ...p,
  } as Source;
}

describe('dedupe', () => {
  it('fusiona por DOI aunque vengan de fuentes distintas', () => {
    const r = dedupe([
      src({ id: 'a', ids: { doi: '10.1136/bmj.l4898' }, retrievedFrom: 'pubmed' }),
      src({ id: 'b', ids: { doi: '10.1136/bmj.l4898' }, retrievedFrom: 'europepmc' }),
    ]);
    expect(r.unique).toHaveLength(1);
    expect(r.duplicates).toBe(1);
  });

  it('fusiona por PMID cuando no hay DOI', () => {
    const r = dedupe([
      src({ id: 'a', ids: { pmid: '31462531' } }),
      src({ id: 'b', ids: { pmid: '31462531' } }),
    ]);
    expect(r.unique).toHaveLength(1);
  });

  it('NO fusiona dos trabajos con DOI distinto aunque el título se parezca', () => {
    // Es el falso positivo más caro: dos ensayos del mismo grupo con títulos casi
    // idénticos son estudios DISTINTOS y deben contar por separado en la síntesis.
    const r = dedupe([
      src({ id: 'a', ids: { doi: '10.1000/uno' }, title: 'Efecto del tratamiento X en la cicatrización' }),
      src({ id: 'b', ids: { doi: '10.1000/dos' }, title: 'Efecto del tratamiento X en la cicatrización' }),
    ]);
    expect(r.unique).toHaveLength(2);
  });

  it('fusiona por título cuando ninguno tiene identificador', () => {
    const r = dedupe([
      src({ id: 'a', title: 'Terapia de presión negativa en pie diabético', year: 2024 }),
      src({ id: 'b', title: 'Terapia de presión negativa en pie diabético.', year: 2024 }),
    ]);
    expect(r.unique).toHaveLength(1);
    expect(r.fuzzyMerges).toHaveLength(1);
  });

  it('registra las fusiones difusas para poder auditarlas', () => {
    const r = dedupe([
      src({ id: 'a', title: 'Terapia de presión negativa en pie diabético' }),
      src({ id: 'b', title: 'Terapia de presión negativa en pie diabético' }),
    ]);
    expect(r.fuzzyMerges[0]?.kept).toBe('a');
    expect(r.fuzzyMerges[0]?.dropped).toBe('b');
  });

  it('no fusiona estudios separados por más de un año', () => {
    const r = dedupe([
      src({ id: 'a', title: 'Mismo título exacto de estudio', year: 2018 }),
      src({ id: 'b', title: 'Mismo título exacto de estudio', year: 2024 }),
    ]);
    expect(r.unique).toHaveLength(2);
  });
});

describe('mergeSources', () => {
  it('NUNCA degrada el estado editorial: una retractación siempre gana', () => {
    const limpio = src({ id: 'a', editorial: { status: 'ok', checkedAgainst: ['crossref'] } });
    const retractado = src({ id: 'b', editorial: { status: 'retracted', checkedAgainst: ['pubmed'] } });

    expect(mergeSources(limpio, retractado).editorial.status).toBe('retracted');
    expect(mergeSources(retractado, limpio).editorial.status).toBe('retracted');
  });

  it('conserva contra qué fuentes se comprobó, de las dos copias', () => {
    const m = mergeSources(
      src({ id: 'a', editorial: { status: 'ok', checkedAgainst: ['crossref'] } }),
      src({ id: 'b', editorial: { status: 'ok', checkedAgainst: ['pubmed'] } }),
    );
    expect(m.editorial.checkedAgainst.sort()).toEqual(['crossref', 'pubmed']);
  });

  it('conserva el diseño conocido frente al desconocido', () => {
    const m = mergeSources(src({ id: 'a', design: 'unknown' }), src({ id: 'b', design: 'rct' }));
    expect(m.design).toBe('rct');
  });
});
