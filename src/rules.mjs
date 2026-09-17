// Durable preferences learned across sessions.
//
// The split that makes this work: an agent NOTICES, code CONFIRMS.
//
// A single session cannot know whether a request is a standing preference or a
// one-off — it has only seen one conversation. So the agent is only ever
// allowed to record an OBSERVATION, tagged with the session it came from. It
// has no way to activate anything. Confirmation is arithmetic over distinct
// session IDs, which no single session can fake.
//
// That guarantee is structural rather than a promise: `addObservation` takes no
// status field, and `promote` is the only function that writes one.
//
// Storage is plain JSON so it can be read, diffed and deleted without tooling,
// matching how the hint log already works.

import { mkdirSync, readFileSync, writeFileSync, existsSync, openSync, closeSync, rmSync, statSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const COPILOT_HOME = process.env.COPILOT_HOME || join(homedir(), ".copilot");
export const RULES_DIR = join(COPILOT_HOME, "extensions", "adaptive-hints", "artifacts");
export const RULES_PATH = join(RULES_DIR, "rules.json");

// How many DIFFERENT sessions must state a preference before it is trusted.
// Two is coincidence; three is a habit.
export const SESSIONS_TO_CONFIRM = 3;

// Accepts in a row before a preference stops asking and just applies itself.
// Repetition proves the user meant it; approval proves it was worded right.
export const ACCEPTS_TO_TRUST = 5;

// Declines in a row before it stops offering itself. Saying no three times
// replaces a "turn off" button, which read the same as "decline" anyway.
export const DECLINES_TO_STOP = 3;

// How many different repositories before a rule stops being repo-specific.
export const REPOS_TO_GLOBALISE = 3;

// When a rule reaches the agent. Part of the preference: "ask before
// committing" is useless afterwards. after_changes came from real sessions.
export const MOMENTS = [
    "session_start", "before_changes", "after_changes", "before_commit", "post_plan", "every_prompt",
];

function emptyStore() {
    return { version: 1, rules: [] };
}

export function loadRules(path = RULES_PATH) {
    if (!existsSync(path)) return emptyStore();
    try {
        const data = JSON.parse(readFileSync(path, "utf8"));
        return data && Array.isArray(data.rules) ? data : emptyStore();
    } catch {
        return emptyStore();
    }
}

function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function saveRules(store, path = RULES_PATH) {
    mkdirSync(dirname(path), { recursive: true });
    const json = JSON.stringify(store, null, 2);
    // Write beside the file and rename over it, so a crash mid-write cannot
    // leave a half-written file where the evidence used to be.
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, json, "utf8");
    // Windows refuses the rename while another process holds the target, so
    // retry briefly, then write in place rather than lose what the user said.
    for (let i = 0; i < 6; i++) {
        try {
            renameSync(tmp, path);
            return store;
        } catch (err) {
            if (!["EPERM", "EACCES", "EBUSY"].includes(err?.code)) break;
            sleepSync(20);
        }
    }
    try {
        writeFileSync(path, json, "utf8");
    } finally {
        try { rmSync(tmp, { force: true }); } catch { /* already gone */ }
    }
    return store;
}

// Every session runs its own copy of this extension against one shared file,
// so a plain load-change-save can drop whichever write lands second.
const LOCK_WAIT_MS = 2000;
const LOCK_STALE_MS = 5000;

function acquireLock(lockPath) {
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
        try {
            const fd = openSync(lockPath, "wx");
            writeFileSync(fd, String(process.pid));
            closeSync(fd);
            return true;
        } catch (err) {
            if (err?.code !== "EEXIST") return false;
            try {
                // A crashed session must not lock the file forever.
                if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
                    rmSync(lockPath, { force: true });
                    continue;
                }
            } catch {
                continue;
            }
            if (Date.now() >= deadline) return false;
            sleepSync(25);
        }
    }
}

/**
 * Read, change and write the file as one step, so two sessions recording a
 * preference at the same moment cannot lose one of them.
 */
export function updateRules(mutate, path = RULES_PATH) {
    mkdirSync(dirname(path), { recursive: true });
    const lockPath = `${path}.lock`;
    const locked = acquireLock(lockPath);
    try {
        const store = loadRules(path);
        const result = mutate(store);
        saveRules(store, path);
        return result === undefined ? store : result;
    } finally {
        // Losing the race is not a reason to drop what the user said, so the
        // lock is best effort: without it this behaves as it always did.
        if (locked) {
            try { rmSync(lockPath, { force: true }); } catch { /* already gone */ }
        }
    }
}

function nextId(store) {
    let n = 0;
    for (const r of store.rules) {
        const m = /^r(\d+)$/.exec(r.id);
        if (m) n = Math.max(n, Number(m[1]));
    }
    return `r${n + 1}`;
}

/**
 * Identity, not similarity.
 *
 * The agent is shown the rule list and asked to reuse an id, but it will
 * sometimes write the same sentence again instead. Without this, repeating one
 * preference produced a separate candidate every time, so evidence scattered
 * across near-copies and nothing could ever reach three sessions. Comparing the
 * agent's own normalised text is exact matching, not the keyword matching this
 * system is built to avoid.
 */
function sameRule(a, b) {
    const norm = (s) => String(s).toLowerCase().replace(/\s+/g, " ").replace(/[.!]+$/, "").trim();
    return norm(a) === norm(b);
}

/**
 * The card must ask, not instruct.
 *
 * The schema tells the agent to phrase `ask` as a question, but nothing stopped
 * it pasting the instruction there — and an instruction on a card reads as the
 * user's own words ordered back at them. A question mark is a crude test, but
 * it is the one thing every phrasing of a question has in common, and failing
 * it costs nothing: the card falls back to the instruction, exactly as it does
 * for rules that carry no question at all.
 */
function asQuestion(text) {
    const t = String(text ?? "").trim();
    return t.endsWith("?") ? t : null;
}

/**
 * Record that a preference was stated in one session.
 *
 * Deliberately cannot activate anything. `ruleId` lets the agent add weight to
 * an existing rule instead of inventing a near-duplicate — the agent is shown
 * the current list and decides, which is what removes keyword matching from
 * this system entirely.
 */
export function addObservation(store, { ruleId, rule, ask, when, scope = "global", repository, sessionId, quote }) {
    if (!sessionId) throw new Error("addObservation requires sessionId");
    if (!ruleId && !rule) throw new Error("addObservation requires ruleId or rule");

    let target = ruleId ? store.rules.find((r) => r.id === ruleId) : null;
    if (ruleId && !target) throw new Error(`No such rule: ${ruleId}`);

    // Same sentence again is the same rule. Retired ones included, or turning
    // a preference off and restating it would silently create a duplicate.
    if (!target && rule) {
        target = store.rules.find((r) => sameRule(r.rule, rule)) || null;
    }

    if (!target) {
        target = {
            id: nextId(store),
            // `rule` instructs the agent, `ask` questions the user. Showing the
            // instruction on a card quotes the user back at themselves.
            rule: String(rule).trim(),
            ask: asQuestion(ask),
            when: MOMENTS.includes(when) ? when : "session_start",
            scope,
            status: "candidate",
            accepts: 0,
            rejects: 0,
            acceptStreak: 0,
            observations: [],
        };
        store.rules.push(target);
    } else if (ask && !target.ask) {
        // A later session may phrase the question where an earlier one did not.
        target.ask = asQuestion(ask);
    }

    target.observations.push({
        sessionId,
        repository: repository ?? null,
        quote: String(quote ?? "").replace(/\s+/g, " ").slice(0, 200),
        at: Date.now(),
    });

    // Saying it again is the user changing their mind, and needs no button.
    // Back to candidate, never straight to active: promote() still requires
    // three distinct sessions, so one session cannot revive its own rule.
    if (target.status === "declined" || target.status === "retired") {
        target.status = "candidate";
        target.declineStreak = 0;
        delete target.declinedAt;
        delete target.retiredAt;
        delete target.activatedAt;
    }
    return target;
}

/** Sessions, and repositories, that independently produced this rule. */
export function distinctSessions(rule) {
    return new Set(rule.observations.map((o) => o.sessionId)).size;
}
export function distinctRepositories(rule) {
    return new Set(rule.observations.map((o) => o.repository).filter(Boolean)).size;
}

/**
 * Record what the user did when a rule offered itself.
 *
 * This is the SECOND kind of evidence, and it answers a different question.
 * Repetition across sessions shows the user meant it. Accepting the card shows
 * the rule was written down correctly and fired at a useful moment — which
 * repetition cannot show, because the user was never asked.
 *
 * A rejection resets the streak and pulls a silent rule back to asking. A rule
 * that is wrong once will be wrong again, and silence is exactly when being
 * wrong costs most.
 */
export function recordRuleOutcome(store, id, outcome, {
    acceptsToTrust = ACCEPTS_TO_TRUST,
    declinesToStop = DECLINES_TO_STOP,
} = {}) {
    const r = store.rules.find((x) => x.id === id);
    if (!r) throw new Error(`No such rule: ${id}`);
    if (!["accepted", "rejected"].includes(outcome)) {
        throw new Error(`outcome must be accepted or rejected, got ${outcome}`);
    }
    if (r.status === "candidate" || r.status === "retired" || r.status === "declined") {
        throw new Error(`Rule ${id} is ${r.status}; only active or trusted rules are offered`);
    }

    if (outcome === "accepted") {
        r.accepts = (r.accepts ?? 0) + 1;
        r.acceptStreak = (r.acceptStreak ?? 0) + 1;
        r.declineStreak = 0;
        if (r.status === "active" && r.acceptStreak >= acceptsToTrust) {
            r.status = "trusted";
            r.trustedAt = Date.now();
        }
    } else {
        r.rejects = (r.rejects ?? 0) + 1;
        r.acceptStreak = 0;
        r.declineStreak = (r.declineStreak ?? 0) + 1;
        // Back to asking. Earning silence starts over.
        if (r.status === "trusted") {
            r.status = "active";
            delete r.trustedAt;
        }
        // Declined repeatedly: stop offering it. Three noes are clearer than
        // one click, which could have been a mis-tap.
        if (r.declineStreak >= declinesToStop) {
            r.status = "declined";
            r.declinedAt = Date.now();
        }
    }
    return r;
}

/**
 * The only function that may promote a candidate.
 *
 * Requires evidence from SESSIONS_TO_CONFIRM different sessions, so a single
 * session repeating itself — or an over-eager agent — can never promote a rule,
 * however many observations it writes.
 *
 * Promotion reaches "active", never "trusted": a newly confirmed rule still has
 * to ask before it is allowed to act silently.
 */
export function promote(store, { sessionsToConfirm = SESSIONS_TO_CONFIRM, reposToGlobalise = REPOS_TO_GLOBALISE } = {}) {
    const promoted = [];
    for (const r of store.rules) {
        if (r.status === "retired" || r.status === "declined") continue;
        const sessions = distinctSessions(r);
        if (r.status === "candidate" && sessions >= sessionsToConfirm) {
            r.status = "active";
            r.activatedAt = Date.now();
            promoted.push(r);
        }
        // A rule seen across several repositories is about the person, not the
        // project. Widening is arithmetic, never one agent's opinion.
        if (r.scope !== "global" && distinctRepositories(r) >= reposToGlobalise) {
            r.scope = "global";
        }
    }
    return promoted;
}

/**
 * Rules that apply at this moment, in this repository.
 *
 * Returns both stages. `status` tells the caller which is which: "trusted"
 * applies silently, "active" must still offer a card the user can reject.
 */
export function rulesFor({ moment, repository } = {}, store = loadRules()) {
    return store.rules.filter((r) =>
        (r.status === "active" || r.status === "trusted")
        && (!moment || r.when === moment)
        && (r.scope === "global" || !r.scope || r.scope === repository));
}

/** Rules allowed to act without asking. */
export function silentRules(args, store) {
    return rulesFor(args, store).filter((r) => r.status === "trusted");
}

/** Rules that must still show an accept/reject card. */
export function askingRules(args, store) {
    return rulesFor(args, store).filter((r) => r.status === "active");
}

/** Fold one rule into another, keeping all evidence. Used by the merge button. */
export function mergeRules(store, keepId, mergeId) {
    if (keepId === mergeId) throw new Error("Cannot merge a rule into itself");
    const keep = store.rules.find((r) => r.id === keepId);
    const gone = store.rules.find((r) => r.id === mergeId);
    if (!keep || !gone) throw new Error("Both rules must exist");
    keep.observations.push(...gone.observations);
    store.rules = store.rules.filter((r) => r.id !== mergeId);
    return keep;
}

export function retireRule(store, id) {
    const r = store.rules.find((x) => x.id === id);
    if (!r) throw new Error(`No such rule: ${id}`);
    // Status only, never deletion: the evidence is real conversations and a
    // mis-click should not destroy it.
    r.status = "retired";
    r.retiredAt = Date.now();
    return r;
}

/**
 * Undo an observation this session recorded, for a preference the user is not
 * being offered. Other sessions' evidence is untouchable, so an agent can
 * correct its own misreading but never manufacture or erase influence.
 */
export function forgetObservation(store, id, sessionId) {
    const r = store.rules.find((x) => x.id === id);
    if (!r) throw new Error(`No such rule: ${id}`);
    if (r.status === "active" || r.status === "trusted") {
        throw new Error(`Rule ${id} is ${r.status}; three sessions confirmed it, so only the user can stop it`);
    }
    if (!sessionId) throw new Error("sessionId is required");

    const before = r.observations.length;
    r.observations = r.observations.filter((o) => o.sessionId !== sessionId);
    const removed = before - r.observations.length;
    const deleted = r.observations.length === 0;
    if (deleted) store.rules = store.rules.filter((x) => x.id !== id);
    return { id, removed, deleted };
}

/**
 * Stop applying a preference silently and go back to asking each time.
 * Not a rejection: the user is refusing the silence, not the preference.
 */
export function relaxRule(store, id) {
    const r = store.rules.find((x) => x.id === id);
    if (!r) throw new Error(`No such rule: ${id}`);
    if (r.status !== "trusted") {
        throw new Error(`Rule ${id} is ${r.status}; only a silently applied preference can be asked again`);
    }
    r.status = "active";
    r.acceptStreak = 0;
    delete r.trustedAt;
    return r;
}

/** Undo a retire. Returns the rule to candidate, and promote() re-decides. */
export function restoreRule(store, id) {
    const r = store.rules.find((x) => x.id === id);
    if (!r) throw new Error(`No such rule: ${id}`);
    r.status = "candidate";
    delete r.retiredAt;
    delete r.activatedAt;
    return r;
}

/** Rules the user turned off, kept so they can be restored. */
export function retiredRules(store = loadRules()) {
    return store.rules.filter((r) => r.status === "retired");
}

// --- What the user accepted in this conversation ---------------------------
// A rule is followed once accepted here, or once trusted. Nothing is applied
// on evidence alone: silence must never read as consent.
const ACCEPTED_DIR = join(RULES_DIR, "accepted");
export { ACCEPTED_DIR };

function acceptedPath(sessionId) {
    const safe = String(sessionId || "unknown").replace(/[^A-Za-z0-9._-]/g, "_");
    return join(ACCEPTED_DIR, `${safe}.json`);
}

export function acceptedIn(sessionId) {
    const p = acceptedPath(sessionId);
    if (!existsSync(p)) return new Set();
    try {
        return new Set(JSON.parse(readFileSync(p, "utf8")));
    } catch {
        return new Set();
    }
}

export function markAccepted(sessionId, ruleId) {
    mkdirSync(ACCEPTED_DIR, { recursive: true });
    const seen = acceptedIn(sessionId);
    seen.add(ruleId);
    writeFileSync(acceptedPath(sessionId), JSON.stringify([...seen]), "utf8");
    return seen;
}

// --- What has already been answered in this conversation -------------------
// Keeps an answered card off the deck, and stops a reload counting it twice.
const ANSWERED_DIR = join(RULES_DIR, "answered");
export { ANSWERED_DIR };

function answeredPath(sessionId) {
    const safe = String(sessionId || "unknown").replace(/[^A-Za-z0-9._-]/g, "_");
    return join(ANSWERED_DIR, `${safe}.json`);
}

export function answeredIn(sessionId) {
    const p = answeredPath(sessionId);
    if (!existsSync(p)) return new Set();
    try {
        return new Set(JSON.parse(readFileSync(p, "utf8")));
    } catch {
        return new Set();
    }
}

export function markAnswered(sessionId, ruleId) {
    mkdirSync(ANSWERED_DIR, { recursive: true });
    const seen = answeredIn(sessionId);
    seen.add(ruleId);
    writeFileSync(answeredPath(sessionId), JSON.stringify([...seen]), "utf8");
    return seen;
}

// --- What has already been said to the agent in this conversation ----------
// Once per moment per session; every edit fires two moments, which flooded both.
const SAID_DIR = join(RULES_DIR, "said");

function saidPath(sessionId) {
    const safe = String(sessionId || "unknown").replace(/[^A-Za-z0-9._-]/g, "_");
    return join(SAID_DIR, `${safe}.json`);
}

export function saidIn(sessionId) {
    const p = saidPath(sessionId);
    if (!existsSync(p)) return new Set();
    try {
        return new Set(JSON.parse(readFileSync(p, "utf8")));
    } catch {
        return new Set();
    }
}

export function markSaid(sessionId, keys) {
    mkdirSync(SAID_DIR, { recursive: true });
    const seen = saidIn(sessionId);
    for (const k of keys) seen.add(k);
    writeFileSync(saidPath(sessionId), JSON.stringify([...seen]), "utf8");
    return seen;
}

export { SAID_DIR };

/** The list shown to the agent so it can reuse an id instead of inventing one. */
export function ruleMenu(store = loadRules()) {
    return store.rules
        .filter((r) => r.status !== "retired" && r.status !== "declined")
        .map((r) => `  ${r.id}  ${r.rule}  (${distinctSessions(r)} sessions, ${r.status})`)
        .join("\n");
}

/**
 * Show a card only once its moment has fired and the agent has been told.
 * Seeing a card therefore means it is in play right now, not merely stored.
 */
export function isOnDeck(rule, answered, delivered) {
    if (answered.has(rule.id)) return false;
    return delivered.has(`${rule.id}@${rule.when}`);
}

/** Human-readable summary, for the panel and for rules.md. */
export function describe(store = loadRules()) {
    const by = (s) => store.rules.filter((r) => r.status === s);
    return {
        trusted: by("trusted"),
        active: by("active"),
        candidates: by("candidate"),
        // Things the user has turned away from, by declining repeatedly or by
        // an explicit retire. Kept, never shown in the deck.
        dropped: store.rules.filter((r) => r.status === "declined" || r.status === "retired"),
        total: store.rules.length,
    };
}
