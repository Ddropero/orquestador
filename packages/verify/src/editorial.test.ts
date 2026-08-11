import { describe, it, expect } from 'vitest';
import { UnresolvedError } from '@evidentia/core';
import { checkEditorialStatus } from './editorial.js';
import type { HttpClient, HttpResponse, PoliteConfig } from './http.js';

/**
 * El caso que importa: una caída de Crossref NO puede acabar en "limpio".
 *
 * Si lo hiciera, el sistema emitiría una garantía de integridad que nadie
 * comprobó, que es peor que no comprobar nada.
 */

const config: PoliteConfig = { tool: 'evidentia-test', email: 'test@example.org' };

function stubClient(handler: (url: string) => unknown): HttpClient {
  return {
    config,
    async getJson<T>(url: string): Promise<HttpResponse<T>> {
      const result = handler(url);
      if (result instanceof Error) throw result;
      if (result === undefined) return { status: 404, notFound: true };
      return { body: result as T, status: 200, notFound: false };
    },
  };
}

const CROSSREF_LIMPIO = { message: { title: ['Un ensayo cualquiera'] } };
const CROSSREF_RETRACTADO = {
  message: {
    title: ['Un ensayo retractado'],
    'updated-by': [{ type: 'retraction', DOI: '10.1001/notice' }],
  },
};
const PUBMED_LIMPIO = { result: { '123': { title: 'Un ensayo', pubtype: ['Journal Article'] } } };
const PUBMED_RETRACTADO = {
  result: { '123': { title: 'Un ensayo', pubtype: ['Journal Article', 'Retracted Publication'] } },
};

describe('checkEditorialStatus', () => {
  it('marca retractado lo que Crossref declara retractado', async () => {
    const http = stubClient((url) => (url.includes('crossref') ? CROSSREF_RETRACTADO : PUBMED_LIMPIO));
    const result = await checkEditorialStatus({ doi: '10.1001/x', pmid: '123' }, http, config);

    expect(result.status).toBe('retracted');
    expect(result.blocking).toBe(true);
    expect(result.checkedAgainst).toEqual(['crossref', 'pubmed']);
  });

  it('marca retractado lo que PubMed declara retractado aunque Crossref no lo sepa', async () => {
    const http = stubClient((url) => (url.includes('crossref') ? CROSSREF_LIMPIO : PUBMED_RETRACTADO));
    const result = await checkEditorialStatus({ doi: '10.1001/x', pmid: '123' }, http, config);

    expect(result.status).toBe('retracted');
    expect(result.blocking).toBe(true);
  });

  it('dice ok solo cuando algún registro respondió y salió limpio', async () => {
    const http = stubClient((url) => (url.includes('crossref') ? CROSSREF_LIMPIO : PUBMED_LIMPIO));
    const result = await checkEditorialStatus({ doi: '10.1001/x', pmid: '123' }, http, config);

    expect(result.status).toBe('ok');
    expect(result.blocking).toBe(false);
    expect(result.unresolved).toEqual([]);
  });

  it('NO dice ok cuando ningún registro pudo responder', async () => {
    const http = stubClient(() => new UnresolvedError('crossref', 'HTTP 503'));
    const result = await checkEditorialStatus({ doi: '10.1001/x', pmid: '123' }, http, config);

    expect(result.status).toBe('unknown');
    expect(result.blocking).toBe(false);
    // Lo esencial: no se comprobó contra nada, y queda registrado por qué.
    expect(result.checkedAgainst).toEqual([]);
    expect(result.unresolved).toHaveLength(2);
    expect(result.unresolved[0]?.reason).toContain('503');
  });

  it('si Crossref se cae pero PubMed responde, solo declara PubMed', async () => {
    const http = stubClient((url) =>
      url.includes('crossref') ? new UnresolvedError('crossref', 'timeout') : PUBMED_LIMPIO,
    );
    const result = await checkEditorialStatus({ doi: '10.1001/x', pmid: '123' }, http, config);

    expect(result.status).toBe('ok');
    expect(result.checkedAgainst).toEqual(['pubmed']);
    expect(result.unresolved).toEqual([{ registry: 'crossref', reason: 'timeout' }]);
  });

  it('un DOI no registrado en Crossref no cuenta como trabajo limpio', async () => {
    // 404 de Crossref: el DOI no está en su registro. No dice nada sobre integridad.
    const http = stubClient((url) => (url.includes('crossref') ? undefined : PUBMED_LIMPIO));
    const result = await checkEditorialStatus({ doi: '10.9999/inexistente' }, http, config);

    expect(result.status).toBe('unknown');
    expect(result.blocking).toBe(false);
  });

  it('sin identificadores no comprueba nada y lo declara', async () => {
    const http = stubClient(() => CROSSREF_LIMPIO);
    const result = await checkEditorialStatus({}, http, config);

    expect(result.status).toBe('unknown');
    expect(result.checkedAgainst).toEqual([]);
  });
});
