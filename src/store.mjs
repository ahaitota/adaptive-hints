// Durable, inspectable outcome log + derived acceptance counters.
//
// Phase 1 of the plan ("Instrumentation") lives here. Everything the ranker
// later learns from is written by this module. The log is append-only JSONL so
// the user can read it, diff it, and delete it without any tooling.
//
// Scope: user-global. The whole point of the system is that it learns across
// sessions, so this must NOT be session-scoped state.

import { mkdirSync, appendFileSync, readFileSync, existsSync, writeFileSync, statSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const COPILOT_HOME = process.env.COPILOT_HOME || join(homedir(), ".copilot");
export const ARTIFACT_DIR = join(COPILOT_HOME, "extensions", "adaptive-hints", "artifacts");
const LOG_PATH = join(ARTIFACT_DIR, "hint-log.jsonl");
const SETTINGS_PATH = join(ARTIFACT_DIR, "settings.json");

let logCache = null;

function ensureDir() {
    mkdirSync(ARTIFACT_DIR, { recursive: true });
}

function append(event) {
    ensureDir();
    appendFileSync(LOG_PATH, JSON.stringify(event) + "\n", "utf8");
}

export function readLog() {
    if (!existsSync(LOG_PATH)) return [];
    // The log is now read on every user prompt, and several callers each want
    // the whole thing. Memoize on (mtime, size) so a single propose pass costs
    // one file read instead of four.
    const st = statSync(LOG_PATH);
    if (logCache && logCache.mtimeMs === st.mtimeMs && logCache.size === st.size) {
        return logCache.events;
    }
    const raw = readFileSync(LOG_PATH, "utf8");
    const out = [];
    for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
            out.push(JSON.parse(line));
        } catch {
            // A truncated final line is expected if the process died mid-write.
            // Skipping is correct; the log is advisory, not transactional.
        }
    }
    logCache = { mtimeMs: st.mtimeMs, size: st.size, events: out };
    return out;
}

// --- settings ------------------------------------------------------------

const DEFAULT_SETTINGS = {
    // Global off switch. Auto-firing hints with no way to stop them is how
    // this class of feature gets disabled wholesale by annoyed users.
    autoPropose: true,
    // Prompts shorter than this are conversational ("yes", "go on") and carry
    // no retrievable task signal.
    minPromptChars: 25,
    // Partial overrides merged into the ranker's DEFAULT_CONFIG on every
    // automatic proposal. Empty means "use the shipped defaults".
    gate: {},
    // Set by `configure({ testMode: true })`. Purely informational, so the
    // panel and stats can flag that the current numbers are from a run with
    // the rate limits switched off.
    testMode: false,
    // Absolute path to an alternative session database, for evaluation runs
    // against a fixture. null means "use the real one".
    //
    // Deliberately narrower than COPILOT_HOME: that moves the learning log and
    // settings too, and needs an app restart. This moves only the corpus being
    // searched, so switching between fixtures takes seconds and the learning
    // history is never touched by a test run.
    sessionStorePath: null,
};

/** Gate overrides that make the system observable while testing. */
export const TEST_MODE_GATE = {
    cooldownMinutes: 0,
    globalCooldownMinutes: 0,
    // Otherwise a test run can land silently in the counterfactual arm and
    // look broken.
    holdoutRate: 0,
};

export function loadSettings() {
    if (!existsSync(SETTINGS_PATH)) return { ...DEFAULT_SETTINGS };
    try {
        return { ...DEFAULT_SETTINGS, ...JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) };
    } catch {
        return { ...DEFAULT_SETTINGS };
    }
}

export function saveSettings(patch) {
    ensureDir();
    const next = { ...loadSettings(), ...patch };
    writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2), "utf8");
    return next;
}

// --- writers -------------------------------------------------------------

/** Every hint actually rendered. Written even if the user never touches it. */
export function logImpression(hint) {
    append({ kind: "impression", at: Date.now(), ...hint });
    return hint.hintId;
}

/**
 * Candidates that were generated but gated out. Without these you cannot
 * evaluate the gate itself, only the hints that survived it.
 */
export function logSuppressed(entry) {
    append({ kind: "suppressed", at: Date.now(), ...entry });
}

/** Trigger points deliberately shown nothing, for the holdout arm. */
export function logHoldout(entry) {
    append({ kind: "holdout", at: Date.now(), ...entry });
}

export function logOutcome(hintId, outcome, extra = {}) {
    append({ kind: "outcome", at: Date.now(), hintId, outcome, ...extra });
}

// --- current proposal (rehydratable panel state) -------------------------
//
// Scoped per session, unlike the learning log. The log is deliberately global
// — learning across sessions is the whole point — but the *active proposal* is
// UI state for one conversation. A single shared file meant whichever session
// fired last took over every open panel, so a chat could display another
// session's task and hints.

const PROPOSAL_DIR = join(ARTIFACT_DIR, "proposals");

function proposalPath(sessionId) {
    const safe = String(sessionId || "unknown").replace(/[^A-Za-z0-9._-]/g, "_");
    return join(PROPOSAL_DIR, `${safe}.json`);
}

export function saveProposal(sessionId, proposal) {
    mkdirSync(PROPOSAL_DIR, { recursive: true });
    writeFileSync(proposalPath(sessionId), JSON.stringify(proposal, null, 2), "utf8");
}

export function loadProposal(sessionId) {
    const p = proposalPath(sessionId);
    if (!existsSync(p)) return null;
    try {
        return JSON.parse(readFileSync(p, "utf8"));
    } catch {
        return null;
    }
}

// --- pending accepted context -------------------------------------------
//
// When a hint is accepted we want the prior session's briefing to reach the
// agent WITHOUT the user seeing a message they did not write. `session.send`
// creates a visible turn, so instead we park the briefing here and hand it to
// the agent through the hook's `additionalContext` on the next prompt — the
// same invisible channel the hint notification already uses.

const PENDING_DIR = join(ARTIFACT_DIR, "pending");

function pendingPath(sessionId) {
    const safe = String(sessionId || "unknown").replace(/[^A-Za-z0-9._-]/g, "_");
    return join(PENDING_DIR, `${safe}.json`);
}

export function queueAcceptedContext(sessionId, text) {
    mkdirSync(PENDING_DIR, { recursive: true });
    const p = pendingPath(sessionId);
    let queue = [];
    if (existsSync(p)) {
        try {
            queue = JSON.parse(readFileSync(p, "utf8"));
        } catch {
            queue = [];
        }
    }
    queue.push({ at: Date.now(), text });
    // Bounded: a briefing the user accepted five prompts ago is stale, and
    // flooding the context window defeats the point.
    writeFileSync(p, JSON.stringify(queue.slice(-3)), "utf8");
}

/** Read and clear the queued briefings for a session. */
export function takeAcceptedContext(sessionId) {
    const p = pendingPath(sessionId);
    if (!existsSync(p)) return [];
    let queue = [];
    try {
        queue = JSON.parse(readFileSync(p, "utf8"));
    } catch {
        queue = [];
    }
    try {
        rmSync(p, { force: true });
    } catch {
        // Best effort; a duplicate delivery is better than a lost one.
    }
    return queue.map((q) => q.text);
}

// --- injection audit trail ----------------------------------------------
//
// Everything this extension puts in front of the agent via `additionalContext`
// is invisible to the user by design. That is a lot of trust to ask for, so
// every injection is recorded verbatim and surfaced in the panel.

const INJECTION_DIR = join(ARTIFACT_DIR, "injections");

function injectionPath(sessionId) {
    const safe = String(sessionId || "unknown").replace(/[^A-Za-z0-9._-]/g, "_");
    return join(INJECTION_DIR, `${safe}.json`);
}

export function logInjection(sessionId, kind, text) {
    mkdirSync(INJECTION_DIR, { recursive: true });
    const p = injectionPath(sessionId);
    let items = [];
    if (existsSync(p)) {
        try {
            items = JSON.parse(readFileSync(p, "utf8"));
        } catch {
            items = [];
        }
    }
    items.push({ at: Date.now(), kind, text });
    writeFileSync(p, JSON.stringify(items.slice(-10)), "utf8");
}

export function readInjections(sessionId) {
    const p = injectionPath(sessionId);
    if (!existsSync(p)) return [];
    try {
        return JSON.parse(readFileSync(p, "utf8")).reverse(); // newest first
    } catch {
        return [];
    }
}

// --- derived state -------------------------------------------------------

/**
 * Replay the log into per-(type, trigger) acceptance counters.
 *
 * Only explicit user decisions count. A hint that was superseded, or is still
 * waiting, contributes nothing — so with no clicks every posterior stays at the
 * prior and personalization is a no-op, which is the honest cold-start
 * behaviour.
 */
export function computeCounters() {
    const events = readLog();
    const impressions = new Map();
    for (const e of events) if (e.kind === "impression") impressions.set(e.hintId, e);
    const decided = realOutcomes(events);
    const superseded = new Set(events.filter((e) => e.kind === "superseded").map((e) => e.hintId));

    const counters = new Map();
    const key = (type, trigger) => `${type}::${trigger}`;

    for (const [hintId, imp] of impressions) {
        const outcome = decided.get(hintId)
            ?? (superseded.has(hintId) ? "superseded" : "pending");
        const k = key(imp.type, imp.trigger);
        if (!counters.has(k)) {
            counters.set(k, {
                type: imp.type, trigger: imp.trigger,
                accepted: 0, rejected: 0, ignored: 0,
                agentRelevant: 0, agentIrrelevant: 0,
                superseded: 0, pending: 0,
            });
        }
        const c = counters.get(k);
        if (outcome === "accepted" || outcome === "preempted") c.accepted++;
        else if (outcome === "rejected") c.rejected++;
        else if (outcome === "ignored") c.ignored++;
        else if (outcome === "agent_relevant") c.agentRelevant++;
        else if (outcome === "agent_irrelevant") c.agentIrrelevant++;
        else if (outcome === "superseded") c.superseded++;
        else c.pending++;
    }
    return counters;
}

/**
 * Beta-Bernoulli posterior mean acceptance rate for a (type, trigger) pair.
 *
 * Deliberately a counter, not a model. With a uniform Beta(1,1) prior an
 * unproven hint type sits at 0.5 and is neither promoted nor punished, so the
 * system degrades gracefully to pure retrieval on a cold start.
 */
export function acceptanceRate(counters, type, trigger, prior = { alpha: 1, beta: 1 }) {
    const c = counters.get(`${type}::${trigger}`);
    if (!c) return { rate: prior.alpha / (prior.alpha + prior.beta), n: 0 };
    // Agent relevance judgments count, but at half the weight of a user click:
    // the agent has full conversational context, yet it is predicting the
    // user's reaction rather than observing it.
    const accepts = c.accepted + 0.5 * c.agentRelevant;
    const misses = c.rejected + c.ignored + 0.5 * c.agentIrrelevant;
    const n = accepts + misses;
    const rate = (prior.alpha + accepts) / (prior.alpha + prior.beta + n);
    return { rate, n };
}

/** Recent rejections of a type, used as a hard suppressor by the gate. */
export function recentRejections(type, windowMs) {
    const events = readLog();
    const impressions = new Map();
    for (const e of events) if (e.kind === "impression") impressions.set(e.hintId, e);
    const cutoff = Date.now() - windowMs;
    let n = 0;
    for (const e of events) {
        if (e.kind !== "outcome" || e.outcome !== "rejected" || e.at < cutoff) continue;
        if (e.reason === "superseded_by_new_proposal") continue;
        if (impressions.get(e.hintId)?.type === type) n++;
    }
    return n;
}

/**
 * Timestamp of the last impression, for cooldown enforcement.
 * Pass a type for the per-type cooldown, or nothing for the global one.
 */
export function lastShownAt(type = null) {
    let last = 0;
    for (const e of readLog()) {
        if (e.kind !== "impression") continue;
        if (type !== null && e.type !== type) continue;
        if (e.at > last) last = e.at;
    }
    return last;
}

/**
 * Mark still-undecided impressions as superseded when a new proposal lands.
 *
 * Supersession is deliberately NOT an outcome. A hint scrolling out of the
 * panel because a newer one arrived tells us nothing about what the user
 * thought — they may never have looked at the panel at all. Counting it as a
 * miss creates a feedback loop that drives every hint type toward zero
 * acceptance regardless of quality: observed in practice as a learned "7%
 * accept rate (n=13)" derived from 0 real clicks.
 */
export function supersedePending(hintIds) {
    const decided = new Set(
        readLog().filter((e) => e.kind === "outcome").map((e) => e.hintId),
    );
    for (const id of hintIds) {
        if (!decided.has(id)) append({ kind: "superseded", at: Date.now(), hintId: id });
    }
}

/** Outcomes that reflect an actual user decision, not bookkeeping. */
function realOutcomes(events) {
    const map = new Map();
    for (const e of events) {
        if (e.kind !== "outcome") continue;
        // Historical logs contain auto-generated "ignored" rows from before
        // supersession was separated out. They are not observations.
        if (e.reason === "superseded_by_new_proposal") continue;
        map.set(e.hintId, e.outcome);
    }
    return map;
}

/**
 * The agent is already acting as a reranker: the hook hands it each surviving
 * hint and it decides whether to surface it, using the full conversation as
 * context that keyword retrieval cannot see. That judgment was previously
 * discarded. Logging it turns a free, already-happening decision into training
 * signal, without waiting for the user to click anything.
 *
 * It is a genuine relevance judgment, so it feeds the posterior — but it is
 * tagged `source: "agent"` and counted separately from user clicks, which
 * remain the gold standard.
 */
export function logAgentJudgment(hintId, relevant, reason) {
    append({
        kind: "outcome",
        at: Date.now(),
        hintId,
        outcome: relevant ? "agent_relevant" : "agent_irrelevant",
        source: "agent",
        reason: reason ?? null,
    });
}

export { realOutcomes };

export const LOG_FILE = LOG_PATH;
export const PROPOSAL_DIRECTORY = PROPOSAL_DIR;
export const LOG_DIR = dirname(LOG_PATH);
