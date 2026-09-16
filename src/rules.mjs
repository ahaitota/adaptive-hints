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

// How many times an active rule must be accepted, with no rejection in
// between, before it stops asking and simply applies itself.
//
// Confirmation by repetition proves the user MEANT it. It does not prove the
// rule was written down correctly, or that firing it at this moment helps. So
// a confirmed rule still shows a card and earns silence separately. One
// rejection sends it back to asking, because a rule that is wrong once will be
// wrong again and silence is exactly when that costs most.
export const ACCEPTS_TO_TRUST = 5;

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

    // Same sentence written again: treat it as the same rule.
    //
    // Retired rules are included deliberately. Excluding them meant that
    // turning a preference off and then stating it again created a SECOND rule
    // with identical text, which promoted itself and quietly undid the user's
    // decision. Attaching here keeps the evidence together and leaves the rule
    // off until the user restores it.
    if (!target && rule) {
        target = store.rules.find((r) => sameRule(r.rule, rule)) || null;
    }

    if (!target) {
        target = {
            id: nextId(store),
            // Two sentences, on purpose. `rule` is an instruction and goes to
            // the agent; `ask` is a question and goes on the card. Showing the
            // instruction to the user reads as their own words quoted back at
            // them, which is a strange thing to be asked to approve.
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
export function recordRuleOutcome(store, id, outcome, { acceptsToTrust = ACCEPTS_TO_TRUST } = {}) {
    const r = store.rules.find((x) => x.id === id);
    if (!r) throw new Error(`No such rule: ${id}`);
    if (!["accepted", "rejected"].includes(outcome)) {
        throw new Error(`outcome must be accepted or rejected, got ${outcome}`);
    }
    if (r.status === "candidate" || r.status === "retired") {
        throw new Error(`Rule ${id} is ${r.status}; only active or trusted rules are offered`);
    }

    if (outcome === "accepted") {
        r.accepts = (r.accepts ?? 0) + 1;
        r.acceptStreak = (r.acceptStreak ?? 0) + 1;
        if (r.status === "active" && r.acceptStreak >= acceptsToTrust) {
            r.status = "trusted";
            r.trustedAt = Date.now();
        }
    } else {
        r.rejects = (r.rejects ?? 0) + 1;
        r.acceptStreak = 0;
        // Back to asking. Earning silence starts over.
        if (r.status === "trusted") {
            r.status = "active";
            delete r.trustedAt;
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
    // Status only, never deletion: the evidence is real conversations, and a
    // mis-click should not destroy it. Found while testing the panel button —
    // retiring was one click and there was no way back.
    r.status = "retired";
    r.retiredAt = Date.now();
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

/** The list shown to the agent so it can reuse an id instead of inventing one. */
export function ruleMenu(store = loadRules()) {
    return store.rules
        .filter((r) => r.status !== "retired")
        .map((r) => `  ${r.id}  ${r.rule}  (${distinctSessions(r)} sessions, ${r.status})`)
        .join("\n");
}

/** Human-readable summary, for the panel and for rules.md. */
export function describe(store = loadRules()) {
    const by = (s) => store.rules.filter((r) => r.status === s);
    return {
        trusted: by("trusted"),
        active: by("active"),
        candidates: by("candidate"),
        total: store.rules.length,
    };
}
