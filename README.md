# evidentia

Orquestador de evidencia científica para decisiones clínicas.

No es un buscador con IA encima. Es un sistema que produce evidencia **defendible ante un
revisor par**: cada afirmación de la salida está enlazada al fragmento textual exacto de
la fuente que la sostiene, y cada juicio metodológico lleva registro de quién lo emitió y
con qué versión de qué instrumento.

## Los dos invariantes

**1. Ninguna afirmación se publica sin su span.** No una referencia bibliográfica: el
texto. El invariante vive en el tipo, no en la disciplina — `Claim` exige `spans` con al
menos un elemento, así que una afirmación sin respaldo no se puede ni construir.

**2. La IA nunca emite el juicio.** Riesgo de sesgo, certeza GRADE y recomendación los
emite una persona. Esto no es prudencia decorativa: es lo que dicen las cifras.

```
Concordancia de la IA con evaluadores humanos (κ), estudios 2025–2026:
  RoB 2                    0,06 – 0,13     ← peor que el azar en algunos dominios
  Newcastle-Ottawa (RAG)   0,08 – 0,27
  RoB 1                    0,27 – 0,39
  RoB Cochrane (GPT-4o)    0,43
  ───────────────────────────────────
  Concordancia sustancial  ≥ 0,60

Exactitud en extracción de datos:
  IA, datos numéricos      47 – 88%        ← por eso se verifica el 100%
  IA, campos categóricos   74 – 96%
  Solo humano                    89,0%
  IA + humano                    91,0%     ← aquí sí automatizamos
```

El sistema automatiza donde la IA es mejor y se aparta donde es peor. Las cifras están en
`evidentia-instruments`, junto a cada instrumento, con su cita.

## Los tres repositorios

| Repo | Qué contiene | Ritmo de cambio |
|---|---|---|
| **evidentia** | El motor | Continuo |
| **evidentia-instruments** | Instrumentos metodológicos como datos versionados | Lento, con revisión doble |
| **evidentia-protocols** | Protocolos clínicos, uno por archivo, con aprobación humana | Por pull request |

## Estructura

```
apps/
  api/          Worker HTTP + Cloudflare Workflows (el orquestador)
packages/
  core/         Modelo canónico: Claim · Span · Source · Verification · Judgment
  verify/       E0–E5: existencia · retractación · entailment · compuerta humana
  sources/      Adaptadores con su régimen de licencia declarado
  search/       PICO → estrategia booleana reproducible
apps/api/
  migrations/   Esquema D1 (wrangler las resuelve relativas a wrangler.jsonc)
infra/
  vectorize-setup.sh   Congela el esquema de filtros del índice vectorial
```

## Estado actual

`ask` y `case` **funcionan de extremo a extremo**: estructuran la pregunta en PICO, construyen
la búsqueda, consultan PubMed y Europe PMC de verdad, deduplican, comprueban retractaciones
contra Crossref y PubMed, y devuelven las referencias con su estado de integridad.

`protocol` tiene el esqueleto con las tres compuertas; le faltan extracción, valoración y
síntesis. `surveil` está pendiente.

Toda salida de `ask` y `case` lleva una advertencia explícita de que **no ha sido revisada por
un humano** y no sirve para fundamentar una recomendación.

## Los cuatro flujos

Comparten un solo núcleo. Cambia la profundidad y las compuertas humanas.

| Flujo | Duración | Compuertas | Salida |
|---|---|---|---|
| `ask` | 2–8 min | 0 | Síntesis con citas verificadas, marcada como no revisada |
| `case` | 3–10 min | 0 | Opciones de manejo para un caso de-identificado |
| `protocol` | 2–15 días | 3 | Protocolo GRADE completo, firmado |
| `surveil` | continuo | 1 | PR al repo de protocolos cuando la evidencia cambia algo |

Una instancia de Workflow en espera no consume concurrencia ni cómputo, así que una
compuerta que tardas dos semanas en atender no cuesta nada.

## Empezar

```bash
pnpm install
pnpm typecheck
pnpm test

# Pruebas contra las APIs reales (Crossref, NCBI). Se SALTAN si no hay red:
# un test que confunde "no pude preguntar" con "no existe" comete justo el error
# que este sistema existe para evitar.
NCBI_EMAIL=tu@correo.com pnpm --filter @evidentia/verify test:live
```

### Antes de desplegar

1. Rellenar `CONTACT_EMAIL` en `apps/api/wrangler.jsonc`. **Es obligatorio**: NCBI exige
   `tool` y `email` en cada petición, y sin ellos limita a 3 peticiones/s y puede
   bloquear la IP. Crossref hace lo propio con `mailto`.
2. Crear la base D1 y poner su `database_id`.
3. **Congelar el esquema de filtros de Vectorize antes de la primera carga:**
   `bash infra/vectorize-setup.sh`. Los índices de metadatos solo indexan los primeros
   64 bytes, hay un máximo de 10, y no se aplican retroactivamente: equivocarse obliga a
   reindexar todo el corpus. El esquema vive en `packages/core/src/vector-metadata.ts`
   y son 9 campos — `year`, `design`, `source`, `lang`, `rob`, `age`, `region`,
   `condition`, `setting` — con una ranura libre a propósito.

   `condition` usa el **descriptor MeSH principal** en minúsculas (`diabetic-foot`,
   `low-back-pain`) en vez de una lista cerrada. Es un vocabulario ya controlado por la
   NLM, cabe en 64 bytes, y deja el sistema abierto a cualquier campo clínico sin tener
   que decidir hoy cuál será.
4. Confirmar que la cuenta está en Workers Paid. El plan gratuito topa Workflows en 1.024
   pasos y 10 ms de CPU.

## Límites que condicionan el diseño

- **1 MiB por retorno de paso**, no configurable → los pasos devuelven punteros a R2.
- **25.000 pasos máximo** (10.000 por defecto) → agrupar trabajo por paso, no un paso por
  referencia.
- **`waitForEvent` falla a las 24 h por defecto** → plazos explícitos de 7–30 días
  envueltos en manejo de error, o una compuerta desatendida mata días de trabajo.
- **Retención de estado: 30 días** → todo se persiste en D1 y R2 desde dentro de los pasos.
- **6 conexiones salientes por Worker** → el paralelismo real va por workflows hijos.

## Fechas que importan

- **24 de agosto de 2026**: PMC retira su servicio web antiguo. Cualquier integración
  nueva debe nacer contra el servicio en S3.
- **Febrero de 2026** (ya ocurrido): OpenAlex dejó de ser gratuito e ilimitado. Usar el
  volcado completo, que sigue siendo de dominio público; la API solo para lookups por DOI.

## Lo que este sistema no hace

No reduce tu responsabilidad clínica. Hace **defendible** el razonamiento: permite que un
revisor audite cada paso, incluido dónde intervino un humano y dónde no. La decisión sigue
siendo de quien la firma.
