/**
 * Shared AI Provider — Scholars Syndicate
 * ─────────────────────────────────────────
 * Groq is primary (fast, generous free tier for chat). Gemini is the
 * fallback: if Groq errors with something retryable (rate limit, timeout,
 * 5xx), we automatically retry the same request on Gemini instead of
 * failing the user's request outright. This is what actually "reduces
 * stress on Groq" — traffic spills over instead of piling up on one key.
 *
 * Every controller that talks to an LLM should go through chatCompletion()
 * here instead of instantiating its own Groq/Gemini client, so the
 * fallback behavior is consistent everywhere.
 *
 * TASK-AWARE LOAD BALANCING: pass `taskType` to steer which provider goes
 * first, instead of always hitting Groq first. 'tutor'/'explain' (longer,
 * more reasoning-heavy replies) try Gemini first; everything else
 * ('quick', 'compile', or omitted) tries Groq first, same as before. This
 * is purely a default request enhancement — either provider still falls
 * back to the other automatically on a retryable error either way.
 */
const Groq = require('groq-sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ── Lazy client init (missing key only fails at call time, not startup) ──
let _groq = null;
function getGroq() {
  if (!_groq) {
    if (!process.env.GROQ_API_KEY) throw new Error('GROQ_API_KEY environment variable is not set.');
    _groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  }
  return _groq;
}

let _gemini = null;
function getGemini() {
  if (!_gemini) {
    if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY environment variable is not set.');
    _gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  }
  return _gemini;
}

// Configurable so a model rename/deprecation on Google's side is a one-line
// env change, not a code change. gemini-2.5-flash is GA and free-tier
// friendly as of mid-2026 — worth checking Google AI Studio periodically
// since Google deprecates Gemini models fairly often.
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

// Only fail over on errors that indicate Groq is overloaded/unavailable/
// unusable — NOT on 4xx errors like a malformed prompt, which would just
// fail the same way on Gemini and waste a round trip.
//
// FIX (Gemini key set but AI features still fail): getGroq() throws a
// plain `Error('GROQ_API_KEY environment variable is not set.')` — a
// synchronous config error with no `.status`/`.response`/`.code` at all.
// The original version of this function only checked for HTTP-style
// retryable errors, so a missing/misconfigured Groq key was NEVER
// considered retryable — meaning the Gemini fallback below could never
// fire for that case, no matter how correctly GEMINI_API_KEY was set.
// The whole point of "Gemini is the fallback" breaks exactly when Groq
// is the thing that's actually broken (unset key, revoked key, invalid
// key, decommissioned model returning 400 model_decommissioned). We now
// also fall back to Gemini for Groq auth/config/model errors, not just
// infra-level 5xx/timeouts.
function isRetryableError(err) {
  const status = err?.status || err?.response?.status;
  if ([401, 403, 404, 429, 500, 502, 503, 504].includes(status)) return true;
  if (['ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED'].includes(err?.code)) return true;
  if (err?.code === 'model_decommissioned') return true;
  if (/GROQ_API_KEY|not set|decommissioned|invalid api key/i.test(err?.message || '')) return true;
  return false;
}

/**
 * OpenAI/Groq-style chat completion with automatic Gemini fallback, and
 * optional task-aware provider selection (see `taskType`).
 *
 * @param {Array<{role: 'system'|'user'|'assistant', content: string}>} messages
 * @param {string}  [model]        Groq model to try first
 * @param {number}  [maxTokens]
 * @param {number}  [temperature]
 * @param {boolean} [jsonMode]     Ask for a raw JSON object response
 * @param {string}  [taskType]     'quick'|'compile'|'tutor'|'explain' — 'tutor'/'explain' try Gemini first, everything else tries Groq first (default, unchanged behavior)
 * @returns {Promise<{content: string, tokensUsed: number, provider: 'groq'|'gemini'}>}
 */
async function chatCompletion({
  messages,
  // FIX: Groq announced (17 Jun 2026) that llama-3.1-8b-instant and
  // llama-3.3-70b-versatile — used as defaults/explicit models across this
  // whole app — shut down 16 Aug 2026. Still working today, but every AI
  // feature breaks on that date unless migrated. Using Groq's own
  // recommended replacement now, ahead of time. See:
  // https://console.groq.com/docs/deprecations
  model = 'openai/gpt-oss-20b',
  maxTokens = 1500,
  temperature = 0.7,
  jsonMode = false,
  taskType,
}) {
  const hasGemini = !!process.env.GEMINI_API_KEY;
  const preferGemini = hasGemini && ['tutor', 'explain'].includes(taskType);

  if (preferGemini) {
    try {
      return await _geminiCompletion({ messages, maxTokens, temperature, jsonMode });
    } catch (geminiErr) {
      if (!isRetryableError(geminiErr)) throw geminiErr;
      console.warn(`[aiProvider] Gemini failed (${geminiErr.message}) — falling back to Groq.`);
      // falls through to the normal Groq attempt below
    }
  }

  try {
    const completion = await getGroq().chat.completions.create({
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
    });
    return {
      content: completion.choices[0].message.content,
      tokensUsed: completion.usage?.total_tokens || 0,
      provider: 'groq',
    };
  } catch (groqErr) {
    // Already tried Gemini above and it also failed — don't try it again,
    // surface the original Groq error.
    if (preferGemini) throw groqErr;

    const canFallback = hasGemini && isRetryableError(groqErr);
    if (!canFallback) throw groqErr;

    console.warn(`[aiProvider] Groq failed (${groqErr.message}) — falling back to Gemini.`);
    return await _geminiCompletion({ messages, maxTokens, temperature, jsonMode });
  }
}

// Internal Gemini completion helper — handles message format conversion
// (Groq/OpenAI-style messages array -> Gemini's systemInstruction + history
// + latest-turn shape) so both call sites above share one implementation.
async function _geminiCompletion({ messages, maxTokens, temperature, jsonMode }) {
  const systemMsg = messages.find(m => m.role === 'system')?.content;
  const turns = messages.filter(m => m.role !== 'system');
  const lastUserMessage = turns[turns.length - 1]?.content || '';
  const history = turns.slice(0, -1).map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const geminiModel = getGemini().getGenerativeModel({
    model: GEMINI_MODEL,
    ...(systemMsg ? { systemInstruction: systemMsg } : {}),
    ...(jsonMode ? { generationConfig: { responseMimeType: 'application/json' } } : {}),
  });

  const chat = geminiModel.startChat({ history });
  const result = await chat.sendMessage(lastUserMessage);

  return {
    content: result.response.text(),
    tokensUsed: result.response.usageMetadata?.totalTokenCount || 0,
    provider: 'gemini',
  };
}

module.exports = { chatCompletion, isRetryableError, getGroq, getGemini };
