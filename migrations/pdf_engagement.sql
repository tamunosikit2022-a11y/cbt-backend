-- PDF engagement: likes/dislikes + view tracking (like ProjectPQ-style cards)

CREATE TABLE IF NOT EXISTS pdf_reactions (
  pdf_id     INTEGER     NOT NULL REFERENCES pdf_files(id) ON DELETE CASCADE,
  student_id INTEGER     NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  reaction   VARCHAR(10) NOT NULL CHECK (reaction IN ('like','dislike')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (pdf_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_pdf_reactions_pdf ON pdf_reactions(pdf_id);

CREATE TABLE IF NOT EXISTS pdf_views (
  pdf_id     INTEGER     NOT NULL REFERENCES pdf_files(id) ON DELETE CASCADE,
  student_id INTEGER     NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  viewed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (pdf_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_pdf_views_pdf ON pdf_views(pdf_id);
