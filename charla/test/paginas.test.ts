/**
 * Comprueba lo que produce `npm run construir` (se ejecuta antes de las pruebas).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { CSP_PRESENTADOR } from '../src/generado/csp.js';

const RAIZ = join(__dirname, '..');
const leer = (p: string) => readFileSync(join(RAIZ, p), 'utf8');
const BASE = leer('base/charla-ia-investigacion.html');
const PRESENTADOR = leer('public/_privado/presentador.html');
const VIVO_HTML = leer('public/vivo.html');
const VIVO_JS = leer('public/vivo.js');

function secciones(html: string): string[] {
  return html.split(/<section class="slide/).slice(1).map((s) => s.split('</section>')[0]!);
}

function notaDe(seccion: string): string {
  return /data-notes="([^"]*)"/.exec(seccion)?.[1] ?? '';
}

function sinNota(seccion: string): string {
  return seccion.replace(/ data-notes="[^"]*"/, '');
}

function datosEmbebidos(html: string, id: string): any {
  const m = new RegExp(`<script type="application/json" id="${id}">([\\s\\S]*?)</script>`).exec(html);
  if (!m) throw new Error(`sin datos ${id}`);
  return JSON.parse(m[1]!);
}

describe('/presentador: la presentación portada sin cambios visuales', () => {
  it('conserva las 18 diapositivas idénticas, salvo el QR (1 y 18), el contacto (18) y los enganches del respaldo (3)', () => {
    const b = secciones(BASE);
    const p = secciones(PRESENTADOR);
    expect(p).toHaveLength(18);
    p.forEach((s, i) => {
      if (i === 0 || i === 17 || i === 2) return;
      expect(sinNota(s)).toBe(sinNota(b[i]!));
    });
    expect(p[0]).toContain('qr-portada');
    expect(p[17]).toContain('qr-cierre');
    expect(p[17]).not.toContain('[Código QR del kit]');
    expect(p[17]).not.toContain('[su correo o red social]');
    // En la 3, lo único nuevo son dos botones ocultos y un id.
    const sin3 = sinNota(p[2]!)
      .replace(/\s*<button id="btn-respaldo-claude"[^>]*>[^<]*<\/button>/, '')
      .replace(/\s*<button id="btn-respaldo-pubmed"[^>]*>[^<]*<\/button>/, '')
      .replace(' id="sample-label"', '');
    expect(sin3).toBe(sinNota(b[2]!));
  });

  it('las notas del orador conservan el texto original y solo añaden al final en la 1, la 3 y la 10', () => {
    const b = secciones(BASE);
    const p = secciones(PRESENTADOR);
    p.forEach((s, i) => {
      const original = notaDe(b[i]!);
      const nueva = notaDe(s);
      expect(nueva.startsWith(original)).toBe(true);
      if ([0, 2, 9].includes(i)) expect(nueva.length).toBeGreaterThan(original.length);
      else expect(nueva).toBe(original);
    });
    expect(notaDe(p[9]!)).toContain('PDF del ensayo');
  });

  it('conserva el CSS de la base completo', () => {
    const css = /<style>\n  :root\{[\s\S]*?<\/style>/.exec(BASE)![0];
    expect(PRESENTADOR).toContain(css);
  });

  it('no depende de window.claude ni de CDN', () => {
    expect(PRESENTADOR).not.toContain('window.claude');
    expect(PRESENTADOR).not.toMatch(/fonts\.googleapis|fonts\.gstatic|cdn\.|unpkg|jsdelivr/);
    expect(PRESENTADOR).toContain("font-family:'IBM Plex Sans'");
    expect(PRESENTADOR).toContain("font-family:'Source Serif 4'");
  });

  it('no lleva ninguna clave ni secreto', () => {
    expect(PRESENTADOR).not.toMatch(/sk-ant-|ANTHROPIC_API_KEY|PRESENTER_TOKEN|api_key/);
    expect(VIVO_HTML + VIVO_JS).not.toMatch(/sk-ant-|ANTHROPIC|PRESENTER_TOKEN|api_key/);
  });

  it('el CSP autoriza exactamente el script en línea que lleva la página', () => {
    const scripts = [...PRESENTADOR.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    expect(scripts).toHaveLength(1);
    const hash = createHash('sha256').update(scripts[0]!, 'utf8').digest('base64');
    expect(CSP_PRESENTADOR).toContain(`'sha256-${hash}'`);
    expect(CSP_PRESENTADOR).not.toContain("script-src 'unsafe-inline'");
    expect(CSP_PRESENTADOR).toContain("frame-ancestors 'none'");
  });

  it('el QR apunta a /vivo en la portada y en el cierre', () => {
    expect((PRESENTADOR.match(/class="qr"/g) ?? []).length).toBe(2);
    expect(PRESENTADOR).toMatch(/<b>[^<]*\/vivo<\/b>/);
  });

  it('trae embebidos los respaldos con su fecha', () => {
    const d = datosEmbebidos(PRESENTADOR, 'datos-presentador');
    expect(d.respaldos.pubmed.fecha).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(d.referencias).toHaveLength(5);
  });
});

describe('/vivo: la página del público', () => {
  it('nunca usa innerHTML ni nada que interprete HTML', () => {
    expect(VIVO_JS).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
  });

  it('no tiene scripts ni estilos en línea (CSP estricto)', () => {
    const scripts = [...VIVO_HTML.matchAll(/<script(?![^>]*type="application\/json")(?![^>]*src=)[^>]*>/g)];
    expect(scripts).toHaveLength(0);
    expect(VIVO_HTML).not.toMatch(/\sstyle=/);
    expect(VIVO_HTML).not.toMatch(/\son[a-z]+=/);
  });

  it('lleva la etiqueta de ejercicio docente', () => {
    expect(VIVO_HTML).toContain('Ejercicio docente: referencias fabricadas a propósito');
    expect(VIVO_JS).toContain('Ejercicio docente: referencia fabricada a propósito. No la cite.');
  });

  it('las referencias fabricadas no viajan con su cita completa ni con su DOI', () => {
    const d = datosEmbebidos(VIVO_HTML, 'datos-vivo');
    for (const r of d.referencias) {
      if (r.fabricada) {
        expect(Object.keys(r).sort()).toEqual(['corta', 'fabricada', 'n']);
      } else {
        expect(r.cita).toBeTruthy();
      }
    }
    const texto = JSON.stringify(d);
    for (const doi of ['10.1093/cid/ciad1893', '10.1016/j.jinf.2021.06.041', '10.1016/S1473-3099(22)00614-5']) {
      expect(texto).not.toContain(doi);
    }
    expect(texto).not.toContain('Early oseltamivir and time to return to work');
  });

  it('no muestra prompts ni instrucciones internas', () => {
    expect(VIVO_HTML + VIVO_JS).not.toContain('Resuma en cuatro o cinco líneas');
  });

  it('pide no ser indexada', () => {
    expect(VIVO_HTML).toContain('noindex');
    expect(leer('public/robots.txt')).toContain('Disallow: /');
  });
});
