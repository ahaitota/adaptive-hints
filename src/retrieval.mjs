// Phase 2 of the plan: candidate generation from the user's own history.
//
// Reads the Copilot CLI session store READ-ONLY. Three signals, deliberately
// cheap: FTS5 text match, file-path overlap, and recency decay. No embeddings
// — the plan calls for proving the free baseline first.

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

const COPILOT_HOME = process.env.COPILOT_HOME || join(homedir(), ".copilot");
export const DEFAULT_SESSION_STORE = join(COPILOT_HOME, "session-store.db");

// Resolved per call rather than once at import, so switching to a fixture
// database takes effect immediately instead of needing an extension reload.
let storeOverride = null;

/** Point retrieval at a different database. Pass null to restore the real one. */
export function setSessionStore(path) {
    storeOverride = path || null;
}

export function sessionStorePath() {
    return storeOverride || DEFAULT_SESSION_STORE;
}

/** Kept as a named export for callers that only want the current path. */
export const SESSION_STORE = DEFAULT_SESSION_STORE;

const HALF_LIFE_DAYS = 14;

// A candidate must share at least this fraction of the query's terms. Guards
// against a single incidental rare word producing a confident-looking hint.
//
// 0.30 rather than the 0.34 it was, or the 0.20 the fixtures argued for.
// The fixtures showed a large gain from 0.20 (A2 42% -> 76%), but a read-only
// check against the real session store showed the opposite: recall on real
// sentences is flat at every setting because genuine matches land above 90%,
// while off-topic questions started producing cards (0 of 8 at 0.30, 3 of 8 at
// 0.20). The fixture gain is on synthetic paraphrases; the cost is on real
// data, so the real data wins. See test/tune-real.mjs.
//
// Adjustable only so the threshold can be swept and measured offline. Nothing
// in the extension calls setMinCoverage(), so live behaviour is exactly
// DEFAULT_MIN_COVERAGE.
export const DEFAULT_MIN_COVERAGE = 0.30;
let minCoverageValue = DEFAULT_MIN_COVERAGE;

export function setMinCoverage(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 1) {
        throw new RangeError(`minCoverage must be between 0 and 1, got ${value}`);
    }
    minCoverageValue = n;
}

export function minCoverage() {
    return minCoverageValue;
}

// How much of the coverage score comes from terms found together in ONE
// message, versus terms found anywhere in the session.
//
//   0 = anywhere in the session (the original behaviour)
//   1 = a single message must carry the whole question
//
// Set from measurement, not taste — see test/sweep-coverage.mjs.
export const DEFAULT_COVERAGE_FOCUS = 0.5;
let coverageFocusValue = DEFAULT_COVERAGE_FOCUS;

export function setCoverageFocus(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 1) {
        throw new RangeError(`coverageFocus must be between 0 and 1, got ${value}`);
    }
    coverageFocusValue = n;
}

export function coverageFocus() {
    return coverageFocusValue;
}

// A question must contain at least one word that is not near-universal, or it
// carries no information about which session is wanted.
//
// Measured on the fixtures: the rarest word of a genuine question appears in at
// most 10% of sessions, while a question built only from common words bottoms
// out at 56%. Anything in that gap separates them; 40% leaves room for real
// data, where vocabulary is narrower than in the fixtures.
//
// KNOWN LIMIT, measured against the real store in test/rarity-real.mjs: this
// only catches questions built entirely from universal words. A natural but
// empty sentence — "can you check that part again and look at the changes" —
// passes, because one ordinary word like "changes" is enough. Five frequency
// measures were tested as a discriminator and none separates real questions
// from empty ones on a single-subject corpus. That gap is an artefact of the
// fixtures having ten unrelated topics, and it does not exist in real data.
export const DEFAULT_MIN_RARITY = 0.40;
let minRarityValue = DEFAULT_MIN_RARITY;

export function setMinRarity(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 1) {
        throw new RangeError(`minRarity must be between 0 and 1, got ${value}`);
    }
    minRarityValue = n;
}

export function minRarity() {
    return minRarityValue;
}

// How hard to penalise a session for being much larger than its competitors.
//
// Two sessions can cover a question equally well while one is a focused note
// and the other a 160-message thread that happens to contain the same sentence.
// Coverage cannot separate them — both reach 100% — so size breaks the tie.
// Applied relative to the median candidate, so it only fires on real outliers
// and never penalises a whole result set uniformly.
export const DEFAULT_SIZE_PENALTY = 0.20;
let sizePenaltyValue = DEFAULT_SIZE_PENALTY;

export function setSizePenalty(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 1) {
        throw new RangeError(`sizePenalty must be between 0 and 1, got ${value}`);
    }
    sizePenaltyValue = n;
}

export function sizePenalty() {
    return sizePenaltyValue;
}

// BM25 has no upper bound, so it must be squashed into 0..1 before it can be
// mixed with coverage. It used to be divided by the largest value in the same
// result set, which destroyed the only thing it knew: HOW strong the match was.
// Measured on the fixtures — a real sentence's best hit scores about 32.9, an
// unanswerable question's best hit about 5.4, and dividing by the result-set
// maximum turned both into exactly 1.0.
//
// s / (s + k) squashes any score without looking at the other results, so a
// weak best-of-a-bad-bunch stays weak. k is the score that maps to 0.5.
export const DEFAULT_BM25_SATURATION = 8;
let bm25SaturationValue = DEFAULT_BM25_SATURATION;

export function setBm25Saturation(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) {
        throw new RangeError(`bm25Saturation must be greater than 0, got ${value}`);
    }
    bm25SaturationValue = n;
}

export function bm25Saturation() {
    return bm25SaturationValue;
}

// Require the question's single most distinctive word to actually be matched.
//
// Coverage is a ratio, so a question can reach the cutoff on its supporting
// words while the one word that identifies the subject is missing entirely:
// "what paperwork is needed to adopt a rescue greyhound" matched
// [paperwork, adopt, rescue] against a software session and reported 29%,
// with "greyhound" — the only word that meant anything — absent.
export const DEFAULT_REQUIRE_KEY_TERM = true;
let requireKeyTermValue = DEFAULT_REQUIRE_KEY_TERM;

export function setRequireKeyTerm(value) {
    requireKeyTermValue = Boolean(value);
}

export function requireKeyTerm() {
    return requireKeyTermValue;
}

const STOPWORDS = new Set([
    "the", "and", "for", "you", "your", "with", "this", "that", "from", "have", "has", "was", "were",
    "can", "could", "would", "should", "what", "when", "where", "which", "how", "why", "are", "but",
    "not", "all", "any", "its", "it's", "into", "them", "they", "then", "than", "there", "here",
    "please", "make", "made", "get", "got", "let", "like", "just", "some", "more", "want", "need",
    "about", "also", "will", "does", "did", "doing", "been", "being", "very", "much", "one", "two",
]);

let DatabaseSync = null;
try {
    ({ DatabaseSync } = await import("node:sqlite"));
} catch {
    // Older runtime without node:sqlite. Retrieval degrades to "no candidates"
    // rather than taking the whole extension down.
}

export function storeAvailable() {
    return Boolean(DatabaseSync) && existsSync(sessionStorePath());
}

/** Extract the meaningful search terms from free text. */
export function extractTerms(text, maxTerms = 12) {
    const seen = new Set();
    const terms = [];
    for (const raw of String(text || "").toLowerCase().split(/[^a-z0-9_]+/)) {
        if (raw.length < 3 || STOPWORDS.has(raw) || seen.has(raw)) continue;
        seen.add(raw);
        terms.push(raw);
        if (terms.length >= maxTerms) break;
    }
    return terms;
}

/** Turn free text into a safe FTS5 OR-query. */
export function toFtsQuery(text, maxTerms = 12) {
    const terms = extractTerms(text, maxTerms);
    if (!terms.length) return null;
    return terms.map((t) => `"${t}"`).join(" OR ");
}

/**
 * Per-session matched terms plus each term's inverse document frequency.
 *
 * BM25 magnitude is NOT an absolute relevance measure — it rewards rare terms,
 * so a nonsense query containing one unusual word can outscore a genuinely
 * related one. Coverage is absolute and interpretable, which also makes the
 * "N% match" shown to the user mean something.
 *
 * Coverage is IDF-weighted rather than a plain count, because counting terms
 * equally lets filler carry the score. Measured case: a query for
 * "fts / dense / retrieval / bm25" scored 67% while every topic-defining term
 * missed — the matches were "use", "show", "exactly", "these".
 *
 * Two coverages are returned per session:
 *
 *   spread  — the terms found anywhere in the session, in any combination of
 *             messages. This is what the session-level union gives, and it is
 *             what a very long session exploits: a 320-message thread contains
 *             every common word somewhere, so it reports 100% for a question
 *             it has nothing to do with.
 *   focused — the terms found together in a single indexed message. A session
 *             that genuinely discussed the subject says most of it in one
 *             place; a long session that merely accumulated the words does not.
 *
 * The index stores one row per message, so this costs no extra queries.
 */
function termCoverage(db, terms, excludeSessionId) {
    const totalSessions = db
        .prepare(`SELECT COUNT(DISTINCT session_id) AS n FROM search_index`)
        .get().n || 1;

    const bySession = new Map();
    const byChunk = new Map();
    const idf = new Map();
    const dfRatio = new Map();

    for (const term of terms) {
        const rows = db
            .prepare(`SELECT rowid AS chunk, session_id FROM search_index WHERE search_index MATCH ?`)
            .all(`"${term}"`);
        // Document frequency stays at session granularity, which is the unit we
        // rank: a word repeated 50 times in one thread is not a common word.
        const sessions = new Set(rows.map((r) => r.session_id));
        const df = sessions.size;
        idf.set(term, Math.log(1 + (totalSessions - df + 0.5) / (df + 0.5)));
        dfRatio.set(term, df / totalSessions);

        for (const r of rows) {
            if (excludeSessionId && r.session_id === excludeSessionId) continue;
            if (!bySession.has(r.session_id)) bySession.set(r.session_id, new Set());
            bySession.get(r.session_id).add(term);
            if (!byChunk.has(r.chunk)) byChunk.set(r.chunk, { sessionId: r.session_id, terms: new Set() });
            byChunk.get(r.chunk).terms.add(term);
        }
    }

    // The single best message per session, by the same IDF weighting.
    const bestChunk = new Map();
    for (const { sessionId, terms: found } of byChunk.values()) {
        const weight = [...found].reduce((s, t) => s + (idf.get(t) ?? 0), 0);
        const prev = bestChunk.get(sessionId);
        if (!prev || weight > prev.weight) bestChunk.set(sessionId, { weight, terms: found });
    }

    return { bySession, bestChunk, idf, dfRatio, totalSessions };
}

function parseTs(value) {
    if (!value) return 0;
    const s = String(value);
    const normalized = s.includes("T") ? s : s.replace(" ", "T") + "Z";
    const ms = Date.parse(normalized);
    return Number.isFinite(ms) ? ms : 0;
}

function recencyWeight(updatedAtMs, now) {
    if (!updatedAtMs) return 0.2;
    const ageDays = (now - updatedAtMs) / 86_400_000;
    return Math.pow(0.5, Math.max(0, ageDays) / HALF_LIFE_DAYS);
}

function jaccard(a, b) {
    if (!a.size || !b.size) return 0;
    let inter = 0;
    for (const v of a) if (b.has(v)) inter++;
    return inter / (a.size + b.size - inter);
}

function normalizePath(p) {
    return String(p).replace(/\\/g, "/").toLowerCase();
}

function openDb() {
    // Read-only so we never contend with the live CLI writer.
    return new DatabaseSync(sessionStorePath(), { readOnly: true });
}

/**
 * Generate scored candidate prior sessions for a task description.
 *
 * @param {object} opts
 * @param {string} opts.task        Free-text description of what the user is doing now.
 * @param {string} [opts.excludeSessionId] Current session, never suggest itself.
 * @param {string[]} [opts.files]   Files in play now, enables the overlap signal.
 * @param {string} [opts.repository] Current repo, used as a mild affinity bonus.
 */
export function generateCandidates({ task, excludeSessionId, files = [], repository, now = Date.now() } = {}) {
    if (!storeAvailable()) return { candidates: [], reason: "session_store_unavailable" };
    const terms = extractTerms(task);
    const match = terms.length ? terms.map((t) => `"${t}"`).join(" OR ") : null;
    if (!match) return { candidates: [], reason: "task_too_short" };

    const db = openDb();
    try {
        const rows = db
            .prepare(
                `SELECT session_id, source_type, content, bm25(search_index) AS rank
                 FROM search_index
                 WHERE search_index MATCH ?
                 ORDER BY rank
                 LIMIT 300`,
            )
            .all(match);

        const { bySession: coverage, bestChunk, idf, dfRatio } = termCoverage(db, terms, excludeSessionId);
        const totalWeight = terms.reduce((s, t) => s + (idf.get(t) ?? 0), 0);

        // A question of nothing but near-universal words cannot identify a
        // session. Without this, a long enough session contains all of them and
        // reports a confident "100% match" for a question about nothing.
        const rarest = Math.min(...terms.map((t) => dfRatio.get(t) ?? 0));
        if (rarest >= minRarityValue) {
            return { candidates: [], reason: "task_too_generic" };
        }

        // The word carrying the most information about what is being asked.
        // A candidate that misses it is matching the scaffolding of the
        // question rather than its subject.
        let keyTerm = null, keyWeight = -1;
        for (const t of terms) {
            const w = idf.get(t) ?? 0;
            if (w > keyWeight) { keyWeight = w; keyTerm = t; }
        }

        // bm25 is kept only as a tie-breaker within the result set; coverage
        // is what decides whether a candidate is related at all.
        const bySession = new Map();
        for (const r of rows) {
            if (excludeSessionId && r.session_id === excludeSessionId) continue;
            const strength = -Number(r.rank);
            const prev = bySession.get(r.session_id);
            if (!prev || strength > prev.strength) {
                bySession.set(r.session_id, {
                    sessionId: r.session_id,
                    strength,
                    snippet: String(r.content || "").replace(/\s+/g, " ").trim(),
                    sourceType: r.source_type,
                });
            }
        }
        if (!bySession.size) return { candidates: [], reason: "no_text_match" };

        const wanted = new Set(files.map(normalizePath));
        const ids = [...bySession.keys()];
        const placeholders = ids.map(() => "?").join(",");

        const metaRows = db
            .prepare(
                `SELECT id, repository, branch, summary, cwd, updated_at
                 FROM sessions WHERE id IN (${placeholders})`,
            )
            .all(...ids);
        const meta = new Map(metaRows.map((m) => [m.id, m]));

        // Session size, used only to break ties between candidates that cover
        // the question equally well. Measured in indexed messages rather than
        // characters so one enormous message does not count as a long thread.
        const sizeRows = db
            .prepare(
                `SELECT session_id, COUNT(*) AS chunks FROM search_index
                 WHERE session_id IN (${placeholders}) GROUP BY session_id`,
            )
            .all(...ids);
        const chunksBySession = new Map(sizeRows.map((s) => [s.session_id, s.chunks]));
        const sortedSizes = [...chunksBySession.values()].sort((a, b) => a - b);
        const medianChunks = sortedSizes.length
            ? sortedSizes[Math.floor(sortedSizes.length / 2)] || 1
            : 1;

        const fileRows = db
            .prepare(`SELECT session_id, file_path FROM session_files WHERE session_id IN (${placeholders})`)
            .all(...ids);
        const filesBySession = new Map();
        for (const f of fileRows) {
            if (!filesBySession.has(f.session_id)) filesBySession.set(f.session_id, new Set());
            filesBySession.get(f.session_id).add(normalizePath(f.file_path));
        }

        const cpRows = db
            .prepare(
                `SELECT session_id, title, next_steps, created_at
                 FROM checkpoints
                 WHERE session_id IN (${placeholders}) AND next_steps IS NOT NULL AND next_steps <> ''
                 ORDER BY checkpoint_number DESC`,
            )
            .all(...ids);
        const nextStepsBySession = new Map();
        for (const c of cpRows) if (!nextStepsBySession.has(c.session_id)) nextStepsBySession.set(c.session_id, c);

        const candidates = [];
        let droppedLowCoverage = 0;
        for (const [sessionId, hit] of bySession) {
            const matchedSet = coverage.get(sessionId) ?? new Set();
            const matched = matchedSet.size;
            // Weight by IDF so topic-defining words dominate and filler cannot
            // carry a candidate over the threshold on its own.
            const matchedWeight = [...matchedSet].reduce((s, t) => s + (idf.get(t) ?? 0), 0);
            const spreadCov = totalWeight > 0 ? matchedWeight / totalWeight : 0;
            // A very long session accumulates the words of every question
            // without ever discussing any of them. Requiring part of the match
            // to land in one message is what separates "this was discussed" from
            // "these words occur somewhere in 320 messages".
            const focusedWeight = bestChunk.get(sessionId)?.weight ?? 0;
            const focusedCov = totalWeight > 0 ? focusedWeight / totalWeight : 0;
            const cov = coverageFocusValue * focusedCov + (1 - coverageFocusValue) * spreadCov;

            // A candidate sharing one incidental rare word is not related.
            if (cov < minCoverageValue) {
                droppedLowCoverage++;
                continue;
            }

            // ...and a candidate missing the question's key word is matching
            // its scaffolding. Skipped when the key word appears nowhere in the
            // store, since then no candidate could ever have it.
            if (requireKeyTermValue && keyTerm && !matchedSet.has(keyTerm)
                && (dfRatio.get(keyTerm) ?? 0) > 0) {
                droppedLowCoverage++;
                continue;
            }

            const m = meta.get(sessionId) || {};
            const sessionFiles = filesBySession.get(sessionId) || new Set();
            // Coverage dominates; bm25 only orders equals. Saturated rather
            // than scaled to the result-set maximum, so "best of a weak field"
            // stays weak instead of being promoted to a perfect 1.0.
            const bm25Score = hit.strength > 0
                ? hit.strength / (hit.strength + bm25SaturationValue)
                : 0;
            const textScore = Math.min(1, 0.75 * cov + 0.25 * bm25Score);
            const fileOverlap = wanted.size ? jaccard(wanted, sessionFiles) : 0;
            const recency = recencyWeight(parseTs(m.updated_at), now);
            const sameRepo = repository && m.repository === repository ? 0.08 : 0;

            // Size only separates candidates that already cover the question
            // equally well. Relative to the median candidate and capped at one
            // order of magnitude, so an ordinary session is untouched and only a
            // genuine outlier — the 160-message thread — gives ground to a
            // focused note that says the same thing.
            const chunks = chunksBySession.get(sessionId) || 1;
            const oversize = Math.min(1, Math.max(0, Math.log10(chunks / medianChunks)));
            const sizeFactor = 1 - sizePenaltyValue * oversize;

            // When no current files are known the overlap term carries no
            // information, so its weight is folded back into text rather than
            // silently penalising every candidate.
            const base = wanted.size ? 0.65 * textScore + 0.35 * fileOverlap : textScore;
            // Recency modulates rather than dominates: a strong old match still
            // beats a weak fresh one.
            const retrievalScore = Math.min(1, (base * sizeFactor * (0.55 + 0.45 * recency)) + sameRepo);

            candidates.push({
                sessionId,
                retrievalScore,
                textScore,
                coverage: cov,
                matchedTerms: matched,
                totalTerms: terms.length,
                fileOverlap,
                recency,
                sameRepo: Boolean(sameRepo),
                snippet: hit.snippet.slice(0, 240),
                sourceType: hit.sourceType,
                summary: m.summary || null,
                repository: m.repository || null,
                branch: m.branch || null,
                updatedAt: m.updated_at || null,
                fileCount: sessionFiles.size,
                sampleFiles: [...sessionFiles].slice(0, 5),
                nextSteps: nextStepsBySession.get(sessionId)?.next_steps || null,
                checkpointTitle: nextStepsBySession.get(sessionId)?.title || null,
            });
        }

        candidates.sort((a, b) => b.retrievalScore - a.retrievalScore);
        const reason = candidates.length ? null : (droppedLowCoverage ? "below_min_coverage" : "no_text_match");
        return { candidates: candidates.slice(0, 25), reason, droppedLowCoverage };
    } finally {
        db.close();
    }
}

/**
 * Load the useful content of a prior session, for when a user accepts a hint
 * pointing at it. Bounded on purpose: this gets injected into a live
 * conversation, so it must be a briefing, not a transcript dump.
 */
export function fetchSessionContext(sessionId, { maxTurns = 4 } = {}) {
    if (!storeAvailable()) return null;
    const db = openDb();
    try {
        const meta = db
            .prepare(`SELECT id, repository, branch, summary, cwd, created_at, updated_at FROM sessions WHERE id = ?`)
            .get(sessionId);
        if (!meta) return null;

        const checkpoint = db
            .prepare(
                `SELECT title, overview, work_done, technical_details, important_files, next_steps
                 FROM checkpoints WHERE session_id = ?
                 ORDER BY checkpoint_number DESC LIMIT 1`,
            )
            .get(sessionId);

        const firstTurn = db
            .prepare(`SELECT user_message FROM turns WHERE session_id = ? ORDER BY turn_index ASC LIMIT 1`)
            .get(sessionId);

        const lastTurns = db
            .prepare(
                `SELECT turn_index, user_message, assistant_response
                 FROM turns WHERE session_id = ? ORDER BY turn_index DESC LIMIT ?`,
            )
            .all(sessionId, maxTurns);

        const files = db
            .prepare(`SELECT file_path FROM session_files WHERE session_id = ? LIMIT 15`)
            .all(sessionId)
            .map((r) => r.file_path);

        const clip = (s, n) => (s ? String(s).replace(/\s+/g, " ").trim().slice(0, n) : null);

        return {
            sessionId,
            repository: meta.repository,
            branch: meta.branch,
            summary: meta.summary,
            updatedAt: meta.updated_at,
            originalRequest: clip(firstTurn?.user_message, 400),
            checkpoint: checkpoint
                ? {
                    title: checkpoint.title,
                    overview: clip(checkpoint.overview, 700),
                    workDone: clip(checkpoint.work_done, 700),
                    technical: clip(checkpoint.technical_details, 700),
                    importantFiles: clip(checkpoint.important_files, 400),
                    nextSteps: clip(checkpoint.next_steps, 700),
                }
                : null,
            files,
            recentTurns: lastTurns.reverse().map((t) => ({
                turn: t.turn_index,
                user: clip(t.user_message, 250),
                assistant: clip(t.assistant_response, 400),
            })),
        };
    } finally {
        db.close();
    }
}
/** Turn scored sessions into typed hint candidates (Phase 0 taxonomy). */
export function buildHintCandidates(candidates, { files = [] } = {}) {
    const hints = [];
    for (const c of candidates) {
        const label = c.summary
            ? c.summary.replace(/\s+/g, " ").trim().slice(0, 90)
            : c.snippet.slice(0, 90);
        // Report coverage, not the composite score: "% match" should mean
        // something the user can check, i.e. how much of their query this
        // prior session actually covers.
        const pct = Math.round(c.coverage * 100);

        hints.push({
            type: "reuse_chat",
            title: "Reuse related Copilot chat",
            body: `Similar to prior Copilot Chat "${label}…" (${pct}% match, ${c.matchedTerms}/${c.totalTerms} terms). Reuse its decisions, validation steps, and pitfalls.`,
            score: c.retrievalScore,
            evidence: {
                sessionId: c.sessionId, kind: "text",
                textScore: c.textScore, coverage: c.coverage, recency: c.recency,
            },
            action: { kind: "open_prior_session", sessionId: c.sessionId },
        });

        if (files.length && c.fileOverlap > 0.05) {
            // Absolute paths are unreadable in a card; the tail is what
            // identifies a file to a human.
            const short = (p) => String(p ?? "").split(/[\\/]/).slice(-2).join("/");
            hints.push({
                type: "reuse_file_scope",
                title: "Reuse prior file scope",
                body: `A prior session touched ${c.fileCount} overlapping file(s) (${Math.round(c.fileOverlap * 100)}% overlap), including ${short(c.sampleFiles[0]) || "n/a"}. Start from that scope instead of rediscovering it.`,
                // File overlap is a precision signal: when it fires it is
                // usually right, so it is allowed to outrank a pure text match.
                score: Math.min(1, c.retrievalScore * 0.6 + c.fileOverlap * 0.6),
                evidence: {
                    sessionId: c.sessionId, kind: "files",
                    textScore: c.textScore, coverage: c.coverage, recency: c.recency,
                    fileOverlap: c.fileOverlap, files: c.sampleFiles,
                },
                action: { kind: "load_file_scope", sessionId: c.sessionId, files: c.sampleFiles },
            });
        }

        if (c.nextSteps) {
            const steps = String(c.nextSteps).replace(/\s+/g, " ").trim().slice(0, 160);
            hints.push({
                type: "resume_next_steps",
                title: "Resume unfinished next steps",
                body: `A prior checkpoint${c.checkpointTitle ? ` ("${c.checkpointTitle}")` : ""} left next steps that match this task: ${steps}…`,
                score: Math.min(1, c.retrievalScore * 0.9),
                // Carry the same fields as every other type so the "Why this?"
                // panel can explain this hint instead of rendering blanks.
                evidence: {
                    sessionId: c.sessionId, kind: "checkpoint",
                    textScore: c.textScore, coverage: c.coverage, recency: c.recency,
                    fileOverlap: c.fileOverlap, checkpointTitle: c.checkpointTitle,
                },
                action: { kind: "resume_next_steps", sessionId: c.sessionId, nextSteps: steps },
            });
        }
    }
    hints.sort((a, b) => b.score - a.score);
    return hints;
}
