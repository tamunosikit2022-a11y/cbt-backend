-- Live IDE projects migration
-- Backing store for Scholar Session's "Live IDE" feature (see the feature
-- spec, section 6). Execution is entirely client-side (Pyodide for Python,
-- an in-browser microcontroller emulator for Arduino later) — this table
-- ONLY holds save/load state. No code ever runs on the backend.
--
-- `kind` distinguishes Python scripts from circuit-layout projects so the
-- same table/endpoints can serve both once the circuit canvas (Phase 3)
-- ships, without a second migration. `code` holds either the raw Python
-- source or, for circuits, a JSON-serialized layout (components + wiring).

CREATE TABLE IF NOT EXISTS live_ide_projects (
  id          BIGSERIAL PRIMARY KEY,
  student_id  INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  kind        VARCHAR(20) NOT NULL DEFAULT 'python' CHECK (kind IN ('python', 'arduino', 'circuit')),
  title       VARCHAR(120) NOT NULL DEFAULT 'Untitled script',
  code        TEXT NOT NULL DEFAULT '',
  board_type  VARCHAR(40),              -- e.g. 'arduino_uno', 'esp32' — NULL for python
  created_at  TIMESTAMP DEFAULT NOW(),
  updated_at  TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_live_ide_projects_student ON live_ide_projects(student_id, kind, updated_at DESC);
