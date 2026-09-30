/**
 * Simuladores de los tres servicios externos, para las pruebas de extremo a extremo:
 *   - NCBI E-utilities (esearch/esummary) con las respuestas grabadas en test/fixtures/ncbi.json,
 *     y efetch con el XML real de los tres artículos del chat (test/fixtures/efetch-chat.xml)
 *   - La API de Anthropic (POST /v1/messages en streaming SSE)
 *   - Evidentia (GET /health, POST /runs, GET /runs/:id)
 *
 * Un solo servidor HTTP. `/__modo` cambia el comportamiento en caliente:
 *   POST /__modo { ncbi: "ok"|"caido"|"html", claude: "ok"|"error"|"colgado", evidentia: "ok"|"caido" }
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const TEXTO_CLAUDE_SIMULADO =
  'Respuesta simulada para las pruebas. El ensayo aleatorizó a adultos con influenza confirmada a recibir ' +
  'oseltamivir temprano o placebo y midió los días hasta volver al trabajo. Los autores informan una ' +
  'reducción de 1,4 días en el grupo tratado, con más náuseas. Usted debería comprobar este artículo antes de citarlo.';

/** La respuesta simulada del chat: dos citas a artículos leídos y una a un PMID que no salió de la búsqueda. */
export const TEXTO_CHAT_SIMULADO =
  'Respuesta simulada del chat. En adultos, el oseltamivir acortó el alivio de los síntomas unas 17 horas [PMID 24811411] ' +
  'y en otro metaanálisis alrededor de un día [PMID 25640810]. Esta cita no salió de la búsqueda [PMID 99999999].';

export async function iniciarSimuladores() {
  const fixtures = JSON.parse(await readFile(path.join(RAIZ, 'test/fixtures/ncbi.json'), 'utf8'));
  const xmlChat = await readFile(path.join(RAIZ, 'test/fixtures/efetch-chat.xml'), 'utf8');
  const modo = { ncbi: 'ok', claude: 'ok', evidentia: 'ok' };
  const registro = { ncbi: [], claude: [], evidentia: [] };
  const runs = new Map();

  const json = (res, cuerpo, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(cuerpo));
  };

  const leerCuerpo = (req) =>
    new Promise((resolver) => {
      let datos = '';
      req.on('data', (c) => (datos += c));
      req.on('end', () => resolver(datos));
    });

  const servidor = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const ruta = url.pathname;

    if (ruta === '/__modo' && req.method === 'POST') {
      Object.assign(modo, JSON.parse((await leerCuerpo(req)) || '{}'));
      return json(res, modo);
    }
    if (ruta === '/__registro') return json(res, registro);

    // ---------------- NCBI
    if (ruta.startsWith('/entrez/eutils/')) {
      registro.ncbi.push({
        ruta,
        term: url.searchParams.get('term'),
        tool: url.searchParams.get('tool'),
        email: url.searchParams.get('email'),
        sort: url.searchParams.get('sort'),
        retmax: url.searchParams.get('retmax'),
        id: url.searchParams.get('id'),
      });
      if (modo.ncbi === 'caido') {
        res.writeHead(503);
        return res.end('caído');
      }
      if (modo.ncbi === 'html') {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end('<html>desafío</html>');
      }
      if (ruta.endsWith('esearch.fcgi')) {
        const r = fixtures.esearch[url.searchParams.get('term') ?? ''];
        if (!r) return json(res, { esearchresult: { ERROR: 'término no previsto' } });
        return json(res, {
          esearchresult: {
            count: String(r.count),
            idlist: r.ids,
            ...(r.phrasesnotfound ? { errorlist: { phrasesnotfound: r.phrasesnotfound, fieldsnotfound: [] } } : {}),
          },
        });
      }
      if (ruta.endsWith('esummary.fcgi')) {
        const ids = (url.searchParams.get('id') ?? '').split(',').filter(Boolean);
        const result = { uids: ids };
        for (const id of ids) {
          const d = fixtures.esummary[id];
          result[id] = {
            uid: id,
            title: d?.title ?? '',
            articleids: [{ idtype: 'pubmed', value: id }, ...(d?.doi ? [{ idtype: 'doi', value: d.doi }] : [])],
          };
        }
        return json(res, { result });
      }
      if (ruta.endsWith('efetch.fcgi')) {
        res.writeHead(200, { 'content-type': 'text/xml' });
        return res.end(xmlChat);
      }
    }

    // ---------------- Anthropic
    if (ruta === '/v1/messages' && req.method === 'POST') {
      const cuerpo = JSON.parse((await leerCuerpo(req)) || '{}');
      registro.claude.push({
        apiKey: req.headers['x-api-key'],
        workspace: req.headers['anthropic-workspace-id'] ?? null,
        model: cuerpo.model,
        stream: cuerpo.stream,
        tools: cuerpo.tools ?? null,
        system: cuerpo.system ?? null,
        prompt: cuerpo.messages?.[0]?.content,
      });
      if (modo.claude === 'error') return json(res, { type: 'error', error: { type: 'api_error', message: 'simulado' } }, 500);
      if (modo.claude === 'colgado') {
        // Nunca contesta. El cliente debe cortar a los 25 s.
        req.on('close', () => {});
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const ev = (tipo, datos) => res.write(`event: ${tipo}\ndata: ${JSON.stringify({ type: tipo, ...datos })}\n\n`);
      ev('message_start', {
        message: {
          id: 'msg_simulado',
          type: 'message',
          role: 'assistant',
          model: cuerpo.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 120, output_tokens: 1 },
        },
      });
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      const esChat = String(cuerpo.messages?.[0]?.content ?? '').includes('Resúmenes de PubMed');
      const trozos = (esChat ? TEXTO_CHAT_SIMULADO : TEXTO_CLAUDE_SIMULADO).match(/.{1,40}/g) ?? [];
      let k = 0;
      const enviar = () => {
        if (k < trozos.length) {
          ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: trozos[k++] } });
          setTimeout(enviar, 40);
          return;
        }
        ev('content_block_stop', { index: 0 });
        ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 90 } });
        ev('message_stop', {});
        res.end();
      };
      enviar();
      return;
    }

    // ---------------- Evidentia
    if (ruta === '/health') {
      if (modo.evidentia === 'caido') {
        res.writeHead(502);
        return res.end();
      }
      return json(res, { status: 'ok', service: 'evidentia-api' });
    }
    if (ruta === '/runs' && req.method === 'POST') {
      const cuerpo = JSON.parse((await leerCuerpo(req)) || '{}');
      registro.evidentia.push(cuerpo);
      if (modo.evidentia === 'caido') return json(res, { error: 'caído' }, 502);
      const runId = `sim${Date.now().toString(36)}`;
      runs.set(runId, { creado: Date.now() });
      return json(res, { runId, status: { status: 'queued' } }, 202);
    }
    const m = /^\/runs\/([^/]+)$/.exec(ruta);
    if (m && req.method === 'GET') {
      const run = runs.get(m[1]);
      if (!run) return json(res, { error: 'no existe' }, 404);
      // Termina a los 8 s de creado, como una versión acelerada del real.
      if (Date.now() - run.creado < 8000) return json(res, { runId: m[1], status: { status: 'running' } });
      return json(res, {
        runId: m[1],
        status: {
          status: 'complete',
          output: {
            runId: m[1],
            status: 'complete',
            mode: 'ask',
            humanReviewed: false,
            pico: { population: 'quemadura superficial', intervention: 'miel', comparator: 'sulfadiazina de plata', outcome: 'epitelización' },
            retrieval: { pubmed: 31, europepmc: 12 },
            dedupe: { unique: 38, duplicates: 5, fuzzyMerges: 1 },
            integrity: { checked: 20, unchecked: 18, retracted: 0, flagged: 1 },
            synthesis: { afirmaciones: [{ texto: 'x' }, { texto: 'y' }], escaladas: [{ texto: 'z' }] },
          },
        },
      });
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  const puerto = servidor.address().port;
  const base = `http://127.0.0.1:${puerto}`;
  return {
    base,
    async modo(cambios) {
      await fetch(`${base}/__modo`, { method: 'POST', body: JSON.stringify(cambios) });
    },
    async registro() {
      return (await fetch(`${base}/__registro`)).json();
    },
    cerrar: () => new Promise((r) => servidor.close(r)),
  };
}
