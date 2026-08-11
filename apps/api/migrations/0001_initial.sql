-- Esquema inicial de Evidentia.
--
-- El modelo persiste lo que hace auditable una síntesis: de qué fuente salió cada
-- afirmación, qué fragmento textual la respalda, quién emitió cada juicio y con qué
-- versión de qué instrumento, y dónde intervino un modelo.
--
-- D1 es la fuente de verdad operativa porque el estado interno de Workflows se
-- retiene 30 días y el registro de auditoría de una revisión tiene que durar años.

CREATE TABLE runs (
  id             TEXT PRIMARY KEY,
  mode           TEXT NOT NULL CHECK (mode IN ('ask','case','protocol','surveil')),
  question       TEXT NOT NULL,
  pico_json      TEXT NOT NULL,
  strategy_json  TEXT NOT NULL,
  -- La sensibilidad objetivo se declara ANTES de buscar y se guarda con la
  -- ejecución. Declararla después de ver los resultados es ajustar la vara al
  -- resultado.
  recall_target  REAL NOT NULL DEFAULT 0.95,
  recall_measured REAL,
  status         TEXT NOT NULL DEFAULT 'running',
  created_at     TEXT NOT NULL,
  completed_at   TEXT
);

CREATE TABLE sources (
  id                TEXT PRIMARY KEY,
  run_id            TEXT NOT NULL REFERENCES runs(id),
  doi               TEXT,
  pmid              TEXT,
  pmcid             TEXT,
  title             TEXT NOT NULL,
  year              INTEGER,
  journal           TEXT,
  design            TEXT NOT NULL DEFAULT 'unknown',
  -- 'unknown' significa NO COMPROBADO, no 'limpio'. La diferencia es todo el
  -- punto: tratar lo no comprobado como limpio miente por omisión.
  editorial_status  TEXT NOT NULL DEFAULT 'unknown',
  editorial_notice  TEXT,
  editorial_checked_at TEXT,
  license           TEXT,
  full_text_key     TEXT,
  retrieved_from    TEXT NOT NULL,
  retrieved_at      TEXT NOT NULL
);

CREATE TABLE spans (
  id          TEXT PRIMARY KEY,
  source_id   TEXT NOT NULL REFERENCES sources(id),
  text        TEXT NOT NULL,
  section     TEXT NOT NULL DEFAULT 'other',
  char_start  INTEGER,
  char_end    INTEGER,
  page        INTEGER,
  -- Permite detectar que la fuente cambió: un span cuyo hash ya no coincide con
  -- el documento dejó de ser verificable.
  text_hash   TEXT NOT NULL,
  extracted_at TEXT NOT NULL
);

CREATE TABLE claims (
  id               TEXT PRIMARY KEY,
  run_id           TEXT NOT NULL REFERENCES runs(id),
  text             TEXT NOT NULL,
  contains_numeric INTEGER NOT NULL DEFAULT 0,
  feeds_judgment   INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL
);

-- INVARIANTE 1. Una afirmación sin al menos una fila aquí no se publica. En el
-- código el invariante vive en el tipo (`Claim.spans` es una tupla no vacía);
-- esta tabla es su contrapartida persistida.
CREATE TABLE claim_spans (
  claim_id TEXT NOT NULL REFERENCES claims(id),
  span_id  TEXT NOT NULL REFERENCES spans(id),
  PRIMARY KEY (claim_id, span_id)
);

CREATE TABLE verifications (
  id                TEXT PRIMARY KEY,
  claim_id          TEXT NOT NULL REFERENCES claims(id),
  -- FOUND | NOT_FOUND | UNRESOLVED. Los tres, no dos: un fallo de red es
  -- UNRESOLVED, y confundirlo con NOT_FOUND convierte una caída de Crossref en
  -- una acusación masiva de citas fabricadas.
  existence         TEXT NOT NULL,
  editorial_blocked INTEGER NOT NULL DEFAULT 0,
  support           TEXT,
  disagreement      INTEGER NOT NULL DEFAULT 0,
  escalated         INTEGER NOT NULL DEFAULT 0,
  escalation_reason TEXT,
  resolved_by       TEXT,
  resolved_at       TEXT,
  runs_json         TEXT NOT NULL
);

-- INVARIANTE 2. `by_kind` distingue quién emitió el juicio. El runner de
-- instrumentos rechaza un juicio de máquina bajo régimen 'human-judgment':
-- la concordancia de la IA en RoB 2 es κ 0,06–0,13, peor que el azar.
CREATE TABLE judgments (
  id                  TEXT PRIMARY KEY,
  subject_id          TEXT NOT NULL,
  -- Instrumento y versión exacta: los instrumentos validados cambian entre
  -- revisiones, y 'se usó RoB 2' sin decir cuál no permite reproducir nada.
  instrument_id       TEXT NOT NULL,
  instrument_version  TEXT NOT NULL,
  instrument_unverified INTEGER NOT NULL DEFAULT 0,
  domain              TEXT NOT NULL,
  verdict             TEXT NOT NULL,
  rationale           TEXT,
  span_ids_json       TEXT NOT NULL DEFAULT '[]',
  by_kind             TEXT NOT NULL CHECK (by_kind IN ('human','machine')),
  by_identifier       TEXT NOT NULL,
  emitted_at          TEXT NOT NULL
);

-- Declaración de uso de IA (TRIPOD-LLM, ICMJE, COPE). Se registra también cuando
-- el modelo falló y se cayó al respaldo determinista: 'aquí no intervino IA'
-- también es información.
CREATE TABLE ai_disclosures (
  id            TEXT PRIMARY KEY,
  subject_id    TEXT NOT NULL,
  run_id        TEXT REFERENCES runs(id),
  system        TEXT NOT NULL,
  model         TEXT NOT NULL,
  model_version TEXT,
  stage         TEXT NOT NULL,
  purpose       TEXT NOT NULL,
  supervision   TEXT NOT NULL CHECK (supervision IN ('none','sampled','full-review','human-decided')),
  parameters_json TEXT NOT NULL DEFAULT '{}',
  limitations   TEXT,
  ran_at        TEXT NOT NULL
);

CREATE INDEX idx_sources_run ON sources(run_id);
-- Únicos por ejecución: si el deduplicador dejó pasar dos copias con el mismo
-- DOI, la inserción falla en vez de inflar el recuento de evidencia.
CREATE UNIQUE INDEX idx_sources_doi ON sources(run_id, doi) WHERE doi IS NOT NULL;
CREATE UNIQUE INDEX idx_sources_pmid ON sources(run_id, pmid) WHERE pmid IS NOT NULL;
CREATE INDEX idx_sources_retracted ON sources(editorial_status) WHERE editorial_status IN ('retracted','withdrawn');
CREATE INDEX idx_spans_source ON spans(source_id);
CREATE INDEX idx_claims_run ON claims(run_id);
CREATE INDEX idx_verifications_claim ON verifications(claim_id);
CREATE INDEX idx_verifications_escalated ON verifications(escalated) WHERE escalated = 1;
CREATE INDEX idx_judgments_subject ON judgments(subject_id);
CREATE INDEX idx_disclosures_run ON ai_disclosures(run_id);
