const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');
const crypto = require('crypto');

admin.initializeApp();
const db = admin.firestore();

// Keep costs predictable and calls fast — this only ever needs to run near Europe/UK.
setGlobalOptions({ region: 'europe-west2', maxInstances: 5 });

const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');

// One player, occasional post-game review — this is a generous ceiling, not a real limit.
const DAILY_LIMIT = 60;

/**
 * explainDeviation — callable function.
 *
 * Input (request.data):
 *   fenBefore    : FEN before the move in question (required)
 *   moveSan      : the move the player actually played, in SAN (required)
 *   bestSan      : the engine/book's preferred move, in SAN (optional)
 *   bestPv       : a short continuation after bestSan, space-separated SAN (optional)
 *   cpBefore     : eval in centipawns before the move, White's perspective (optional)
 *   cpAfter      : eval in centipawns after the move, White's perspective (optional)
 *   userColor    : 'white' | 'black' — whose move this was (optional, for phrasing)
 *   moveNumber   : full-move number (optional, for phrasing)
 *   openingName  : canonical opening name for context (optional)
 *
 * Output: { explanation: string, cached: boolean }
 */
exports.explainDeviation = onCall({ secrets: [ANTHROPIC_API_KEY], cors: true }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in first.');
  }
  const uid = request.auth.uid;
  const {
    fenBefore, moveSan, bestSan, bestPv, cpBefore, cpAfter,
    userColor, moveNumber, openingName
  } = request.data || {};

  if (!fenBefore || typeof fenBefore !== 'string' || !moveSan || typeof moveSan !== 'string') {
    throw new HttpsError('invalid-argument', 'Missing position or move.');
  }

  // ---- Cache first: identical position+move pairs recur constantly across shared openings,
  // so check before spending any of the day's quota. ----
  const cacheId = crypto.createHash('sha256').update(`${fenBefore}|${moveSan}`).digest('hex');
  const cacheRef = db.collection('explanationCache').doc(cacheId);
  const cachedSnap = await cacheRef.get();
  if (cachedSnap.exists) {
    return { explanation: cachedSnap.data().explanation, cached: true };
  }

  // ---- Per-user daily rate limit ----
  const today = new Date().toISOString().slice(0, 10);
  const usageRef = db.collection('users').doc(uid).collection('usage').doc(today);
  const allowed = await db.runTransaction(async (tx) => {
    const snap = await tx.get(usageRef);
    const count = snap.exists ? (snap.data().explainCount || 0) : 0;
    if (count >= DAILY_LIMIT) return false;
    tx.set(usageRef, { explainCount: count + 1 }, { merge: true });
    return true;
  });
  if (!allowed) {
    throw new HttpsError('resource-exhausted', `Daily explanation limit reached (${DAILY_LIMIT}/day) — try again tomorrow.`);
  }

  const promptLines = [
    openingName ? `Opening: ${openingName}` : null,
    `Position before the move (FEN): ${fenBefore}`,
    (moveNumber && userColor) ? `Move ${moveNumber}, ${userColor} to move.` : null,
    `The player played: ${moveSan}`,
    bestSan ? `The engine/book's preferred move was: ${bestSan}${bestPv ? ` (continuing ${bestPv})` : ''}` : null,
    (typeof cpBefore === 'number' && typeof cpAfter === 'number')
      ? `Evaluation went from ${(cpBefore / 100).toFixed(2)} to ${(cpAfter / 100).toFixed(2)} (positive favours White, negative favours Black).`
      : null,
  ].filter(Boolean);

  const systemPrompt = "You are a chess coach explaining one move to an intermediate club player reviewing their own game. "
    + "Given a position (FEN), the move they played, and the engine or book's preferred move, write a short, concrete "
    + "explanation — 2 to 4 sentences, plain prose, no headers or bullet points. Cover: (1) the idea behind the "
    + "preferred move — what it achieves, prevents, or prepares, referencing actual pieces and squares; (2) "
    + "specifically what's worse about the move actually played — a concrete tactical or positional reason, not a "
    + "vague 'it's less accurate'. If the played move only loses a small amount of evaluation, say so plainly rather "
    + "than manufacturing drama. Talk like a coach sitting next to the player, not a computer printout, and don't "
    + "just restate the moves in algebraic notation as your explanation.";

  let anthropicRes;
  try {
    anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY.value().trim(),
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 300,
        system: systemPrompt,
        messages: [{ role: 'user', content: promptLines.join('\n') }],
      }),
    });
  } catch (err) {
    console.error('Network error calling Anthropic', err);
    throw new HttpsError('unavailable', 'Could not reach the explanation service — try again shortly.');
  }

  if (!anthropicRes.ok) {
    const errText = await anthropicRes.text().catch(() => '');
    console.error('Anthropic API error', anthropicRes.status, errText);
    throw new HttpsError('internal', 'Explanation service returned an error — try again shortly.');
  }

  const data = await anthropicRes.json();
  const explanation = (data.content || [])
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
    .trim();

  if (!explanation) {
    throw new HttpsError('internal', 'Got an empty response from the explanation service.');
  }

  await cacheRef.set({
    explanation,
    fenBefore,
    moveSan,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { explanation, cached: false };
});
