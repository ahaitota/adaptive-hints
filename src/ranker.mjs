// Phases 3 + 4: gating and personalization.
//
// The ordering matters. Personalization adjusts scores, the gate decides
// whether anything is worth showing at all, and exploration deliberately
// violates the gate a fraction of the time so the log does not only ever
// contain hints the system already believed in.

import { acceptanceRate, computeCounters, recentRejections, lastShownAt } from "./store.mjs";

export const DEFAULT_CONFIG = {
    // Gate
    scoreThreshold: 0.35,
    maxVisible: 1, // one hint per trigger point; a queue invites ignoring
    cooldownMinutes: 30, // per hint type
    // Per-type cooldown alone lets one hint of each type fire on consecutive
    // prompts, which reads as a burst. This caps the overall rate. Raised from
    // 10 after measuring 7.6 hints/session with zero user engagement — the
    // dominant failure mode here is volume, not ranking.
    globalCooldownMinutes: 45,
    rejectSuppressCount: 2,
    rejectSuppressWindowDays: 7,
    // Learning
    holdoutRate: 0.08, // shown nothing, on purpose, to measure counterfactual
    epsilon: 0.1, // exploration, so the ranker cannot calcify
};

/** Deterministic 0..1 from a string, so holdout assignment is reproducible. */
function hashUnit(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h / 0xffffffff;
}

function newHintId() {
    return `h_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Score, gate and select hints.
 *
 * Returns both what to show AND why everything else was dropped — the
 * suppressed list is what makes the gate evaluable later.
 */
export function rankAndGate(hintCandidates, { trigger, sessionId, config = {}, now = Date.now() } = {}) {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    const counters = computeCounters();
    const suppressed = [];

    // Holdout arm: decided before scoring so it is unbiased by what we found.
    const holdoutKey = `${sessionId}|${trigger}|${new Date(now).toISOString().slice(0, 10)}`;
    const inHoldout = hashUnit(holdoutKey) < cfg.holdoutRate;
    if (inHoldout) {
        return { shown: [], suppressed, holdout: true, config: cfg, candidateCount: hintCandidates.length };
    }

    // 1. Personalize: multiply retrieval score by learned acceptance.
    //    An unproven (type, trigger) sits at 0.5 → multiplier 1.0 → no effect.
    const scored = hintCandidates.map((h) => {
        const { rate, n } = acceptanceRate(counters, h.type, trigger);
        const personalMultiplier = 0.5 + rate;
        return {
            ...h,
            retrievalScore: h.score,
            acceptanceRate: rate,
            observations: n,
            personalMultiplier,
            finalScore: Math.min(1, h.score * personalMultiplier),
        };
    });
    scored.sort((a, b) => b.finalScore - a.finalScore);

    // 2. Collapse to the best candidate per type. Five near-identical
    //    "reuse chat" cards is the failure mode that trains users to ignore.
    const bestPerType = [];
    const seenTypes = new Set();
    for (const h of scored) {
        if (seenTypes.has(h.type)) {
            suppressed.push({ type: h.type, trigger, score: h.finalScore, reason: "duplicate_type", sessionId });
            continue;
        }
        seenTypes.add(h.type);
        bestPerType.push(h);
    }

    // 3. Hard gates.
    const survivors = [];
    const cooldownMs = cfg.cooldownMinutes * 60_000;
    const rejectWindowMs = cfg.rejectSuppressWindowDays * 86_400_000;

    // Global rate limit, checked once: any hint at all shown recently means
    // this trigger point stays quiet regardless of type.
    const sinceAny = now - lastShownAt(null);
    if (sinceAny < cfg.globalCooldownMinutes * 60_000) {
        for (const h of bestPerType) {
            suppressed.push({ type: h.type, trigger, score: h.finalScore, reason: "global_cooldown", sessionId });
        }
        return { shown: [], suppressed, holdout: false, config: cfg, candidateCount: hintCandidates.length };
    }

    for (const h of bestPerType) {
        if (h.finalScore < cfg.scoreThreshold) {
            suppressed.push({ type: h.type, trigger, score: h.finalScore, reason: "below_threshold", sessionId });
            continue;
        }
        const rejects = recentRejections(h.type, rejectWindowMs);
        if (rejects >= cfg.rejectSuppressCount) {
            suppressed.push({ type: h.type, trigger, score: h.finalScore, reason: `rejected_${rejects}x_recently`, sessionId });
            continue;
        }
        const since = now - lastShownAt(h.type);
        if (since < cooldownMs) {
            suppressed.push({ type: h.type, trigger, score: h.finalScore, reason: "cooldown", sessionId });
            continue;
        }
        survivors.push(h);
    }

    // 4. Exploration. Without this the log only ever contains hints the ranker
    //    already ranked first, and the counters can never self-correct.
    let explored = false;
    if (survivors.length > 1 && Math.random() < cfg.epsilon) {
        const pick = 1 + Math.floor(Math.random() * (survivors.length - 1));
        [survivors[0], survivors[pick]] = [survivors[pick], survivors[0]];
        explored = true;
    }

    const shown = survivors.slice(0, cfg.maxVisible).map((h) => ({ ...h, hintId: newHintId(), explore: explored }));
    for (const h of survivors.slice(cfg.maxVisible)) {
        suppressed.push({ type: h.type, trigger, score: h.finalScore, reason: "over_max_visible", sessionId });
    }

    return { shown, suppressed, holdout: false, config: cfg, candidateCount: hintCandidates.length };
}

/** Aggregate metrics from the plan's Phase 5 evaluation table. */
export function summarize(events) {
    const impressions = events.filter((e) => e.kind === "impression");
    const outcomes = new Map();
    for (const e of events) {
        if (e.kind !== "outcome") continue;
        if (e.reason === "superseded_by_new_proposal") continue; // bookkeeping, not a decision
        outcomes.set(e.hintId, e.outcome);
    }
    const superseded = new Set(events.filter((e) => e.kind === "superseded").map((e) => e.hintId));

    let accepted = 0, rejected = 0, ignored = 0, unanswered = 0, agentRelevant = 0, agentIrrelevant = 0;
    for (const i of impressions) {
        const o = outcomes.get(i.hintId);
        if (o === "accepted" || o === "preempted") accepted++;
        else if (o === "rejected") rejected++;
        else if (o === "ignored") ignored++;
        else if (o === "agent_relevant") agentRelevant++;
        else if (o === "agent_irrelevant") agentIrrelevant++;
        else unanswered++; // superseded or still pending — no signal either way
    }
    // Rates are over decisions the user actually made. Dividing by impressions
    // would report 0% acceptance for someone who simply never opened the panel.
    const decided = accepted + rejected + ignored;
    const holdouts = events.filter((e) => e.kind === "holdout").length;
    const suppressedCount = events.filter((e) => e.kind === "suppressed").length;
    const sessions = new Set(impressions.map((i) => i.sessionId)).size || 1;

    return {
        impressions: impressions.length,
        accepted,
        rejected,
        ignored,
        agentRelevant,
        agentIrrelevant,
        agentPrecision: (agentRelevant + agentIrrelevant)
            ? agentRelevant / (agentRelevant + agentIrrelevant)
            : null,
        unanswered,
        supersededCount: superseded.size,
        decided,
        acceptRate: decided ? accepted / decided : null,
        ignoreRate: decided ? ignored / decided : null,
        engagementRate: impressions.length ? decided / impressions.length : null,
        hintsPerSession: impressions.length / sessions,
        suppressedCount,
        holdoutTriggers: holdouts,
        gateSelectivity: impressions.length + suppressedCount
            ? impressions.length / (impressions.length + suppressedCount)
            : null,
    };
}
