/**
 * La sala: un único Durable Object que difunde lo que hace el presentador.
 *
 * - El público se conecta por WebSocket con la API de hibernación: mientras nadie
 *   emite, el objeto duerme y las conexiones no cuestan. El `ping` de los clientes
 *   lo contesta el runtime sin despertarlo.
 * - El WebSocket es de solo lectura: cualquier mensaje del público que no sea el
 *   `ping` cierra esa conexión.
 * - Las demos (Claude, PubMed, Evidentia) corren AQUÍ y no en el Worker, para que
 *   el candado de "una a la vez", el cupo diario y la difusión vivan en un solo
 *   lugar con estado consistente.
 *
 * El Worker solo llega a este objeto por rutas internas y después de comprobar
 * quién llama. Nada de lo de aquí es alcanzable directamente desde fuera.
 */
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env.js';
import { sanear, compactar, type Evento } from './eventos.js';
import {
  REFERENCIAS,
  DIAPOSITIVAS,
  CONFIG,
  PREGUNTA_EVIDENTIA,
  promptResumen,
  hoyBogota,
  type VerificacionRegistrada,
} from './contenido.js';
import { crearClienteNcbi, verificarReferencia } from './pubmed.js';
import { generarResumen, describirError } from './claude.js';
import * as evidentia from './evidentia.js';
import { cargarRespaldos } from './respaldos.js';

const MAX_CONEXIONES = 2000;
const PLAZO_CLAUDE_MS = 25_000;
const INTERVALO_TEXTO_MS = 250;
const SONDEO_EVIDENTIA_MS = 5_000;
const PLAZO_EVIDENTIA_MS = 15 * 60_000;
const ETIQUETA_PUBLICO = 'publico';

interface EstadoEvidentia {
  runId: string;
  inicio: number;
  ultimo: string;
  fallos: number;
  terminado: boolean;
  resultado?: 'completo' | 'fallido' | 'sin terminar';
}

interface Costo {
  ts: number;
  modelo: string;
  entrada: number;
  salida: number;
  usd: number;
}

type Enviar = (mensaje: Record<string, unknown>) => void;

function json(cuerpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** Flujo NDJSON hacia el presentador. Si el presentador se desconecta, la demo sigue para /vivo. */
function flujoNdjson(): { respuesta: Response; enviar: Enviar; cerrar: () => void } {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const escritor = writable.getWriter();
  const codificador = new TextEncoder();
  let abierto = true;
  return {
    respuesta: new Response(readable, {
      headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' },
    }),
    enviar: (m) => {
      if (!abierto) return;
      escritor.write(codificador.encode(JSON.stringify(m) + '\n')).catch(() => {
        abierto = false;
      });
    },
    cerrar: () => {
      abierto = false;
      escritor.close().catch(() => {});
    },
  };
}

export class Sala extends DurableObject<Env> {
  private historial: Evento[] = [];
  private seq = 0;
  private claude: AbortController | null = null;
  private verificacion: AbortController | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    void this.ctx.blockConcurrencyWhile(async () => {
      this.historial = (await this.ctx.storage.get<Evento[]>('historial')) ?? [];
      this.seq = (await this.ctx.storage.get<number>('seq')) ?? 0;
    });
  }

  override async fetch(request: Request): Promise<Response> {
    const ruta = new URL(request.url).pathname;
    const metodo = request.method;

    if (ruta === '/ws' && metodo === 'GET') return this.conectar(request);
    if (ruta === '/estado' && metodo === 'GET') return json({ eventos: this.historial });

    if (metodo === 'POST') {
      switch (ruta) {
        case '/diapositiva':
          return this.diapositiva(await leerJson(request));
        case '/aviso':
          return this.aviso(await leerJson(request));
        case '/reiniciar':
          return this.reiniciar();
        case '/respaldo':
          return this.pedirRespaldo(await leerJson(request));
        case '/claude/resumen':
          return this.resumen();
        case '/pubmed/verificar':
          return this.verificar();
        case '/evidentia/lanzar':
          return this.lanzarEvidentia();
      }
    }

    if (metodo === 'GET') {
      switch (ruta) {
        case '/presentador/estado':
          return this.estadoPresentador();
        case '/presentador/respaldos':
          return json({
            claude: (await this.ctx.storage.get('ultimo_resumen')) ?? null,
            pubmed: (await this.ctx.storage.get('ultima_verificacion')) ?? null,
            evidentia: (await this.ctx.storage.get('ultimo_evidentia')) ?? null,
          });
        case '/presentador/costos':
          return json({ costos: (await this.ctx.storage.get<Costo[]>('costos')) ?? [] });
      }
    }

    return json({ error: 'no_encontrado' }, 404);
  }

  // ---------------------------------------------------------------- difusión

  /**
   * Sanea, guarda y difunde. `sanear` es la última puerta: un evento con campos
   * de más o con valores fuera de lo previsto no sale.
   */
  private async emitir(nuevo: Record<string, unknown>): Promise<Evento | null> {
    const evento = sanear(nuevo, Date.now(), this.seq + 1);
    if (!evento) {
      console.warn(JSON.stringify({ evento: 'evento_descartado', tipo: String(nuevo['tipo']) }));
      return null;
    }
    this.seq = evento.seq;
    this.historial = compactar(this.historial, evento);
    await this.ctx.storage.put({ historial: this.historial, seq: this.seq });
    const datos = JSON.stringify(evento);
    for (const ws of this.ctx.getWebSockets(ETIQUETA_PUBLICO)) {
      try {
        ws.send(datos);
      } catch {
        // Conexión muerta: el runtime la limpia al cerrarse.
      }
    }
    return evento;
  }

  private conectar(request: Request): Response {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Se esperaba una conexión WebSocket.', { status: 426 });
    }
    if (this.ctx.getWebSockets().length >= MAX_CONEXIONES) {
      // El cliente cae al sondeo cada 5 s, que no necesita conexión abierta.
      return new Response('La sala está llena.', { status: 503 });
    }
    const par = new WebSocketPair();
    const [cliente, servidor] = Object.values(par) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(servidor, [ETIQUETA_PUBLICO]);
    // Quien llega tarde recibe lo que ya pasó, evento por evento, en el mismo formato.
    for (const e of this.historial) servidor.send(JSON.stringify(e));
    return new Response(null, { status: 101, webSocket: cliente });
  }

  override async webSocketMessage(ws: WebSocket): Promise<void> {
    // Solo lectura. El `ping` lo contesta el runtime sin llegar aquí; cualquier otra
    // cosa es un cliente que no es /vivo.
    try {
      ws.close(1008, 'Esta conexión es de solo lectura.');
    } catch {
      // Ya cerrada.
    }
  }

  override async webSocketClose(ws: WebSocket, codigo: number, razon: string): Promise<void> {
    try {
      ws.close(codigo, razon);
    } catch {
      // Códigos reservados (1005, 1006) o ya cerrada: nada que hacer.
    }
  }

  override async webSocketError(): Promise<void> {
    // El runtime cierra la conexión; el cliente se reconecta solo.
  }

  // ------------------------------------------------------ controles del presentador

  private async diapositiva(cuerpo: Record<string, unknown>): Promise<Response> {
    const n = cuerpo['n'];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > DIAPOSITIVAS.length) {
      return json({ error: 'diapositiva_invalida' }, 400);
    }
    const ultima = [...this.historial].reverse().find((e) => e.tipo === 'diapositiva');
    if (ultima?.tipo === 'diapositiva' && ultima.n === n) return json({ ok: true, repetida: true });
    await this.emitir({ tipo: 'diapositiva', n, titulo: DIAPOSITIVAS[n - 1] });
    return json({ ok: true });
  }

  private async aviso(cuerpo: Record<string, unknown>): Promise<Response> {
    const evento = await this.emitir({ tipo: 'aviso', texto: cuerpo['texto'] });
    return evento ? json({ ok: true }) : json({ error: 'aviso_vacio' }, 400);
  }

  /**
   * Para empezar la charla limpia después del ensayo. Conserva costos, respaldos
   * grabados y la corrida de Evidentia en curso: el ponente la lanza antes de subir
   * y limpia la sala después; olvidarla lo dejaría sin enlace en la diapositiva 10.
   */
  private async reiniciar(): Promise<Response> {
    this.claude?.abort('reinicio');
    this.verificacion?.abort('reinicio');
    this.historial = [];
    await this.ctx.storage.put({ historial: [], seq: this.seq });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        // Al reconectar, cada /vivo reconstruye su estado desde el historial vacío.
        ws.close(4000, 'La sala se reinició.');
      } catch {
        // Ya cerrada.
      }
    }
    return json({ ok: true });
  }

  /** El presentador no quiere esperar más: se corta lo que esté en curso y se usa el respaldo. */
  private async pedirRespaldo(cuerpo: Record<string, unknown>): Promise<Response> {
    const tipo = cuerpo['tipo'];
    if (tipo === 'claude') {
      if (this.claude) this.claude.abort('respaldo');
      else {
        await this.emitir({ tipo: 'demo_inicio', tema: 'resumen' });
        await this.difundirRespaldoResumen();
      }
      return json({ ok: true });
    }
    if (tipo === 'pubmed') {
      if (this.verificacion) this.verificacion.abort('respaldo');
      else {
        await this.emitir({ tipo: 'demo_inicio', tema: 'verificacion' });
        await this.difundirRespaldoPubmed(REFERENCIAS.map((r) => r.n));
      }
      return json({ ok: true });
    }
    return json({ error: 'tipo_invalido' }, 400);
  }

  private async estadoPresentador(): Promise<Response> {
    const hoy = hoyBogota();
    const costos = (await this.ctx.storage.get<Costo[]>('costos')) ?? [];
    const ev = await this.ctx.storage.get<EstadoEvidentia>('evidentia');
    const base = this.env.EVIDENTIA_URL ?? CONFIG.evidentiaUrl;
    return json({
      conexiones: this.ctx.getWebSockets(ETIQUETA_PUBLICO).length,
      claudeHoy: (await this.ctx.storage.get<number>(`claude:${hoy}`)) ?? 0,
      limiteClaudeDiario: CONFIG.limiteClaudeDiario,
      costos: {
        llamadas: costos.length,
        usd: Math.round(costos.reduce((s, c) => s + c.usd, 0) * 10_000) / 10_000,
      },
      evidentia: ev
        ? {
            runId: ev.runId,
            estado: ev.ultimo,
            terminado: ev.terminado,
            resultado: ev.resultado ?? null,
            enlace: evidentia.enlaceRun(base, ev.runId),
          }
        : null,
      enCurso: { claude: Boolean(this.claude), verificacion: Boolean(this.verificacion) },
    });
  }

  // ------------------------------------------------------------ demo 1: Claude

  private resumen(): Response {
    if (this.claude) return json({ error: 'en_curso', mensaje: 'Ya hay una consulta a Claude en curso.' }, 409);
    const control = new AbortController();
    this.claude = control;
    const { respuesta, enviar, cerrar } = flujoNdjson();
    const tarea = this.ejecutarResumen(control, enviar).finally(() => {
      if (this.claude === control) this.claude = null;
      cerrar();
    });
    this.ctx.waitUntil(tarea);
    return respuesta;
  }

  private async ejecutarResumen(control: AbortController, enviar: Enviar): Promise<void> {
    await this.emitir({ tipo: 'demo_inicio', tema: 'resumen' });

    const hoy = hoyBogota();
    const clave = `claude:${hoy}`;
    const usados = (await this.ctx.storage.get<number>(clave)) ?? 0;
    if (usados >= CONFIG.limiteClaudeDiario) {
      return this.respaldoResumen(enviar, 'Se alcanzó el cupo diario de consultas a Claude.');
    }
    if (!this.env.ANTHROPIC_API_KEY) {
      return this.respaldoResumen(enviar, 'El servidor no tiene configurada la clave de Anthropic.');
    }
    await this.ctx.storage.put(clave, usados + 1);

    const plazo = setTimeout(() => control.abort('plazo'), PLAZO_CLAUDE_MS);
    let ultimoEnvio = 0;
    const inicio = Date.now();
    try {
      const r = await generarResumen({
        apiKey: this.env.ANTHROPIC_API_KEY,
        ...(this.env.ANTHROPIC_BASE_URL ? { baseURL: this.env.ANTHROPIC_BASE_URL } : {}),
        modelo: CONFIG.modelo,
        prompt: promptResumen(),
        signal: control.signal,
        precio: CONFIG.precioUsdPorMillon,
        alTexto: (acumulado) => {
          enviar({ t: 'texto', texto: acumulado });
          const ahora = Date.now();
          if (ahora - ultimoEnvio >= INTERVALO_TEXTO_MS) {
            ultimoEnvio = ahora;
            void this.emitir({ tipo: 'claude_texto', texto_parcial: acumulado });
          }
        },
      });
      if (control.signal.aborted) throw new Error(String(control.signal.reason));

      await this.emitir({ tipo: 'claude_texto', texto_parcial: r.texto });
      const costo: Costo = { ts: Date.now(), modelo: r.modelo, entrada: r.entrada, salida: r.salida, usd: r.usd };
      const costos = (await this.ctx.storage.get<Costo[]>('costos')) ?? [];
      await this.ctx.storage.put({
        costos: [...costos, costo].slice(-500),
        ultimo_resumen: { texto: r.texto, fecha: hoy, modelo: r.modelo },
      });
      console.log(JSON.stringify({ evento: 'costo_claude', ...costo, ms: Date.now() - inicio }));
      enviar({ t: 'fin', texto: r.texto });
    } catch (error) {
      const razon = control.signal.aborted ? control.signal.reason : null;
      if (razon === 'reinicio') return;
      const motivo =
        razon === 'respaldo'
          ? 'El presentador pidió la respuesta de ensayo.'
          : razon === 'plazo'
            ? 'Claude tardó más de 25 segundos.'
            : `Claude no respondió: ${describirError(error)}.`;
      console.error(JSON.stringify({ evento: 'claude_fallo', motivo: describirError(error), razon, ms: Date.now() - inicio }));
      await this.respaldoResumen(enviar, motivo);
    } finally {
      clearTimeout(plazo);
    }
  }

  private async respaldoResumen(enviar: Enviar, motivo: string): Promise<void> {
    const r = (await cargarRespaldos(this.env)).claude;
    if (!r) {
      enviar({ t: 'error', mensaje: `${motivo} No hay respuesta de ensayo grabada.` });
      return;
    }
    await this.difundirRespaldoResumen();
    enviar({ t: 'respaldo', texto: r.texto, fecha: r.fecha, motivo });
  }

  private async difundirRespaldoResumen(): Promise<void> {
    const r = (await cargarRespaldos(this.env)).claude;
    if (r) await this.emitir({ tipo: 'claude_texto', texto_parcial: r.texto, ensayo: true });
  }

  // ------------------------------------------------------------ demo 1: PubMed

  private verificar(): Response {
    if (this.verificacion) return json({ error: 'en_curso', mensaje: 'Ya hay una verificación en curso.' }, 409);
    const control = new AbortController();
    this.verificacion = control;
    const { respuesta, enviar, cerrar } = flujoNdjson();
    const tarea = this.ejecutarVerificacion(control, enviar).finally(() => {
      if (this.verificacion === control) this.verificacion = null;
      cerrar();
    });
    this.ctx.waitUntil(tarea);
    return respuesta;
  }

  private async ejecutarVerificacion(control: AbortController, enviar: Enviar): Promise<void> {
    const emitirYEnviar = async (e: Record<string, unknown>) => {
      const publicado = await this.emitir(e);
      if (publicado) enviar({ t: 'evento', evento: publicado });
    };

    await this.emitir({ tipo: 'demo_inicio', tema: 'verificacion' });

    const cliente = crearClienteNcbi({
      ...(this.env.NCBI_BASE_URL ? { base: this.env.NCBI_BASE_URL } : {}),
      tool: this.env.NCBI_TOOL,
      email: this.env.CONTACT_EMAIL,
      ...(this.env.NCBI_API_KEY ? { apiKey: this.env.NCBI_API_KEY } : {}),
      signal: control.signal,
    });

    const enVivo: VerificacionRegistrada[] = [];
    const pendientes: number[] = [];
    let caido = false;

    for (const ref of REFERENCIAS) {
      if (caido) {
        pendientes.push(ref.n);
        continue;
      }
      try {
        const v = await verificarReferencia(ref, cliente, (c) =>
          emitirYEnviar({ tipo: 'pubmed_consulta', ref: ref.n, via: c.via, resultados: c.resultados, coincide: c.coincide }),
        );
        await emitirYEnviar({
          tipo: 'pubmed_veredicto',
          ref: ref.n,
          existe: v.existe,
          ...(v.pmid ? { pmid: v.pmid } : {}),
        });
        enVivo.push(v);
      } catch (error) {
        const razon = control.signal.aborted ? control.signal.reason : null;
        if (razon === 'reinicio') return;
        caido = true;
        pendientes.push(ref.n);
        const motivo =
          razon === 'respaldo'
            ? 'El presentador pidió los resultados del ensayo.'
            : `PubMed no respondió (${error instanceof Error ? error.message : 'error'}).`;
        console.error(JSON.stringify({ evento: 'pubmed_fallo', ref: ref.n, motivo }));
        enviar({ t: 'aviso', mensaje: motivo });
      }
    }

    const respaldos = await cargarRespaldos(this.env);
    if (pendientes.length > 0) {
      const faltantes = await this.difundirRespaldoPubmed(pendientes, (e) => enviar({ t: 'evento', evento: e }));
      for (const n of faltantes) enviar({ t: 'sin_respaldo', ref: n });
    } else {
      await this.ctx.storage.put('ultima_verificacion', { fecha: hoyBogota(), referencias: enVivo });
    }
    enviar({
      t: 'fin',
      ensayo: pendientes.length > 0,
      ...(pendientes.length > 0 && respaldos.pubmed ? { fecha: respaldos.pubmed.fecha } : {}),
    });
  }

  /** Difunde el resultado del ensayo para esas referencias. Devuelve las que no tienen respaldo. */
  private async difundirRespaldoPubmed(refs: number[], alPublicar?: (e: Evento) => void): Promise<number[]> {
    const sinRespaldo: number[] = [];
    const respaldos = await cargarRespaldos(this.env);
    for (const n of refs) {
      const r = respaldos.pubmed?.referencias.find((x) => x.ref === n);
      if (!r) {
        sinRespaldo.push(n);
        continue;
      }
      for (const c of r.consultas) {
        const e = await this.emitir({ tipo: 'pubmed_consulta', ref: n, via: c.via, resultados: c.resultados, coincide: c.coincide, ensayo: true });
        if (e && alPublicar) alPublicar(e);
      }
      const v = await this.emitir({
        tipo: 'pubmed_veredicto',
        ref: n,
        existe: r.existe,
        ...(r.pmid ? { pmid: r.pmid } : {}),
        ensayo: true,
      });
      if (v && alPublicar) alPublicar(v);
    }
    return sinRespaldo;
  }

  // ---------------------------------------------------------- demo 2: Evidentia

  private async lanzarEvidentia(): Promise<Response> {
    const base = this.env.EVIDENTIA_URL ?? CONFIG.evidentiaUrl;
    const actual = await this.ctx.storage.get<EstadoEvidentia>('evidentia');
    if (actual && !actual.terminado && Date.now() - actual.inicio < PLAZO_EVIDENTIA_MS) {
      return json(
        { error: 'en_curso', mensaje: 'Evidentia ya está trabajando en la pregunta.', runId: actual.runId, enlace: evidentia.enlaceRun(base, actual.runId) },
        409,
      );
    }

    await this.emitir({ tipo: 'demo_inicio', tema: 'evidentia' });
    try {
      const { runId, estado } = await evidentia.lanzar(base, PREGUNTA_EVIDENTIA);
      const est: EstadoEvidentia = { runId, inicio: Date.now(), ultimo: estado, fallos: 0, terminado: false };
      await this.ctx.storage.put('evidentia', est);
      await this.emitir({ tipo: 'evidentia_etapa', etapa: evidentia.ETAPA_ENVIO, estado: 'completada' });
      await this.emitir({ tipo: 'evidentia_etapa', etapa: evidentia.ETAPA_TRABAJO, estado: 'en curso' });
      await this.ctx.storage.setAlarm(Date.now() + SONDEO_EVIDENTIA_MS);
      console.log(JSON.stringify({ evento: 'evidentia_lanzada', runId }));
      return json({ runId, enlace: evidentia.enlaceRun(base, runId) });
    } catch (error) {
      const motivo = error instanceof Error ? error.message : 'error';
      console.error(JSON.stringify({ evento: 'evidentia_fallo_lanzar', motivo }));
      await this.emitir({
        tipo: 'evidentia_etapa',
        etapa: evidentia.ETAPA_ENVIO,
        estado: 'falló',
        detalle: 'Se mostrará el resultado del ensayo.',
      });
      return json({ error: 'evidentia_no_disponible', mensaje: motivo }, 502);
    }
  }

  /** Sondeo de Evidentia cada 5 s. Con alarmas, no depende de que el presentador siga conectado. */
  override async alarm(): Promise<void> {
    const est = await this.ctx.storage.get<EstadoEvidentia>('evidentia');
    if (!est || est.terminado) return;
    const base = this.env.EVIDENTIA_URL ?? CONFIG.evidentiaUrl;

    if (Date.now() - est.inicio > PLAZO_EVIDENTIA_MS) {
      est.terminado = true;
      est.resultado = 'sin terminar';
      await this.ctx.storage.put('evidentia', est);
      await this.emitir({
        tipo: 'evidentia_etapa',
        etapa: evidentia.ETAPA_TRABAJO,
        estado: 'sin terminar',
        detalle: 'Se mostrará el resultado del ensayo.',
      });
      return;
    }

    try {
      const r = await evidentia.consultar(base, est.runId);
      est.fallos = 0;
      est.ultimo = r.estado;
      if (r.estado === 'complete') {
        est.terminado = true;
        est.resultado = 'completo';
        await this.ctx.storage.put({ evidentia: est, ultimo_evidentia: { runId: est.runId, fecha: hoyBogota() } });
        await this.emitir({ tipo: 'evidentia_etapa', etapa: evidentia.ETAPA_TRABAJO, estado: 'completada' });
        for (const e of evidentia.etapasDelResultado(r.output)) await this.emitir({ tipo: 'evidentia_etapa', ...e });
        return;
      }
      if ((evidentia.TERMINALES_FALLIDOS as readonly string[]).includes(r.estado)) {
        est.terminado = true;
        est.resultado = 'fallido';
        await this.ctx.storage.put('evidentia', est);
        await this.emitir({
          tipo: 'evidentia_etapa',
          etapa: evidentia.ETAPA_TRABAJO,
          estado: 'falló',
          detalle: 'Se mostrará el resultado del ensayo.',
        });
        return;
      }
    } catch (error) {
      est.fallos += 1;
      console.warn(JSON.stringify({ evento: 'evidentia_sondeo_fallo', fallos: est.fallos, motivo: error instanceof Error ? error.message : 'error' }));
    }
    await this.ctx.storage.put('evidentia', est);
    await this.ctx.storage.setAlarm(Date.now() + SONDEO_EVIDENTIA_MS);
  }
}

async function leerJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const v = await request.json();
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
