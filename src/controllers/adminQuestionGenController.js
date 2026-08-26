/**
 * adminQuestionGenController.js
 * ─────────────────────────────────────────────────────────
 * Admin uploads a PDF → Groq extracts text → generates N×10 JAMB-format
 * questions → inserts directly into the questions table.
 *
 * Routes (add to adminRoutes.js):
 *   POST /api/admin/questions/generate-from-pdf
 *   GET  /api/admin/questions/gen-jobs           (job list)
 *   GET  /api/admin/questions/gen-jobs/:id       (job status)
 *
 * Dependencies already in package.json:
 *   groq-sdk, multer, pdf-parse
 */

const db      = require('../config/db');
const multer  = require('multer');
const os      = require('os');
const fs      = require('fs');
const { serverError } = require('../utils/errors');
const path    = require('path');
// FIX (the actual bug behind "Gemini key set but question generation still
// fails"): this file used to instantiate its OWN standalone Groq client
// and call it directly — completely bypassing the shared aiProvider.js
// helper that has Gemini-fallback logic. That meant this endpoint (which
// is what the Admin Dashboard's "🤖 AI Q's" button and bulk PDF→questions
// jobs actually call) could NEVER use Gemini, no matter what was set,
// because the code path that talks to Gemini simply never ran for this
// feature. Routing through the shared chatCompletion() fixes that — Groq
// is still tried first, and Gemini is now a real fallback here too.
const { chatCompletion } = require('../utils/aiProvider');
// FIX: llama-3.3-70b-versatile shuts down 16 Aug 2026 (Groq deprecation
// notice, 17 Jun 2026) — migrating to the recommended replacement now.
const MODEL = 'openai/gpt-oss-120b';

// ── Multer — disk storage for large PDFs ──────────────────
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, os.tmpdir()),
    filename:    (_req, file, cb) => {
      const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, `qgen_${Date.now()}_${safe}`);
    },
  }),
  limits:     { fileSize: 10000 * 1024 * 1024 }, // 200 MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/pdf') return cb(null, true);
    cb(new Error('Only PDF files are accepted.'));
  },
});
exports.uploadMiddleware = upload.single('pdf');

// ── PDF text extractor ────────────────────────────────────
async function extractPdfText(filePath) {
  try {
    // Try pdf-parse (most common)
    // NOTE: pdf-parse needs the whole file in memory (no streaming API),
    // so unlike the dedup hash in pdfController.js this buffer can't be
    // avoided — but using the async fs.promises.readFile instead of
    // readFileSync at least avoids blocking the event loop while the file
    // is read off disk (this still runs in the background via
    // setImmediate, but other requests share the same process).
    const pdfParse = require('pdf-parse');
    const buffer = await fs.promises.readFile(filePath);
    const data   = await pdfParse(buffer);
    return data.text || '';
  } catch {
    // Fallback: try pdfjs-dist or just read raw bytes (won't be great but won't crash)
    return '';
  }
}

// ── Chunk text into ~6000 char segments ───────────────────
function chunkText(text, size = 6000) {
  const chunks = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size).trim());
  }
  return chunks.filter(c => c.length > 200); // skip tiny chunks
}

// ── Groq → batch of questions ─────────────────────────────
// FIX (likely root cause of "wrong questions allocated to wrong
// answers" student complaints): this is the bulk PDF→questions pipeline
// that populates the SHARED question bank every student practices
// from — the highest-blast-radius of the three AI question-generation
// paths in this app (the other two, aiQuizController.js and
// aiQuestionController.js, only ever create a student's own personal
// quiz or a single admin-reviewed question). Both of those already
// instruct the AI to "re-derive the answer yourself from first
// principles... before finalizing" as an explicit self-check step —
// this file was missing that instruction entirely, meaning this
// specific pipeline had no defense against the AI's own well-known
// failure mode of confidently picking the wrong letter for a question
// it otherwise phrased correctly. A student selecting the objectively
// correct option would then be marked wrong because the STORED
// correct_answer was itself mistaken — which is exactly what "wrong
// answer allocated to the question" looks like from a student's
// perspective. Added the same self-verification rule the other two
// pipelines already have. This only improves questions generated going
// forward — it does not retroactively fix any already-inserted rows,
// which would need a separate content QA pass (spot-checking
// source: 'ai_generated' rows against their PDF source) rather than a
// code change.
async function generateBatch(content, opts) {
  const { subject, examType, difficulty, count } = opts;

  const prompt = `You are a Nigerian JAMB/WAEC question writer. Generate EXACTLY ${count} multiple-choice exam questions from the content below.

STRICT RULES:
1. Each question must have exactly 4 options: option_a, option_b, option_c, option_d.
2. Only ONE is correct. correct_answer = exactly one of: A B C D.
3. Do NOT use apostrophes or single-quotes — rephrase to avoid them.
4. No backslashes or control characters in any text.
5. Return ONLY a valid JSON object with a "questions" key. No markdown, no code fences, no extra text.
6. Subject: "${subject}". Exam: "${examType}". Difficulty: "${difficulty}".
7. Before finalizing each question, re-derive the answer yourself from first principles (redo any calculation, re-check any fact) and confirm it matches correct_answer — do not just assert an answer without checking it. If your first instinct was wrong, fix correct_answer accordingly.

FORMAT (copy exactly):
{"questions":[{"question":"...","option_a":"...","option_b":"...","option_c":"...","option_d":"...","correct_answer":"A","explanation":"...","topic":"..."}]}

CONTENT:
---
${content.slice(0, 6000)}
---`;

  const { content: rawContent, provider } = await chatCompletion({
    messages: [
      {
        role: 'system',
        content: 'You are a JSON-only API. Always respond with a valid JSON object containing a "questions" array. Never use markdown or code fences.',
      },
      { role: 'user', content: prompt },
    ],
    model: MODEL,
    maxTokens: 4096,
    temperature: 0.4,
    jsonMode: true,
  });
  if (provider === 'gemini') {
    console.log('[adminQuestionGen] Groq unavailable — answered by Gemini fallback.');
  }

  const raw = (rawContent || '').trim();

  // Robust JSON extraction — handles {"questions":[...]} and bare [...] fallback
  let cleaned = raw
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim();

  // Fix smart quotes before parsing
  cleaned = cleaned
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"');

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Last resort: find outermost array
    const start = cleaned.indexOf('[');
    const end   = cleaned.lastIndexOf(']');
    if (start === -1 || end === -1) throw new Error('No JSON array in response');
    parsed = JSON.parse(cleaned.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  }

  // Unwrap {"questions":[...]} or similar wrapper objects
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    const arr = Object.values(parsed).find(v => Array.isArray(v));
    if (arr) return arr;
  }
  throw new Error('No questions array found in AI response');
}

// ── Insert questions into DB ──────────────────────────────
async function insertQuestions(questions, opts) {
  const { subject, examType, institution } = opts;
  let inserted = 0;
  for (const q of questions) {
    try {
      if (!q.question || !q.option_a || !q.option_b || !q.option_c || !q.option_d || !q.correct_answer) continue;
      const ans = String(q.correct_answer).trim().toUpperCase().slice(0, 1);
      if (!['A','B','C','D'].includes(ans)) continue;

      await db.query(
        `INSERT INTO questions
           (exam_type, subject, topic, question, option_a, option_b, option_c, option_d,
            correct_answer, explanation, difficulty, institution, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT DO NOTHING`,
        [
          examType || 'JAMB',
          subject  || q.topic || 'General',
          q.topic  || null,
          q.question.slice(0, 2000),
          q.option_a.slice(0, 500),
          q.option_b.slice(0, 500),
          q.option_c.slice(0, 500),
          q.option_d.slice(0, 500),
          ans,
          q.explanation ? q.explanation.slice(0, 1000) : null,
          'medium',
          institution || 'JAMB',
          'ai_generated',
        ]
      );
      inserted++;
    } catch { /* skip bad question */ }
  }
  return inserted;
}

// ── MAIN ENDPOINT: POST /api/admin/questions/generate-from-pdf ──
exports.generateFromPdf = async (req, res) => {
  let jobId = null;
  const filePath = req.file?.path;

  try {
    if (!req.file) return res.status(400).json({ error: 'No PDF uploaded.' });

    const {
      subject     = 'General',
      exam_type   = 'JAMB',
      difficulty  = 'mixed',
      target      = '50',    // how many questions to try generating
      institution = 'JAMB',
    } = req.body;

    const countTarget = Math.min(parseInt(target) || 50, 500);

    // Create job record
    const jobRes = await db.query(
      `INSERT INTO question_gen_jobs
         (pdf_name, subject, exam_type, difficulty, count_target, status, created_by, started_at)
       VALUES ($1,$2,$3,$4,$5,'running',$6,NOW())
       RETURNING id`,
      [req.file.originalname, subject, exam_type, difficulty, countTarget, req.admin?.id || null]
    ).catch(() => ({ rows: [{ id: null }] }));

    jobId = jobRes.rows[0]?.id;

    // Respond immediately — processing continues async
    res.json({
      success:    true,
      job_id:     jobId,
      message:    `Processing "${req.file.originalname}" — generating up to ${countTarget} questions. Check job status for progress.`,
      status_url: jobId ? `/api/admin/questions/gen-jobs/${jobId}` : null,
    });

    // ── ASYNC PROCESSING ──────────────────────────────────
    setImmediate(async () => {
      let totalInserted = 0;
      try {
        // Extract text
        const rawText = await extractPdfText(filePath);
        if (!rawText || rawText.trim().length < 100) {
          throw new Error('PDF contains no extractable text. Try a text-based (not scanned) PDF.');
        }

        const chunks    = chunkText(rawText, 5500);
        const batchSize = 10; // 10 questions per chunk
        const batches   = Math.ceil(countTarget / batchSize);

        // FIX (silently capped question count): this loop cycles back through
        // `chunks` via `i % chunks.length` specifically so a short PDF (few
        // text chunks) can still be re-prompted enough times to reach a large
        // target — e.g. a 10-page PDF might only produce 4 chunks, but an
        // admin asking for 200 questions still needs 20 batches, cycling
        // through those same 4 chunks 5 times each. Capping the loop at
        // `chunks.length` (instead of just `batches`) stopped it after the
        // FIRST pass through the chunks every time, so no PDF could ever
        // produce more than (chunks.length × 10) questions no matter what
        // target was requested — a short/simple PDF silently capped out at
        // 30-40 questions even when 500 were asked for.
        for (let i = 0; i < Math.min(batches, 50); i++) {
          const chunk = chunks[i % chunks.length];
          try {
            const questions = await generateBatch(chunk, {
              subject, examType: exam_type, difficulty, count: batchSize,
            });
            const inserted = await insertQuestions(questions, {
              subject, examType: exam_type, institution,
            });
            totalInserted += inserted;

            // Update job progress
            if (jobId) {
              await db.query(
                `UPDATE question_gen_jobs SET count_done=$1 WHERE id=$2`,
                [totalInserted, jobId]
              ).catch(() => {});
            }

            // Small delay to avoid Groq rate-limit
            await new Promise(r => setTimeout(r, 800));

          } catch (batchErr) {
            console.error(`Batch ${i} error:`, batchErr.message);
          }
        }

        // Mark complete
        if (jobId) {
          await db.query(
            `UPDATE question_gen_jobs SET status='done', count_done=$1, finished_at=NOW() WHERE id=$2`,
            [totalInserted, jobId]
          ).catch(() => {});
        }

      } catch (err) {
        console.error('Question gen job failed:', err.message);
        if (jobId) {
          await db.query(
            `UPDATE question_gen_jobs SET status='failed', error_msg=$1, finished_at=NOW() WHERE id=$2`,
            [err.message, jobId]
          ).catch(() => {});
        }
      } finally {
        // Cleanup temp file
        if (filePath) fs.unlink(filePath, () => {});
      }
    });

  } catch (err) {
    if (filePath) fs.unlink(filePath, () => {});
    serverError(res, err);
  }
};

// ── GET /api/admin/questions/gen-jobs  ────────────────────
exports.listJobs = async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT j.*, a.full_name as created_by_name
       FROM question_gen_jobs j
       LEFT JOIN students a ON a.id = j.created_by
       ORDER BY j.created_at DESC LIMIT 50`
    ).catch(() => ({ rows: [] }));
    res.json({ jobs: rows });
  } catch (err) {
    serverError(res, err);
  }
};

// ── GET /api/admin/questions/gen-jobs/:id ────────────────
exports.getJob = async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM question_gen_jobs WHERE id=$1`, [req.params.id]
    ).catch(() => ({ rows: [] }));
    if (!rows.length) return res.status(404).json({ error: 'Job not found' });
    res.json({ job: rows[0] });
  } catch (err) {
    serverError(res, err);
  }
};

// ── generate-from-url: uses already-uploaded PDF URL ─────
// POST /api/admin/questions/generate-from-url
// Body: pdf_id, pdf_url, pdf_name, subject, exam_type, difficulty, target
exports.generateFromUrl = async (req, res) => {
  let { pdf_url, pdf_id, pdf_name, subject = 'General', exam_type = 'JAMB',
        difficulty = 'mixed', target = '50', institution = 'JAMB' } = req.body;

  // If pdf_url not supplied but pdf_id is, look up cloudinary_url from the DB.
  // This handles the case where older PDF records have a null cloudinary_url field
  // on the frontend (Bug 6: "pdf_url is required" error in Admin AI Question Gen).
  if (!pdf_url && pdf_id) {
    const row = await db.query(
      `SELECT cloudinary_url, title FROM pdf_files WHERE id=$1 AND is_active=TRUE`,
      [pdf_id]
    ).then(r => r.rows[0]).catch(() => null);

    if (row?.cloudinary_url) {
      pdf_url  = row.cloudinary_url;
      pdf_name = pdf_name || row.title;
    }
  }

  if (!pdf_url) return res.status(400).json({ error: 'pdf_url is required. The selected PDF may not have a Cloudinary URL stored — try re-uploading it.' });

  const countTarget = Math.min(parseInt(target) || 50, 500);

  // Create job
  const jobRes = await db.query(
    `INSERT INTO question_gen_jobs
       (pdf_name, subject, exam_type, difficulty, count_target, status, created_by, started_at)
     VALUES ($1,$2,$3,$4,$5,'running',$6,NOW()) RETURNING id`,
    [pdf_name || 'Uploaded PDF', subject, exam_type, difficulty, countTarget, req.admin?.id || null]
  ).catch(() => ({ rows: [{ id: null }] }));

  const jobId = jobRes.rows[0]?.id;

  res.json({
    success:    true,
    job_id:     jobId,
    message:    `Fetching PDF and generating up to ${countTarget} questions...`,
    status_url: jobId ? `/api/admin/questions/gen-jobs/${jobId}` : null,
  });

  // Async: download PDF, extract text, generate
  setImmediate(async () => {
    const tmpPath = path.join(os.tmpdir(), `qgen_url_${Date.now()}.pdf`);
    let totalInserted = 0;
    try {
      // Download PDF to temp file
      const https = require(pdf_url.startsWith('https') ? 'https' : 'http');
      await new Promise((resolve, reject) => {
        const file = fs.createWriteStream(tmpPath);
        https.get(pdf_url, resp => {
          if (resp.statusCode !== 200) return reject(new Error(`Download failed: HTTP ${resp.statusCode}`));
          resp.pipe(file);
          file.on('finish', () => file.close(resolve));
        }).on('error', reject);
      });

      const rawText = await extractPdfText(tmpPath);
      if (!rawText || rawText.trim().length < 100) {
        throw new Error('PDF contains no extractable text. Try a text-based (not scanned) PDF.');
      }

      const chunks    = chunkText(rawText, 5500);
      const batchSize = 10;
      const batches   = Math.ceil(countTarget / batchSize);

      // Same fix as generateFromPdf — see the comment there. Cap only by
      // `batches`, not `chunks.length`, so short PDFs can still be cycled
      // through enough times to reach a large requested target.
      for (let i = 0; i < Math.min(batches, 50); i++) {
        const chunk = chunks[i % chunks.length];
        try {
          const questions = await generateBatch(chunk, { subject, examType: exam_type, difficulty, count: batchSize });
          const inserted  = await insertQuestions(questions, { subject, examType: exam_type, institution });
          totalInserted  += inserted;
          if (jobId) await db.query(`UPDATE question_gen_jobs SET count_done=$1 WHERE id=$2`, [totalInserted, jobId]).catch(() => {});
          await new Promise(r => setTimeout(r, 800));
        } catch (e) { console.error(`Batch ${i}:`, e.message); }
      }

      if (jobId) await db.query(`UPDATE question_gen_jobs SET status='done', count_done=$1, finished_at=NOW() WHERE id=$2`, [totalInserted, jobId]).catch(() => {});
    } catch (err) {
      if (jobId) await db.query(`UPDATE question_gen_jobs SET status='failed', error_msg=$1, finished_at=NOW() WHERE id=$2`, [err.message, jobId]).catch(() => {});
    } finally {
      fs.unlink(tmpPath, () => {});
    }
  });
};
