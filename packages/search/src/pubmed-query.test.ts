import { describe, it, expect } from 'vitest';
import type { Pico } from '@evidentia/core';
import { buildPubmedQuery } from './pubmed-query.js';

const pico: Pico = {
  population: 'diabetic foot ulcer',
  intervention: 'negative pressure wound therapy',
  comparator: 'standard wound care',
  outcomes: [
    { label: 'wound healing', importance: 'critical' },
    { label: 'coste', importance: 'not-important' },
  ],
  studyDesigns: [],
};

describe('buildPubmedQuery', () => {
  it('monta un bloque por concepto, unidos por AND', () => {
    const strategy = buildPubmedQuery(pico);
    expect(strategy.blocks.map((b) => b.concept)).toEqual(['population', 'intervention', 'outcome']);
    expect(strategy.query).toContain(' AND ');
  });

  it('busca cada término como texto libre y como descriptor MeSH', () => {
    const strategy = buildPubmedQuery(pico);
    expect(strategy.query).toContain('"diabetic foot ulcer"[tiab]');
    expect(strategy.query).toContain('"diabetic foot ulcer"[mh]');
  });

  it('NO mete el comparador en la cadena', () => {
    // Exigir el comparador con AND elimina los ensayos que no lo nombran en
    // título ni resumen. Es el error clásico que hunde la sensibilidad.
    const strategy = buildPubmedQuery(pico);
    expect(strategy.query).not.toContain('standard wound care');
  });

  it('solo acota por desenlaces críticos, y avisa de que acota', () => {
    const strategy = buildPubmedQuery(pico);
    expect(strategy.query).toContain('wound healing');
    expect(strategy.query).not.toContain('coste');
    expect(strategy.caveats.some((c) => /desenlaces críticos/i.test(c))).toBe(true);
  });

  it('aplica el filtro metodológico con su identidad y versión', () => {
    const strategy = buildPubmedQuery(pico, {
      methodFilter: { id: 'cochrane-rct-sensitive', version: '2023', query: 'randomized[tiab]' },
    });
    expect(strategy.query).toContain('randomized[tiab]');
    expect(strategy.methodFilter?.version).toBe('2023');
  });

  it('no acota por idioma ni por fecha por su cuenta', () => {
    const strategy = buildPubmedQuery(pico);
    expect(strategy.query).not.toMatch(/\[lang|\[dp\]|english/i);
  });

  it('neutraliza los operadores que llegan dentro de un término', () => {
    // El PICO lo redacta un modelo: un corchete suelto cambia la semántica de la
    // cadena o hace que PubMed la rechace.
    const sucio: Pico = {
      ...pico,
      population: 'adults [with] (diabetes) AND "foot"',
      outcomes: [],
    };
    const strategy = buildPubmedQuery(sucio);
    const populationBlock = strategy.blocks.find((b) => b.concept === 'population');

    // Los términos quedan limpios; los corchetes que sobreviven son las etiquetas
    // de campo que pone el propio constructor, no los que venían en el texto.
    expect(populationBlock?.terms).toEqual([
      '"adults with diabetes foot"[tiab]',
      '"adults with diabetes foot"[mh]',
    ]);
    expect(strategy.query).not.toContain('(diabetes)');
  });

  it('cae a la pregunta literal y lo declara cuando el PICO no es utilizable', () => {
    const vacio: Pico = { population: '', intervention: '', outcomes: [], studyDesigns: [] };
    const strategy = buildPubmedQuery(vacio);
    expect(strategy.blocks).toEqual([]);
    expect(strategy.caveats.some((c) => /sensibilidad/i.test(c))).toBe(true);
  });
});
