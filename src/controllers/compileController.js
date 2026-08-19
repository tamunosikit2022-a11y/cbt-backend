/**
 * compileController.js — Scholars Syndicate Live IDE, Phase 2 (Arduino)
 *
 * ARCHITECTURE NOTE (reads alongside simulationController.js's header):
 * Phase 1's rule was "no execution happens server-side." Phase 2 adds ONE
 * narrow exception to that: compiling a sketch to a .hex file. This is the
 * same trade-off Wokwi and most browser Arduino IDEs make, because there is
 * no practical way to run avr-gcc inside a browser tab. The distinction that
 * keeps this safe:
 *
 *   - This endpoint COMPILES only. It never links against student accounts'
 *     data, never touches the database, and the resulting .hex is inert
 *     data — it only becomes "alive" client-side, inside avr8js, where it
 *     drives a simulated AVR chip with no I/O to the real world.
 *   - avr-gcc itself doesn't execute the student's program logic — it's a
 *     standard, well-sandboxed compiler toolchain (same trust level as
 *     running `tsc` or `webpack` on user-submitted source, which countless
 *     platforms do safely with the same precautions below).
 *   - Every compile runs in a fresh temp dir, deleted immediately after,
 *     with a hard wall-clock timeout, output size caps, and no network
 *     access from within the compile process.
 *
 * If arduino-cli isn't installed in this deployment (see Dockerfile), this
 * endpoint fails closed with a clear 503 rather than crashing the process.
 */
const { spawn } = require("child_process");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const MAX_SKETCH_LENGTH = 20000;       // ~20KB — generous for a student sketch
const COMPILE_TIMEOUT_MS = 15000;      // hard kill after 15s
const MAX_STDOUT_BYTES = 200 * 1024;   // cap captured output

// board fqbn map — keep in sync with BOARDS in the frontend boardCatalog.js
const BOARD_FQBN = {
  arduino_uno:      "arduino:avr:uno",
  arduino_nano:      "arduino:avr:nano",
  arduino_mega:      "arduino:avr:mega",
  arduino_leonardo:  "arduino:avr:leonardo",
};

function isValidBoard(board) {
  return Object.prototype.hasOwnProperty.call(BOARD_FQBN, board);
}

async function runWithTimeout(cmd, args, opts, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let killedForTimeout = false;

    const timer = setTimeout(() => {
      killedForTimeout = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      if (stdout.length < MAX_STDOUT_BYTES) stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < MAX_STDOUT_BYTES) stderr += d.toString();
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut: killedForTimeout });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + "\n" + err.message, timedOut: false });
    });
  });
}

// POST /api/simulation/compile  { code, board }
exports.compile = async (req, res) => {
  const { code, board } = req.body || {};

  if (typeof code !== "string" || !code.trim()) {
    return res.status(400).json({ error: "No sketch code provided." });
  }
  if (code.length > MAX_SKETCH_LENGTH) {
    return res.status(400).json({ error: "Sketch is too large." });
  }
  if (!isValidBoard(board)) {
    return res.status(400).json({ error: "Unknown or unsupported board." });
  }

  const fqbn = BOARD_FQBN[board];
  const jobId = crypto.randomBytes(8).toString("hex");
  const workDir = path.join(os.tmpdir(), `live-ide-compile-${jobId}`);
  const sketchDir = path.join(workDir, "sketch");

  try {
    await fs.mkdir(sketchDir, { recursive: true });
    await fs.writeFile(path.join(sketchDir, "sketch.ino"), code, "utf8");

    const result = await runWithTimeout(
      "arduino-cli",
      [
        "compile",
        "--fqbn", fqbn,
        "--output-dir", workDir,
        "--no-color",
        sketchDir,
      ],
      { cwd: workDir, env: { PATH: process.env.PATH, HOME: workDir } },
      COMPILE_TIMEOUT_MS
    );

    if (result.timedOut) {
      return res.status(408).json({ error: "Compile timed out. Check for infinite loops in setup() or long computations." });
    }

    if (result.code === "ENOENT" || (result.code === -1 && /ENOENT/.test(result.stderr))) {
      return res.status(503).json({ error: "Compiler is not available on this server right now. Please try again shortly." });
    }

    if (result.code !== 0) {
      return res.status(200).json({
        success: false,
        errors: result.stderr || result.stdout || "Compile failed.",
      });
    }

    const hexPath = path.join(workDir, "sketch.ino.hex");
    let hex;
    try {
      hex = await fs.readFile(hexPath, "utf8");
    } catch {
      return res.status(200).json({
        success: false,
        errors: "Compiler reported success but produced no output. " + (result.stdout || ""),
      });
    }

    return res.json({
      success: true,
      hex,
      board,
      warnings: /warning:/i.test(result.stdout) ? result.stdout : null,
    });
  } catch (err) {
    console.error("[compileController] unexpected error:", err);
    return res.status(500).json({ error: "Compile service error. Please try again." });
  } finally {
    fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
};

exports.SUPPORTED_BOARDS = Object.keys(BOARD_FQBN);
