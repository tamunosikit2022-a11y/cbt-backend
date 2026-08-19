/**
 * pdfController.js — Cloudinary version
 *
 * PDFs are uploaded to Cloudinary under: scholars-cbt/pdfs/{category}/
 * The secure_url and public_id are stored in the database.
 * Download = permission check → redirect to Cloudinary secure URL.
 */

const cloudinary = require("cloudinary").v2;
const crypto = require('crypto');
const db         = require("../config/db");
const { serverError } = require('../utils/errors');

// Cloudinary config (already set via env vars for avatars)
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const VALID_CATEGORIES = [
  "assignments",
  "results",
  "notes",
  "predictions",
  "formulas",
  "general",
];

// FIX (bulk upload instability / freezes / crashes): the dedup-check used
// to do `fs.readFileSync(req.file.path)` — reading the ENTIRE PDF (up to
// 500MB, per the multer limit below) into a single in-memory Buffer just
// to hash it, synchronously, BEFORE the real upload even started. That:
//   1) Blocks Node's single event loop for the whole read — with the
//      frontend uploading 3 files concurrently, that's 3 large synchronous
//      reads competing for the same blocked thread, stalling every other
//      request AND every open Socket.io connection while it happens.
//   2) Spikes memory by the full file size on top of whatever else is
//      running, against a 200MB Node heap limit (see Dockerfile) — a
//      recipe for OOM crashes under real concurrent load.
// Streaming the file through the hash function does the same job (a
// SHA-256 of the file contents) without ever holding the whole file in
// memory and without blocking the event loop — it hashes in small chunks
// as they're read off disk.
function hashFileStream(filePath) {
  return new Promise((resolve, reject) => {
    const fs = require('fs');
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function humanSize(bytes) {
  if (!bytes) return "—";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0, s = bytes;
  while (s >= 1024 && i < u.length - 1) { s /= 1024; i++; }
  return `${s.toFixed(1)} ${u[i]}`;
}

// Upload to Cloudinary — supports both buffer (small) and disk path (large)
function uploadToCloudinary(bufferOrPath, filename, category) {
  const fs     = require('fs');
  const folder = `scholars-cbt/pdfs/${category}`;
  const opts   = {
    resource_type:   'raw',
    folder,
    public_id:       filename.replace(/\.pdf$/i, ''),
    use_filename:    true,
    unique_filename: true,
    overwrite:       false,
    timeout:         120000,   // 2 min timeout for large files
    chunk_size:      20000000, // 20 MB chunks
  };

  // FIX (bulk upload failing on anything over 10MB): this function already
  // sets `chunk_size` in opts and even has a comment saying it "supports
  // both buffer (small) and disk path (large)" — but calling
  // cloudinary.uploader.upload() ignores that intent. upload() is a single
  // synchronous request that Cloudinary caps at a plan-dependent size
  // regardless of chunk_size (that's exactly the "File size too large...
  // Maximum is 10485760. Upgrade your plan" error — 10485760 bytes = 10MB,
  // the free-tier cap on that endpoint). upload_large() is Cloudinary's
  // dedicated chunked-upload method: it actually splits the file into
  // chunk_size pieces and uploads them as a resumable session, which is
  // what makes files bigger than the plan's single-request cap possible
  // at all — and it's the only way the "Up to 200 MB per file" already
  // promised in the admin UI can actually be true.
  if (typeof bufferOrPath === 'string') {
    return cloudinary.uploader.upload_large(bufferOrPath, opts);
  }

  // Otherwise stream the buffer — also switched to upload_large so large
  // in-memory buffers get the same chunked-upload treatment.
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_large_stream(opts, (error, result) => {
      if (error) return reject(error);
      resolve(result);
    });
    stream.end(bufferOrPath);
  });
}

// ── ADMIN: UPLOAD PDF ─────────────────────────────────────
// POST /api/admin/pdfs/upload  (multipart, field: "pdf")
exports.adminUpload = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No PDF file received." });

    const {
      title        = req.file.originalname,
      category     = "general",
      subject      = null,
      description  = null,
      tags         = "[]",
      vault_item_id = null,
      student_id   = null,
      pages        = null,
    } = req.body;

    if (!VALID_CATEGORIES.includes(category)) {
      return res.status(400).json({
        error: `Invalid category. Must be one of: ${VALID_CATEGORIES.join(", ")}`,
      });
    }

    // Safe filename for Cloudinary public_id
    const safeName = req.file.originalname
      .replace(/[^a-zA-Z0-9_\-\.]/g, "_")
      .slice(0, 100);

    // Support both memoryStorage (buffer) and diskStorage (path)
    const fileSource   = req.file.path || req.file.buffer;
    const fileSizeBytes = req.file.size || (req.file.buffer ? req.file.buffer.length : 0);

    // ── Dedup: compute SHA-256 hash and reject duplicates ─────
    // Buffer path (memoryStorage, small files): already in RAM, hash directly.
    // Disk path (diskStorage, the actual path this app uses): stream it —
    // see hashFileStream() above for why this matters for large files.
    const fileHash = req.file.buffer
      ? crypto.createHash('sha256').update(req.file.buffer).digest('hex')
      : await hashFileStream(req.file.path);

    const existing = await db.query(
      `SELECT id, title, cloudinary_url FROM pdf_files WHERE file_hash=$1 LIMIT 1`,
      [fileHash]
    ).then(r => r.rows[0]).catch(() => null);

    if (existing) {
      if (req.file.path) require('fs').unlink(req.file.path, () => {});
      return res.status(409).json({
        error: `This PDF already exists in the vault as "${existing.title}". Duplicate uploads are blocked.`,
        existing_id:  existing.id,
        existing_url: existing.cloudinary_url,
      });
    }

    // Upload to Cloudinary
    const cloudResult = await uploadToCloudinary(fileSource, safeName, category);

    // Cleanup temp file if using disk storage
    if (req.file.path) {
      require('fs').unlink(req.file.path, () => {});
    }

    let parsedTags = [];
    try { parsedTags = JSON.parse(tags); } catch { parsedTags = []; }

    const { rows } = await db.query(
      `INSERT INTO pdf_files
         (title, category, file_name, cloudinary_url, cloudinary_public_id,
          subject, description, tags, pages, file_size_bytes,
          vault_item_id, student_id, uploaded_by, file_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [
        title,
        category,
        req.file.originalname,
        cloudResult.secure_url,
        cloudResult.public_id,
        subject      || null,
        description  || null,
        JSON.stringify(parsedTags),
        pages        ? parseInt(pages) : null,
        req.file.size,
        vault_item_id || null,
        student_id   ? parseInt(student_id) : null,
        req.admin.id,
        fileHash,
      ]
    );

    res.status(201).json({
      success: true,
      pdf: { ...rows[0], file_size_human: humanSize(rows[0].file_size_bytes) },
      message: `"${title}" uploaded to Cloudinary (${category})`,
    });
  } catch (err) {
    console.error("PDF upload error:", err);
    serverError(res, err);
  }
};

// ── ADMIN: LIST ALL PDFs ──────────────────────────────────
// GET /api/admin/pdfs?category=&subject=&search=&page=1&limit=20
exports.adminListPdfs = async (req, res) => {
  try {
    const {
      category      = "",
      subject       = "",
      search        = "",
      vault_item_id = "",
      page          = 1,
      limit         = 20,
    } = req.query;

    const offset     = (parseInt(page) - 1) * parseInt(limit);
    const conditions = ["pf.is_active = TRUE"];
    const params     = [];
    let   pi         = 1;

    if (category)      { conditions.push(`pf.category = $${pi++}`);          params.push(category); }
    if (subject)       { conditions.push(`pf.subject ILIKE $${pi++}`);        params.push(`%${subject}%`); }
    if (vault_item_id) { conditions.push(`pf.vault_item_id = $${pi++}`);      params.push(vault_item_id); }
    if (search) {
      conditions.push(`(pf.title ILIKE $${pi} OR pf.description ILIKE $${pi + 1})`);
      params.push(`%${search}%`, `%${search}%`);
      pi += 2;
    }

    const where = conditions.join(" AND ");

    const [dataRes, countRes] = await Promise.all([
      db.query(
        `SELECT pf.*,
                s.full_name AS student_name,
                (SELECT COUNT(*) FROM pdf_download_log dl WHERE dl.pdf_id = pf.id) AS download_count,
                COALESCE((SELECT COUNT(*) FROM pdf_reactions r WHERE r.pdf_id=pf.id AND r.reaction='like'),0)    AS like_count,
                COALESCE((SELECT COUNT(*) FROM pdf_reactions r WHERE r.pdf_id=pf.id AND r.reaction='dislike'),0) AS dislike_count,
                COALESCE((SELECT COUNT(*) FROM pdf_views v WHERE v.pdf_id=pf.id),0)                              AS view_count
         FROM pdf_files pf
         LEFT JOIN students s ON pf.student_id = s.id
         WHERE ${where}
         ORDER BY pf.created_at DESC
         LIMIT $${pi} OFFSET $${pi + 1}`,
        [...params, parseInt(limit), offset]
      ),
      db.query(`SELECT COUNT(*) FROM pdf_files pf WHERE ${where}`, params),
    ]);

    const total = parseInt(countRes.rows[0].count);

    res.json({
      pdfs: dataRes.rows.map(r => ({ ...r, file_size_human: humanSize(r.file_size_bytes) })),
      pagination: {
        total,
        page:       parseInt(page),
        limit:      parseInt(limit),
        totalPages: Math.ceil(total / parseInt(limit)),
      },
      categories: VALID_CATEGORIES,
    });
  } catch (err) {
    serverError(res, err);
  }
};

// ── ADMIN: DELETE PDF ─────────────────────────────────────
// DELETE /api/admin/pdfs/:pdf_id
exports.adminDeletePdf = async (req, res) => {
  try {
    const { pdf_id } = req.params;

    const { rows } = await db.query(
      "SELECT * FROM pdf_files WHERE id=$1 AND is_active=TRUE",
      [pdf_id]
    );
    if (!rows.length) return res.status(404).json({ error: "PDF not found." });

    const pdf = rows[0];

    // Delete from Cloudinary
    if (pdf.cloudinary_public_id) {
      await cloudinary.uploader.destroy(pdf.cloudinary_public_id, {
        resource_type: "raw",
      }).catch(e => console.warn("Cloudinary delete warning:", e.message));
    }

    // Soft-delete DB row
    await db.query("UPDATE pdf_files SET is_active=FALSE WHERE id=$1", [pdf_id]);

    res.json({ success: true, message: `"${pdf.title}" deleted.` });
  } catch (err) {
    serverError(res, err);
  }
};

// ── ADMIN: STATS ──────────────────────────────────────────
// GET /api/admin/pdfs/stats
exports.adminPdfStats = async (req, res) => {
  try {
    const [totals, byCategory, topDownloads] = await Promise.all([
      db.query(`
        SELECT COUNT(*)                                 AS total_files,
               COALESCE(SUM(file_size_bytes), 0)       AS total_size,
               (SELECT COUNT(*) FROM pdf_download_log) AS total_downloads
        FROM pdf_files WHERE is_active=TRUE
      `),
      db.query(`
        SELECT category, COUNT(*) AS file_count,
               COALESCE(SUM(file_size_bytes),0) AS size_bytes
        FROM pdf_files WHERE is_active=TRUE
        GROUP BY category ORDER BY file_count DESC
      `),
      db.query(`
        SELECT pf.id, pf.title, pf.category, COUNT(dl.id) AS downloads
        FROM pdf_files pf
        LEFT JOIN pdf_download_log dl ON dl.pdf_id = pf.id
        WHERE pf.is_active=TRUE
        GROUP BY pf.id ORDER BY downloads DESC LIMIT 5
      `),
    ]);

    const t = totals.rows[0];
    res.json({
      total_files:     parseInt(t.total_files),
      total_size:      humanSize(parseInt(t.total_size)),
      total_downloads: parseInt(t.total_downloads),
      by_category:     byCategory.rows.map(r => ({
        ...r, size_human: humanSize(parseInt(r.size_bytes)),
      })),
      top_downloads: topDownloads.rows,
    });
  } catch (err) {
    serverError(res, err);
  }
};

// ── STUDENT: LIST ACCESSIBLE PDFs ────────────────────────
// GET /api/vault/pdfs
exports.studentListPdfs = async (req, res) => {
  try {
    const sid      = req.student.id;
    const { category = "", subject = "" } = req.query;

    // Get student's owned vault items
    const ownedRes = await db.query(
      "SELECT item_id FROM student_vault WHERE student_id=$1",
      [sid]
    ).catch(() => ({ rows: [] }));
    const ownedItems = ownedRes.rows.map(r => r.item_id);

    const safeParams = [sid, ...ownedItems];

    const accessFilter = ownedItems.length
      ? `(pf.vault_item_id IS NULL AND pf.student_id IS NULL)
         OR pf.vault_item_id = ANY(ARRAY[${ownedItems.map((_, i) => `$${i + 2}`)}]::text[])
         OR pf.student_id = $1`
      : `(pf.vault_item_id IS NULL AND pf.student_id IS NULL) OR pf.student_id = $1`;

    let catFilter  = "";
    let subjFilter = "";

    if (category) { safeParams.push(category);        catFilter  = `AND pf.category = $${safeParams.length}`; }
    if (subject)  { safeParams.push(`%${subject}%`);  subjFilter = `AND pf.subject ILIKE $${safeParams.length}`; }

    const { rows } = await db.query(
      `SELECT pf.id, pf.title, pf.category, pf.subject, pf.description,
              pf.tags, pf.pages, pf.file_size_bytes, pf.vault_item_id,
              pf.student_id, pf.created_at,
              COALESCE((SELECT COUNT(*) FROM pdf_reactions r WHERE r.pdf_id=pf.id AND r.reaction='like'),0)    AS like_count,
              COALESCE((SELECT COUNT(*) FROM pdf_reactions r WHERE r.pdf_id=pf.id AND r.reaction='dislike'),0) AS dislike_count,
              COALESCE((SELECT COUNT(*) FROM pdf_views v WHERE v.pdf_id=pf.id),0)                              AS view_count,
              (SELECT r.reaction FROM pdf_reactions r WHERE r.pdf_id=pf.id AND r.student_id=$1)                AS my_reaction
       FROM pdf_files pf
       WHERE pf.is_active = TRUE
         AND (${accessFilter})
         ${catFilter} ${subjFilter}
       ORDER BY pf.created_at DESC`,
      safeParams
    );

    res.json({
      pdfs: rows.map(r => ({
        ...r,
        file_size_human: humanSize(r.file_size_bytes),
        like_count:    parseInt(r.like_count),
        dislike_count: parseInt(r.dislike_count),
        view_count:    parseInt(r.view_count),
      })),
      categories: VALID_CATEGORIES,
    });
  } catch (err) {
    console.error("studentListPdfs error:", err);
    serverError(res, err);
  }
};

// ── STUDENT: DOWNLOAD PDF ─────────────────────────────────
// GET /api/vault/pdfs/:pdf_id/download
exports.studentDownload = async (req, res) => {
  try {
    const { pdf_id } = req.params;
    const sid        = req.student.id;

    const { rows } = await db.query(
      "SELECT * FROM pdf_files WHERE id=$1 AND is_active=TRUE",
      [pdf_id]
    );
    if (!rows.length) return res.status(404).json({ error: "PDF not found." });

    const pdf = rows[0];

    // ── ACCESS CONTROL ─────────────────────────────────────
    let allowed = false;

    if (pdf.student_id === null && pdf.vault_item_id === null) {
      allowed = true;
    } else if (pdf.student_id !== null) {
      allowed = parseInt(pdf.student_id) === parseInt(sid);
    } else if (pdf.vault_item_id) {
      const owned = await db.query(
        "SELECT id FROM student_vault WHERE student_id=$1 AND item_id=$2",
        [sid, pdf.vault_item_id]
      ).catch(() => ({ rows: [] }));
      allowed = owned.rows.length > 0;
    }

    if (!allowed) {
      return res.status(403).json({
        error: "Access denied. Unlock this item in the Knowledge Vault first.",
        vault_item_id: pdf.vault_item_id,
      });
    }

    // Log download (non-blocking)
    db.query(
      "INSERT INTO pdf_download_log (pdf_id, student_id, ip_address) VALUES ($1,$2,$3)",
      [pdf.id, sid, req.ip]
    ).catch(() => {});

    // Redirect to Cloudinary URL — browser triggers download
    res.redirect(pdf.cloudinary_url);

  } catch (err) {
    console.error("studentDownload error:", err);
    serverError(res, err);
  }
};

exports.VALID_CATEGORIES = VALID_CATEGORIES;

// ── STUDENT: LIKE / DISLIKE A PDF ─────────────────────────
// POST /api/vault/pdfs/:pdf_id/react   body: { reaction: "like" | "dislike" }
// Tapping the same reaction again removes it (toggle off), matching
// standard like/dislike UX.
exports.reactToPdf = async (req, res) => {
  try {
    const { pdf_id }  = req.params;
    const sid          = req.student.id;
    const { reaction } = req.body;

    if (!["like", "dislike"].includes(reaction)) {
      return res.status(400).json({ error: "Reaction must be 'like' or 'dislike'." });
    }

    const existing = await db.query(
      "SELECT reaction FROM pdf_reactions WHERE pdf_id=$1 AND student_id=$2",
      [pdf_id, sid]
    );

    if (existing.rows.length && existing.rows[0].reaction === reaction) {
      await db.query("DELETE FROM pdf_reactions WHERE pdf_id=$1 AND student_id=$2", [pdf_id, sid]);
    } else {
      await db.query(
        `INSERT INTO pdf_reactions (pdf_id, student_id, reaction) VALUES ($1,$2,$3)
         ON CONFLICT (pdf_id, student_id) DO UPDATE SET reaction=$3, created_at=NOW()`,
        [pdf_id, sid, reaction]
      );
    }

    const counts = await db.query(
      `SELECT
         COALESCE((SELECT COUNT(*) FROM pdf_reactions WHERE pdf_id=$1 AND reaction='like'),0)    AS like_count,
         COALESCE((SELECT COUNT(*) FROM pdf_reactions WHERE pdf_id=$1 AND reaction='dislike'),0) AS dislike_count`,
      [pdf_id]
    );
    const mine = await db.query(
      "SELECT reaction FROM pdf_reactions WHERE pdf_id=$1 AND student_id=$2",
      [pdf_id, sid]
    );

    res.json({
      like_count:    parseInt(counts.rows[0].like_count),
      dislike_count: parseInt(counts.rows[0].dislike_count),
      my_reaction:   mine.rows[0]?.reaction || null,
    });
  } catch (err) {
    console.error("reactToPdf error:", err);
    serverError(res, err);
  }
};

// ── STUDENT: RECORD A VIEW ────────────────────────────────
// POST /api/vault/pdfs/:pdf_id/view
// Counts distinct students who've viewed it (one view per student, so
// refreshing/reopening doesn't inflate the number).
exports.viewPdf = async (req, res) => {
  try {
    const { pdf_id } = req.params;
    const sid        = req.student.id;

    await db.query(
      `INSERT INTO pdf_views (pdf_id, student_id) VALUES ($1,$2)
       ON CONFLICT (pdf_id, student_id) DO NOTHING`,
      [pdf_id, sid]
    );

    const r = await db.query("SELECT COUNT(*) FROM pdf_views WHERE pdf_id=$1", [pdf_id]);
    res.json({ view_count: parseInt(r.rows[0].count) });
  } catch (err) {
    console.error("viewPdf error:", err);
    serverError(res, err);
  }
};
