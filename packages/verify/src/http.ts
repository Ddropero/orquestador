import { UnresolvedError, isTransientStatus, toUnresolved } from '@evidentia/core';

/**
 * Cliente HTTP cortés.
 *
 * "Cortés" no es una virtud: es un requisito operativo. NCBI exige `tool` y `email`
 * en cada petición y, sin ellos, limita a 3 peticiones/s y puede bloquear la IP.
 * Crossref hace lo propio con `mailto`, y a cambio da acceso al grupo de servidores
 * rápido. Una integración maleducada funciona en pruebas y se cae en producción.
 *
 * Además, un Worker solo puede tener 6 conexiones salientes simultáneas. Este
 * cliente SERIALIZA las peticiones por host en vez de dispararlas en paralelo: es
 * más lento y es la única forma de que no se caiga bajo carga.
 */

export interface PoliteConfig {
  /** Nombre de la herramienta que NCBI exige identificar. */
  tool: string;
  /** Correo de contacto. Obligatorio para NCBI y Crossref. */
  email: string;
  /** Sube el límite de NCBI de 3 a 10 peticiones/s. */
  ncbiApiKey?: string;
}

export interface RequestOptions {
  /** Milisegundos. Pasado el plazo, UNRESOLVED — nunca NOT_FOUND. */
  timeoutMs?: number;
  /** Reintentos ante fallo transitorio. */
  retries?: number;
  headers?: Record<string, string>;
}

export interface HttpResponse<T> {
  /** `undefined` cuando la fuente respondió 404 de forma inequívoca. */
  body?: T;
  status: number;
  /** La fuente respondió 404: el recurso no existe. Distinto de no haber podido preguntar. */
  notFound: boolean;
}

export interface HttpClient {
  /**
   * Devuelve `notFound: true` ante un 404, y LANZA `UnresolvedError` ante cualquier
   * otro fallo. Esa asimetría es deliberada: solo un 404 limpio autoriza a concluir
   * que algo no existe.
   */
  getJson<T>(url: string, options?: RequestOptions): Promise<HttpResponse<T>>;
  readonly config: PoliteConfig;
}

const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_RETRIES = 2;

/** Espaciado mínimo entre peticiones al mismo host, en milisegundos. */
const HOST_INTERVAL_MS: Record<string, number> = {
  'eutils.ncbi.nlm.nih.gov': 350, // 3/s sin clave; con clave se baja más abajo
  'api.crossref.org': 100,
  'www.ebi.ac.uk': 100,
};

export function createHttpClient(config: PoliteConfig): HttpClient {
  if (!config.email || config.email.includes('PENDIENTE')) {
    throw new Error(
      'CONTACT_EMAIL no está configurado. NCBI exige tool y email en cada petición: ' +
        'sin ellos limita a 3 peticiones/s y puede bloquear la IP del Worker.',
    );
  }

  /** Última petición por host, para serializar y espaciar. */
  const lastRequest = new Map<string, Promise<void>>();

  const userAgent = `${config.tool}/0.1 (mailto:${config.email})`;

  async function throttle(host: string): Promise<void> {
    const interval = config.ncbiApiKey && host.includes('ncbi')
      ? 110 // 10 peticiones/s con clave de API
      : (HOST_INTERVAL_MS[host] ?? 50);

    const previous = lastRequest.get(host) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    lastRequest.set(host, previous.then(() => current));

    await previous;
    setTimeout(release, interval);
  }

  async function getJson<T>(url: string, options: RequestOptions = {}): Promise<HttpResponse<T>> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const retries = options.retries ?? DEFAULT_RETRIES;
    const host = new URL(url).host;

    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt++) {
      await throttle(host);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(url, {
          signal: controller.signal,
          headers: {
            'User-Agent': userAgent,
            Accept: 'application/json',
            ...options.headers,
          },
        });

        // Un 404 es una afirmación de la fuente: el recurso no existe.
        if (response.status === 404) {
          return { status: 404, notFound: true };
        }

        // Todo lo demás que no sea 2xx es "no pude preguntar bien".
        if (!response.ok) {
          if (isTransientStatus(response.status) && attempt < retries) {
            lastError = new Error(`HTTP ${response.status}`);
            await backoff(attempt);
            continue;
          }
          throw new UnresolvedError(host, `HTTP ${response.status}`);
        }

        const body = (await response.json()) as T;
        return { body, status: response.status, notFound: false };
      } catch (error) {
        lastError = error;
        // Abortos, DNS, TLS, JSON malformado: transitorios por definición.
        if (attempt < retries) {
          await backoff(attempt);
          continue;
        }
      } finally {
        clearTimeout(timer);
      }
    }

    throw toUnresolved(host, lastError);
  }

  return { getJson, config };
}

function backoff(attempt: number): Promise<void> {
  const ms = Math.min(2000, 250 * 2 ** attempt);
  return new Promise((resolve) => setTimeout(resolve, ms));
}
