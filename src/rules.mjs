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

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const COPILOT_HOME = process.env.COPILOT_HOME || join(homedir(), ".copilot");
export const RULES_DIR = join(COPILOT_HOME, "extensions", "adaptive-hints", "artifacts");
export const RULES_PATH = join(RULES_DIR, "rules.json");

// How many DIFFERENT sessions must state a preference before it is trusted.
// Two is coincidence; three is a habit.
export const SESSIONS_TO_CONFIRM = 3;

// How many different repositories before a rule stops being repo-specific.
export const REPOS_TO_GLOBALISE = 3;

// When a rule should be given to the agent. Stored with the rule because the
// right moment is part of the preference: "ask before committing" is useless
// after the commit.
//
// `after_changes` was added after reading real sessions: several preferences
// are about what to do once work is done ("open it in VS Code so I can see"),
// and the original list had nowhere to put them.
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

export function saveRules(store, path = RULES_PATH) {
    mkdirSync(RULES_DIR, { recursive: true });
    writeFileSync(path, JSON.stringify(store, null, 2), "utf8");
    return store;
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
 * Record that a preference was stated in one session.
 *
 * Deliberately cannot activate anything. `ruleId` lets the agent add weight to
 * an existing rule instead of inventing a near-duplicate — the agent is shown
 * the current list and decides, which is what removes keyword matching from
 * this system entirely.
 */
export function addObservation(store, { ruleId, rule, when, scope = "global", repository, sessionId, quote }) {
    if (!sessionId) throw new Error("addObservation requires sessionId");
    if (!ruleId && !rule) throw new Error("addObservation requires ruleId or rule");

    let target = ruleId ? store.rules.find((r) => r.id === ruleId) : null;
    if (ruleId && !target) throw new Error(`No such rule: ${ruleId}`);

    // Same sentence written again: treat it as the same rule.
    if (!target && rule) {
        target = store.rules.find((r) => r.status !== "retired" && sameRule(r.rule, rule)) || null;
    }

    if (!target) {
        target = {
            id: nextId(store),
            rule: String(rule).trim(),
            when: MOMENTS.includes(when) ? when : "session_start",
            scope,
            status: "candidate",
            observations: [],
        };
        store.rules.push(target);
    }

    target.observations.push({
        sessionId,
        repository: repository ?? null,
        quote: String(quote ?? "").replace(/\s+/g, " ").slice(0, 200),
        at: Date.now(),
    });
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
 * The only function that may change status.
 *
 * Requires evidence from SESSIONS_TO_CONFIRM different sessions, so a single
 * session repeating itself — or an over-eager agent — can never promote a rule,
 * however many observations it writes.
 */
export function promote(store, { sessionsToConfirm = SESSIONS_TO_CONFIRM, reposToGlobalise = REPOS_TO_GLOBALISE } = {}) {
    const promoted = [];
    for (const r of store.rules) {
        if (r.status === "retired") continue;
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

/** Active rules that apply at this moment, in this repository. */
export function rulesFor({ moment, repository } = {}, store = loadRules()) {
    return store.rules.filter((r) =>
        r.status === "active"
        && (!moment || r.when === moment)
        && (r.scope === "global" || !r.scope || r.scope === repository));
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
    r.status = "retired";
    return r;
}

/** The list shown to the agent so it can reuse an id instead of inventing one. */
export function ruleMenu(store = loadRules()) {
    return store.rules
        .filter((r) => r.status !== "retired")
        .map((r) => `  ${r.id}  ${r.rule}  (${distinctSessions(r)} sessions, ${r.status})`)
        .join("\n");
}

/** Human-readable summary, for the panel and for rules.md. */
export function describe(store = loadRules()) {
    const active = store.rules.filter((r) => r.status === "active");
    const candidates = store.rules.filter((r) => r.status === "candidate");
    return { active, candidates, total: store.rules.length };
}
