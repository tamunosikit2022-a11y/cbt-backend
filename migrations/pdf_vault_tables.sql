-- ── PDF VAULT TABLES ─────────────────────────────────────────
-- These were referenced throughout src/controllers/pdfController.js
-- (adminUpload, adminListPdfs, adminDeletePdf, adminPdfStats,
-- studentListPdfs, studentDownload) but were never actually created by
-- any migration in this repo, so every PDF upload failed with
-- "relation pdf_files does not exist".
--
-- Run this once against your database (e.g. via psql, or your usual
-- migration runner) before using the PDF Vault feature.

CREATE TABLE IF NOT EXISTS pdf_files (
  id                    SERIAL PRIMARY KEY,
  title                 TEXT        NOT NULL,
  category              TEXT        NOT NULL,
  file_name             TEXT        NOT NULL,
  cloudinary_url        TEXT        NOT NULL,
  cloudinary_public_id  TEXT,
  subject               TEXT,
  description           TEXT,
  tags                  JSONB       DEFAULT '[]',
  pages                 INTEGER,
  file_size_bytes       BIGINT      DEFAULT 0,
  vault_item_id         TEXT,
  student_id            INTEGER,
  uploaded_by           INTEGER,
  is_active             BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pdf_download_log (
  id            SERIAL PRIMARY KEY,
  pdf_id        INTEGER     NOT NULL REFERENCES pdf_files(id) ON DELETE CASCADE,
  student_id    INTEGER,
  ip_address    TEXT,
  downloaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pdf_files_category   ON pdf_files(category);
CREATE INDEX IF NOT EXISTS idx_pdf_files_active      ON pdf_files(is_active);
CREATE INDEX IF NOT EXISTS idx_pdf_files_vault_item  ON pdf_files(vault_item_id);
CREATE INDEX IF NOT EXISTS idx_pdf_files_student     ON pdf_files(student_id);
CREATE INDEX IF NOT EXISTS idx_pdf_download_log_pdf  ON pdf_download_log(pdf_id);
