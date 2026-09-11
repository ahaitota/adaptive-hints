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
const MIN_COVERAGE = 0.34;

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
 */
function termCoverage(db, terms, excludeSessionId) {
    const totalSessions = db
        .prepare(`SELECT COUNT(DISTINCT session_id) AS n FROM search_index`)
        .get().n || 1;

    const bySession = new Map();
    const idf = new Map();

    for (const term of terms) {
        const rows = db
            .prepare(`SELECT DISTINCT session_id FROM search_index WHERE search_index MATCH ?`)
            .all(`"${term}"`);
        // Document frequency at session granularity, which is the unit we rank.
        const df = rows.length;
        idf.set(term, Math.log(1 + (totalSessions - df + 0.5) / (df + 0.5)));

        for (const r of rows) {
            if (excludeSessionId && r.session_id === excludeSessionId) continue;
            if (!bySession.has(r.session_id)) bySession.set(r.session_id, new Set());
            bySession.get(r.session_id).add(term);
        }
    }
    return { bySession, idf };
}

function parseTs(value) {
    if (!value) return 0;
    const s = String(value);
    const normalized = s.includes("T") ? s : s.replace(" ", "T") + "Z";
    const ms = Date.parse(normalized);
    return Number.isFinite(ms) ? ms : 0;
}

function recencyWeight(updatedAtMs) {
    if (!updatedAtMs) return 0.2;
    const ageDays = (Date.now() - updatedAtMs) / 86_400_000;
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
export function generateCandidates({ task, excludeSessionId, files = [], repository } = {}) {
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

        const { bySession: coverage, idf } = termCoverage(db, terms, excludeSessionId);
        const totalWeight = terms.reduce((s, t) => s + (idf.get(t) ?? 0), 0);

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

        const maxStrength = Math.max(...[...bySession.values()].map((v) => v.strength)) || 1;

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
            const cov = totalWeight > 0 ? matchedWeight / totalWeight : 0;

            // A candidate sharing one incidental rare word is not related.
            if (cov < MIN_COVERAGE) {
                droppedLowCoverage++;
                continue;
            }

            const m = meta.get(sessionId) || {};
            const sessionFiles = filesBySession.get(sessionId) || new Set();
            // Coverage dominates; normalized bm25 only orders equals.
            const textScore = Math.min(1, 0.75 * cov + 0.25 * (hit.strength / maxStrength));
            const fileOverlap = wanted.size ? jaccard(wanted, sessionFiles) : 0;
            const recency = recencyWeight(parseTs(m.updated_at));
            const sameRepo = repository && m.repository === repository ? 0.08 : 0;

            // When no current files are known the overlap term carries no
            // information, so its weight is folded back into text rather than
            // silently penalising every candidate.
            const base = wanted.size ? 0.65 * textScore + 0.35 * fileOverlap : textScore;
            // Recency modulates rather than dominates: a strong old match still
            // beats a weak fresh one.
            const retrievalScore = Math.min(1, (base * (0.55 + 0.45 * recency)) + sameRepo);

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
