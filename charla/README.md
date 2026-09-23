# Charla «Del caso clínico al PubMed» — versión web en vivo

IV Simposio de Actualización en Cirugía Plástica · 2 de octubre de 2026 · 20 minutos.
Mensaje central: **la IA propone, usted verifica.**

Un solo Worker de Cloudflare sirve tres cosas:

| Ruta | Quién | Qué |
|---|---|---|
| `/presentador` | El ponente, con token | Las 18 diapositivas, los botones de la demo y un panel de controles. |
| `/vivo` | El público, desde el QR | Solo lectura: la diapositiva actual, lo que hace la IA paso a paso y el kit para llevar. |
| `/api/...` | Ver `src/index.ts` | Las demos (Claude, PubMed, Evidentia) y la sala. Todo lo que cuesta dinero exige el token. |

## Reglas que el código hace cumplir

1. **Todo en español y de usted.** Una prueba (`test/contenido.test.ts`) busca tuteo en cada texto visible y falla si lo encuentra.
2. **Ninguna clave en el cliente.** `ANTHROPIC_API_KEY`, `PRESENTER_TOKEN` y `NCBI_API_KEY` son secretos del Worker. Las páginas construidas se comprueban contra patrones de clave.
3. **El público no puede llamar a Claude.** Solo `POST /api/claude/resumen` llama a la API, solo con sesión del presentador, y solo con el prompt fijo de `datos/contenido.json`. El WebSocket público cierra la conexión a quien le escriba.
4. **Las referencias inventadas nunca van sueltas.** En `/vivo` una referencia solo aparece cuando PubMed dio su veredicto, y las fabricadas van en forma corta (sin su DOI inventado) con la etiqueta «Ejercicio docente: referencias fabricadas a propósito».
5. **Cero datos de pacientes.** La demo usa referencias bibliográficas; Evidentia recibe una pregunta PICO, no un caso.
6. **Cada componente en vivo tiene respaldo sin red** (ver abajo).
7. **No se inventan referencias nuevas.** Las cinco son exactamente las de `base/charla-ia-investigacion.html`; una prueba lo comprueba texto por texto.

## Cómo funciona una demo

```
/presentador ──POST /api/claude/resumen──▶ Worker ──▶ Durable Object «Sala» ──▶ API de Anthropic
     ▲                (flujo NDJSON)                        │
     │                                                      │ eventos {tipo, ts, seq, ...}
     └── el mismo texto que ve el ponente                   ▼
                                                  WebSocket ──▶ /vivo (cientos de celulares)
                                                  (si falla, /vivo sondea GET /api/sala/estado cada 5 s)
```

La Sala es un único Durable Object con la API de hibernación: guarda el historial, sanea cada evento (`src/eventos.ts` descarta todo campo que no esté en el contrato) y lo difunde. Las demos corren dentro de la Sala, así el candado de «una a la vez», el cupo diario de Claude y la difusión viven en un solo sitio.

### Respaldos

| Componente | Si falla o tarda | Etiqueta que se ve |
|---|---|---|
| Claude | Error, o más de 25 s | «Respuesta de ensayo · grabada el <fecha>» |
| PubMed | Error, o 15 s sin señal | «Resultado del ensayo del <fecha>» |
| Evidentia | No lanza o no termina | Enlace al resultado del ensayo en el panel del presentador. **Es un enlace a internet**: sin red no abre, así que en el ensayo se guarda ese resultado como PDF en el escritorio (paso 5) |
| Diapositivas | Sin red | La pestaña sigue (fuentes embebidas, sin CDN); un service worker guarda la última copia; y `/presentador/descargar` da un archivo que abre desde el disco con los respaldos dentro |

Los respaldos viven en `datos/respaldos.json` y se **embeben** en la construcción: el Worker y la página del presentador leen exactamente los mismos. `npm run deploy` se niega a desplegar mientras falte alguno; antes del ensayo general se despliega a sabiendas con `CHARLA_SIN_RESPALDOS=1 npm run deploy`.

## Puesta en marcha

```bash
cd charla
npm ci
npm test            # construye y corre las pruebas unitarias
npm run e2e         # wrangler dev + simuladores de NCBI, Anthropic y Evidentia + Chromium

npx wrangler login
npx wrangler secret put PRESENTER_TOKEN     # 24 caracteres o más; con menos, nadie entra
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put NCBI_API_KEY        # opcional: 10 peticiones/s en vez de 3
CHARLA_SIN_RESPALDOS=1 npm run deploy       # el primer despliegue, antes de grabar los respaldos
node scripts/preflight.mjs https://charla.davidduque.com
```

`datos/config.json` lleva la URL pública (la del QR), la URL de Evidentia, el modelo, el precio por millón de tokens con el que se estima el costo de cada llamada (el real está en la consola de Anthropic) y el contacto que se proyecta en la última diapositiva. `datos/contenido.json` lleva, además de las referencias, los siete prompts del kit (uno por paso, sacados de lo que dice cada diapositiva): revíselos antes de congelar.

Si el DNS de `davidduque.com` no está en Cloudflare, quite la entrada `routes` de `wrangler.jsonc`, ponga la URL `*.workers.dev` en `config.json` y vuelva a desplegar: el QR se genera en la construcción.

### Entrar como presentador

Abra `/presentador` y escriba el token; queda una cookie de sesión (HttpOnly, `__Host-`, tres días) que se renueva cada vez que abre `/presentador`: abrirla el día de la charla da tres días frescos. Para no escribirlo en tarima, guarde en el navegador del portátil el enlace `/presentador#t=<token>`: el fragmento nunca sale del navegador y se borra al usarse.

## Ensayo general (29–30 de septiembre)

En el mismo portátil y la misma red de la charla:

1. `/presentador` → tecla **C** → «Lanzar la pregunta de la miel». Espere a que el panel diga que Evidentia terminó (2–8 min).
2. Pase por las diapositivas con el celular abierto en `/vivo`.
3. Use los dos botones de la diapositiva 3 y compruebe que el celular los sigue.
4. Grabe los respaldos con lo que acaba de salir en vivo y vuelva a desplegar:

   ```bash
   PRESENTER_TOKEN=... node scripts/grabar-respaldos.mjs https://charla.davidduque.com
   npm test && npm run deploy
   ```

5. Descargue la copia sin red desde el panel (o `/presentador/descargar`) y ábrala desde el disco: los botones deben mostrar los resultados del ensayo con su fecha. Abra «Abrir el resultado del ensayo» de Evidentia y guárdelo como PDF (Ctrl+P) en el escritorio, junto a `charla-presentador-sin-red.html`: es el único respaldo de Evidentia que abre sin red.
6. `PRESENTER_TOKEN=... node scripts/preflight.mjs https://charla.davidduque.com` debe terminar en «Todo en orden».
7. Panel → «Reiniciar la sala», para que el público del día empiece limpio.

Después del 30 de septiembre solo se corrigen errores bloqueantes.

## El día de la charla

- Antes de subir: `/presentador` (eso renueva la sesión), **C**, «Lanzar la pregunta de la miel». Cierre el panel.
- Diapositiva 1: invite a escanear el QR o a escribir la dirección; el panel muestra cuántos están conectados.
- Diapositiva 3: pulse el primer botón (Claude) y lea la lista en forma corta mientras responde; una sola votación; después el segundo botón (PubMed). Si a los 8 s no ha llegado nada, aparece el botón «Mostrar la respuesta del ensayo»; a los 25 s el respaldo entra solo.
- Diapositiva 10: **C** → «Abrir el resultado en vivo» (o el del ensayo si no terminó). Sin red, ninguno de los dos abre: el PDF del ensayo en el escritorio.
- El punto de la barra inferior: verde = conectado; dorado = sin conexión (las demos usan los respaldos); rojo = la sesión venció (abra `/presentador` en otra pestaña y vuelva a entrar; esta sigue con los respaldos).
- Teclas: ← → cambian de diapositiva, **N** notas, **C** controles.

## Revisión adversarial

Los cuatro revisores viven en `../.claude/agents/` (`revisor-evento`, `revisor-etica`, `revisor-seguridad`, `revisor-organizador`). Se corren en paralelo antes del primer despliegue y otra vez después del ensayo general; los bloqueantes se corrigen antes de congelar.

## Estructura

```
base/        charla-ia-investigacion.html — la presentación original, intacta
datos/       contenido.json (referencias, prompt, diapositivas, kit) · config.json · respaldos.json
web/         presentador.js · vivo.html/js/css · entrar.* · sw-presentador.js
scripts/     construir.mjs · e2e.mjs · simuladores.mjs · grabar-respaldos.mjs · preflight.mjs
src/         index.ts (rutas) · sala.ts (Durable Object) · eventos.ts (contrato público) · auth.ts ·
             pubmed.ts · claude.ts · evidentia.ts · contenido.ts · respaldos.ts · limite.ts · respuestas.ts
test/        pruebas unitarias y fixtures de NCBI (resultados reales del 23 de septiembre de 2026)
public/      generado por la construcción (no se versiona)
```
