/**
 * pdfRoutes.js — Cloudinary version
 * Supports PDFs up to 500 MB via disk-buffered upload.
 * Files ≤ 20 MB use memoryStorage (fast), larger use diskStorage then stream.
 */

const express = require("express");
const multer  = require("multer");
const path    = require("path");
const os      = require("os");
const pdf     = require("../controllers/pdfController");

// Disk storage for large files — OS temp dir, cleaned up after upload
const diskUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, os.tmpdir()),
    filename:    (_req, file, cb) => {
      const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
      cb(null, `scholars_pdf_${Date.now()}_${safe}`);
    },
  }),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === "application/pdf") return cb(null, true);
    cb(new Error("Only PDF files are allowed."));
  },
});

// Unified upload middleware: tries disk upload (handles all sizes)
const upload = diskUpload;

// Wrap multer so failures (oversized file, wrong mimetype, aborted upload) return
// a clear JSON error instead of falling through to the generic 500 handler in
// server.js, which previously made every failed upload look like a server crash
// with no indication of what actually went wrong.
function handleUpload(req, res, next) {
  upload.single("pdf")(req, res, (err) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: "File is too large. Maximum size is 500 MB." });
    }
    return res.status(400).json({ error: err.message || "Upload failed." });
  });
}

// ── ADMIN ROUTER (/api/admin/pdfs) ────────────────────────
const adminRouter = express.Router();

adminRouter.get("/stats",            pdf.adminPdfStats);
adminRouter.get("/",                 pdf.adminListPdfs);
adminRouter.post("/upload",          handleUpload, pdf.adminUpload);
adminRouter.delete("/:pdf_id",       pdf.adminDeletePdf);

// ── STUDENT ROUTER (/api/vault/pdfs) ─────────────────────
const studentRouter = express.Router();

studentRouter.get("/",                  pdf.studentListPdfs);
studentRouter.get("/:pdf_id/download",  pdf.studentDownload);
studentRouter.post("/:pdf_id/react",    pdf.reactToPdf);
studentRouter.post("/:pdf_id/view",     pdf.viewPdf);

module.exports = { adminRouter, studentRouter };
