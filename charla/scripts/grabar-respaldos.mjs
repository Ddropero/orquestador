#!/usr/bin/env node
/**
 * Graba los respaldos durante el ensayo general, contra el Worker desplegado:
 *   - la respuesta de Claude al prompt fijo,
 *   - los resultados de PubMed para las cinco referencias,
 *   - el runId del último resultado completo de Evidentia.
 *
 * Uso:
 *   PRESENTER_TOKEN=... node scripts/grabar-respaldos.mjs https://charla.davidduque.com
 *
 * Escribe datos/respaldos.json. Después: npm run deploy (los respaldos van embebidos).
 * Nunca escribe un respaldo parcial: si Claude o PubMed fallan, conserva el anterior
 * de ese bloque y lo dice.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARCHIVO = path.join(RAIZ, 'datos/respaldos.json');

const base = (process.argv[2] ?? '').replace(/\/+$/, '');
const token = process.env.PRESENTER_TOKEN;
if (!base || !token) {
  console.error('Uso: PRESENTER_TOKEN=... node scripts/grabar-respaldos.mjs https://charla.davidduque.com');
  process.exit(2);
}

const cabeceras = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

async function ndjson(ruta) {
  const res = await fetch(`${base}${ruta}`, { method: 'POST', headers: cabeceras, body: '{}' });
  if (!res.ok) throw new Error(`${ruta}: HTTP ${res.status} ${await res.text()}`);
  const mensajes = [];
  let resto = '';
  for await (const trozo of res.body.pipeThrough(new TextDecoderStream())) {
    resto += trozo;
    const lineas = resto.split('\n');
    resto = lineas.pop();
    for (const l of lineas) if (l.trim()) mensajes.push(JSON.parse(l));
  }
  if (resto.trim()) mensajes.push(JSON.parse(resto));
  return mensajes;
}

function hoyBogota() {
  return new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
}

const anterior = JSON.parse(await readFile(ARCHIVO, 'utf8'));
const nuevo = { ...anterior };
const hoy = hoyBogota();
const problemas = [];

// ---- Claude
try {
  const m = await ndjson('/api/claude/resumen');
  const fin = m.find((x) => x.t === 'fin');
  if (!fin) throw new Error(`no terminó en vivo (${m.map((x) => x.t).join(', ')})`);
  const estado = await (await fetch(`${base}/api/presentador/estado`, { headers: cabeceras })).json();
  nuevo.claude = { texto: fin.texto, fecha: hoy, modelo: estado.configuracion?.modelo ?? 'claude' };
  console.log(`Claude: grabado (${fin.texto.length} caracteres).`);
} catch (e) {
  problemas.push(`Claude no se grabó: ${e.message}. Se conserva el respaldo anterior.`);
}

// ---- PubMed
try {
  const m = await ndjson('/api/pubmed/verificar');
  const fin = m.find((x) => x.t === 'fin');
  if (!fin || fin.ensayo) throw new Error('la verificación no fue en vivo de principio a fin');
  const porRef = new Map();
  for (const x of m) {
    if (x.t !== 'evento') continue;
    const e = x.evento;
    const r = porRef.get(e.ref) ?? { ref: e.ref, consultas: [], existe: false };
    if (e.tipo === 'pubmed_consulta') r.consultas.push({ via: e.via, resultados: e.resultados, coincide: e.coincide });
    if (e.tipo === 'pubmed_veredicto') {
      r.existe = e.existe;
      if (e.pmid) r.pmid = e.pmid;
    }
    porRef.set(e.ref, r);
  }
  const referencias = [...porRef.values()].sort((a, b) => a.ref - b.ref);
  if (referencias.length !== 5) throw new Error(`se grabaron ${referencias.length} referencias`);
  nuevo.pubmed = { fecha: hoy, origen: `Ensayo general del ${hoy} contra PubMed en vivo.`, referencias };
  console.log(`PubMed: grabado (${referencias.map((r) => `${r.ref}:${r.existe ? 'sí' : 'no'}`).join(' ')}).`);
} catch (e) {
  problemas.push(`PubMed no se grabó: ${e.message}. Se conserva el respaldo anterior.`);
}

// ---- Evidentia
try {
  const estado = await (await fetch(`${base}/api/presentador/estado`, { headers: cabeceras })).json();
  const ev = estado.evidentia;
  if (!ev || !ev.terminado || ev.resultado !== 'completo') {
    throw new Error('no hay un resultado completo de Evidentia; lance la pregunta desde /presentador y espere');
  }
  nuevo.evidentia = { runId: ev.runId, fecha: hoy };
  console.log(`Evidentia: grabado (${ev.runId}).`);
} catch (e) {
  problemas.push(`Evidentia no se grabó: ${e.message}. Se conserva el respaldo anterior.`);
}

await writeFile(ARCHIVO, JSON.stringify(nuevo, null, 2) + '\n');
console.log(`Escrito ${path.relative(RAIZ, ARCHIVO)}. Ahora: npm test && npm run deploy`);
for (const p of problemas) console.warn(`AVISO: ${p}`);
process.exit(problemas.length ? 1 : 0);
