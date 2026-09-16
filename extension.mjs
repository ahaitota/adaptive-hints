// Extension: adaptive-hints
// Behaviour-ranked agent hints with accept/reject learning.
//
// Pipeline (see adaptive-hints-plan.md):
//   retrieval.mjs  → candidates from the user's own session history
//   ranker.mjs     → personalize (Beta-Bernoulli), gate, explore
//   store.mjs      → log every impression, outcome and suppression
//   renderer.mjs   → the accept/reject card in the canvas panel
//
// This file is wiring only.

import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";

import {
    generateCandidates, buildHintCandidates, storeAvailable, fetchSessionContext,
    setSessionStore, sessionStorePath, DEFAULT_SESSION_STORE,
} from "./src/retrieval.mjs";
import { rankAndGate, summarize, DEFAULT_CONFIG } from "./src/ranker.mjs";
import { renderHtml } from "./src/renderer.mjs";
import { extractUserTask } from "./src/prompt-filter.mjs";
import { changedFiles } from "./src/changed-files.mjs";
import {
    loadRules, saveRules, addObservation, promote, ruleMenu,
    mergeRules, retireRule, restoreRule, recordRuleOutcome,
    silentRules, askingRules, answeredIn, markAnswered,
    distinctSessions, distinctRepositories, describe, MOMENTS,
} from "./src/rules.mjs";
import {
    logImpression, logSuppressed, logHoldout, logOutcome,
    readLog, saveProposal, loadProposal, supersedePending,
    computeCounters, acceptanceRate, loadSettings, saveSettings, TEST_MODE_GATE,
    logAgentJudgment, queueAcceptedContext, takeAcceptedContext,
    logInjection, readInjections, LOG_FILE, ARTIFACT_DIR,
} from "./src/store.mjs";

const servers = new Map(); // instanceId -> { server, url, clients:Set }

/**
 * The repository a session belongs to, used to scope preferences.
 *
 * A rule learned while working on one project is not automatically true of
 * another, so scope starts narrow and only widens once the same preference has
 * appeared in several repositories.
 */
function repositoryOf(workspacePath) {
    if (!workspacePath) return null;
    const parts = String(workspacePath).replace(/\\/g, "/").split("/").filter(Boolean);
    return parts.length ? parts[parts.length - 1] : null;
}

// Restore a fixture database chosen in a previous run. Without this the
// setting would silently revert to the real store on every extension reload,
// and a test suite would look like it was passing against the fixture while
// actually reading real sessions.
{
    const saved = loadSettings().sessionStorePath;
    if (saved && existsSync(saved)) setSessionStore(saved);
}

// Set once joinSession resolves. Used to post a short confirmation to the
// timeline when a hint is accepted — otherwise Accept is completely silent
// and the user has no way to tell the click did anything.
let session = null;

function broadcast() {
    for (const { clients } of servers.values()) {
        for (const res of clients) {
            try {
                res.write("data: update\n\n");
            } catch {
                // Client vanished mid-write; the close handler prunes it.
            }
        }
    }
}

/**
 * Load the rules, promoting anything that has earned it.
 *
 * Promotion used to happen only when the agent recorded an observation, which
 * left the invariant "three sessions means active" true only if the last write
 * happened to come through that path. A rule was found sitting at 3 of 3 and
 * still a candidate. Doing it on read as well makes the rule file
 * self-correcting whatever wrote it last — including a hand edit — and costs a
 * pass over a few hundred rows.
 */
function syncedRules() {
    const store = loadRules();
    const before = store.rules.map((r) => r.status).join();
    promote(store);
    if (store.rules.map((r) => r.status).join() !== before) saveRules(store);
    return store;
}

/**
 * Which learned moment, if any, a tool call corresponds to.
 *
 * The `when` field was being stored and then ignored: only session_start was
 * ever fired, so four of five real preferences — ask before committing, give
 * me the commands, open the result, explain before changing code — could never
 * reach the agent at the moment they were about to matter.
 *
 * Matching is on the tool's name and its arguments rather than a fixed list of
 * tool names, because the names differ between hosts and a list would quietly
 * stop matching when one is renamed.
 */
function momentForTool(toolName, toolArgs, phase) {
    const name = String(toolName || "").toLowerCase();
    let args = "";
    try {
        args = typeof toolArgs === "string" ? toolArgs : JSON.stringify(toolArgs ?? "");
    } catch {
        args = "";
    }
    const shell = /bash|shell|powershell|terminal|run_command|execute/.test(name);
    const edits = /edit|create|write|apply_patch|str_replace|insert/.test(name);

    if (shell && /\bgit\s+(commit|push)\b/.test(args)) {
        return phase === "pre" ? "before_commit" : null;
    }
    if (edits) return phase === "pre" ? "before_changes" : "after_changes";
    return null;
}

/**
 * Deliver the preferences that belong to this moment.
 *
 * Trusted ones are stated as instructions; ones still asking are mentioned as
 * pending so the agent follows them now and the user can answer in the panel.
 * Returns null when there is nothing to say, so the hook stays silent.
 */
function contextForMoment(moment, repository) {
    const store = syncedRules();
    const silent = silentRules({ moment, repository }, store);
    const asking = askingRules({ moment, repository }, store);
    if (!silent.length && !asking.length) return null;

    const lines = [];
    if (silent.length) {
        lines.push(`[adaptive-hints] Remembered preference(s) for right now:\n`
            + silent.map((r) => `  - ${r.rule}`).join("\n"));
    }
    if (asking.length) {
        lines.push(`[adaptive-hints] Waiting for approval in the panel, follow for now:\n`
            + asking.map((r) => `  - ${r.rule}`).join("\n"));
    }
    return lines.join("\n\n");
}

/** Current panel state: the active proposal plus derived learning metrics. */
function currentState(sessionId) {
    const proposal = loadProposal(sessionId);
    const events = readLog();

    // The agent's own relevance judgment must NOT dismiss the card. It is a
    // ranking signal, not a decision on the user's behalf — and because the
    // agent records it within seconds of the prompt, treating it as a decision
    // made cards vanish before the user could read them.
    //
    // Keeping the two separate also makes the interesting case visible:
    // when the user accepts something the agent judged irrelevant, that
    // disagreement is the most informative feedback available.
    const outcomes = new Map();
    const agentJudgments = new Map();
    for (const e of events) {
        if (e.kind !== "outcome") continue;
        if (e.outcome === "agent_relevant" || e.outcome === "agent_irrelevant") {
            agentJudgments.set(e.hintId, { verdict: e.outcome, reason: e.reason ?? null });
        } else {
            outcomes.set(e.hintId, e.outcome);
        }
    }

    const hints = (proposal?.shown ?? []).map((h) => ({
        ...h,
        outcome: outcomes.get(h.hintId) ?? null,
        agentJudgment: agentJudgments.get(h.hintId) ?? null,
    }));
    return {
        task: proposal?.task ?? "",
        trigger: proposal?.trigger ?? "",
        holdout: proposal?.holdout ?? false,
        suppressed: proposal?.suppressed ?? [],
        testMode: loadSettings().testMode === true,
        fixtureStore: sessionStorePath() !== DEFAULT_SESSION_STORE ? sessionStorePath() : null,
        injections: readInjections(sessionId),
        rules: (() => {
            const { trusted, active, candidates, dropped } = describe(syncedRules());
            const answered = answeredIn(sessionId);
            const shape = (r) => ({
                id: r.id, rule: r.rule, ask: r.ask ?? null, when: r.when, scope: r.scope, status: r.status,
                sessions: distinctSessions(r), repositories: distinctRepositories(r),
                accepts: r.accepts ?? 0, rejects: r.rejects ?? 0, streak: r.acceptStreak ?? 0,
                quotes: r.observations.slice(-2).map((o) => o.quote),
            });
            const unanswered = (list) => list.filter((r) => !answered.has(r.id)).map(shape);
            return {
                trusted: unanswered(trusted),
                active: unanswered(active),
                candidates: candidates.map(shape),
                dropped: dropped.map(shape),
                answeredHere: answered.size,
            };
        })(),
        hints,
        stats: summarize(events),
    };
}

/**
 * Turn an accepted hint into something the agent can actually use.
 *
 * Without this, Accept was a pure vote: it moved a counter and nothing else.
 * The card promises "reuse its decisions, validation steps, and pitfalls", so
 * accepting has to actually deliver those.
 *
 * Delivery is deliberately NOT `session.send`: that creates a visible turn the
 * user did not write. The briefing is queued and handed to the agent through
 * the hook's `additionalContext` on the next prompt — invisible, and the same
 * channel the hint notification already uses.
 */
function deliverAcceptedHint(impression, sessionId) {
    const action = impression?.action;
    if (!action) return null;

    const ctx = action.sessionId ? fetchSessionContext(action.sessionId) : null;
    const lines = [
        "[adaptive-hints:accepted] The user accepted this hint in the Adaptive hints panel:",
        `${impression.title} — ${impression.body}`,
        "",
    ];

    if (ctx) {
        lines.push(`Context from the prior session (${ctx.sessionId}):`);
        if (ctx.summary) lines.push(`- Summary: ${ctx.summary}`);
        if (ctx.repository) lines.push(`- Repo/branch: ${ctx.repository} @ ${ctx.branch ?? "?"}`);
        if (ctx.updatedAt) lines.push(`- Last worked on: ${ctx.updatedAt}`);
        if (ctx.originalRequest) lines.push(`- Original request: ${ctx.originalRequest}`);
        if (ctx.checkpoint) {
            const c = ctx.checkpoint;
            if (c.overview) lines.push(`- Overview: ${c.overview}`);
            if (c.workDone) lines.push(`- Work done: ${c.workDone}`);
            if (c.technical) lines.push(`- Technical details: ${c.technical}`);
            if (c.nextSteps) lines.push(`- Next steps left: ${c.nextSteps}`);
            if (c.importantFiles) lines.push(`- Important files: ${c.importantFiles}`);
        }
        if (ctx.files?.length) lines.push(`- Files touched: ${ctx.files.slice(0, 10).join(", ")}`);
        if (ctx.recentTurns?.length) {
            lines.push("- How it ended:");
            for (const t of ctx.recentTurns) {
                if (t.user) lines.push(`    user: ${t.user}`);
                if (t.assistant) lines.push(`    assistant: ${t.assistant}`);
            }
        }
    } else if (action.kind === "load_file_scope") {
        lines.push(`Files from the prior session: ${(action.files ?? []).join(", ")}`);
    } else {
        lines.push("(The prior session could not be loaded from the session store.)");
    }

    lines.push(
        "",
        "Use this as background for the user's current task: reuse the decisions, validation steps and pitfalls where they apply, and mention in one short sentence what you took from it. Do not restate it wholesale, and do not quote this block back to the user.",
    );

    const text = lines.join("\n");
    queueAcceptedContext(sessionId, text);

    // Confirm in the timeline. `session.log` posts a status line rather than a
    // chat turn, so it reads as system feedback instead of something the user
    // appears to have typed.
    //
    // The wording says "will reach" on purpose: at click time the briefing is
    // only queued. It is handed over via `additionalContext` on the next
    // prompt, so claiming it was already sent would set the wrong expectation
    // about when the agent can act on it.
    const label = ctx?.summary || action.sessionId || "a prior session";
    const kb = (text.length / 1024).toFixed(1);
    session?.log(
        `Hint accepted — context from "${label}" (${kb} KB) will reach the agent with your next message.`,
        { level: "info" },
    )?.catch?.(() => {
        // Never let a status line break outcome recording.
    });

    return { queued: true, priorSessionId: action.sessionId ?? null, chars: text.length };
}

function recordOutcome(hintId, outcome, sessionId) {
    const valid = ["accepted", "rejected", "ignored", "preempted"];
    if (!valid.includes(outcome)) throw new CanvasError("invalid_outcome", `outcome must be one of ${valid.join(", ")}`);

    const proposal = loadProposal(sessionId);
    const impression = (proposal?.shown ?? []).find((h) => h.hintId === hintId);

    // An outcome for a hint that was never shown is not a real observation.
    // Accepting it would let junk into the log that the counters silently drop.
    if (!impression) {
        const known = readLog().some((e) => e.kind === "impression" && e.hintId === hintId);
        if (!known) throw new CanvasError("unknown_hint", `No impression logged for hintId "${hintId}"`);
    }

    const timeToDecisionMs = impression ? Date.now() - (proposal.at ?? Date.now()) : null;

    logOutcome(hintId, outcome, { timeToDecisionMs, type: impression?.type, trigger: proposal?.trigger });

    const delivery = outcome === "accepted" ? deliverAcceptedHint(impression, sessionId) : null;

    broadcast();
    return { hintId, outcome, timeToDecisionMs, action: impression?.action ?? null, delivery };
}

/** Full propose pipeline: retrieve → rank → gate → log → persist. */
function propose({ task, trigger = "session_start", files = [], repository, sessionId, config = {} }) {
    const { candidates, reason } = generateCandidates({ task, excludeSessionId: sessionId, files, repository });
    const hintCandidates = buildHintCandidates(candidates, { files });
    const result = rankAndGate(hintCandidates, { trigger, sessionId, config });

    // Gate telemetry is recorded regardless of what happens below — it is data
    // about the gate, not about any particular hint.
    for (const s of result.suppressed) logSuppressed(s);
    if (result.holdout) logHoldout({ trigger, sessionId, candidates: hintCandidates.length });

    const decided = new Set(readLog().filter((e) => e.kind === "outcome").map((e) => e.hintId));
    const prev = loadProposal(sessionId);
    const prevLive = (prev?.shown ?? []).some((h) => !decided.has(h.hintId));

    // If this pass produced nothing, leave any still-unanswered hint alone.
    // Overwriting it would blank the panel and log an "ignored" the user never
    // chose — which matters now that this runs on every prompt.
    if (!result.shown.length && prevLive) {
        return { ...prev, skipped: true, candidateCount: hintCandidates.length };
    }

    // A genuinely new hint replaces the old one, so anything left unanswered
    // there is an honest "ignored".
    if (prev?.shown?.length) supersedePending(prev.shown.map((h) => h.hintId));

    for (const h of result.shown) {
        logImpression({
            hintId: h.hintId, type: h.type, trigger, sessionId,
            score: h.finalScore, retrievalScore: h.retrievalScore,
            personalMultiplier: h.personalMultiplier, explore: h.explore,
            evidence: h.evidence, title: h.title,
        });
    }

    const proposal = {
        at: Date.now(), task, trigger, sessionId,
        holdout: result.holdout,
        shown: result.shown,
        suppressed: result.suppressed,
        retrievalReason: reason,
        candidateCount: hintCandidates.length,
    };
    saveProposal(sessionId, proposal);
    broadcast();
    return proposal;
}

/**
 * Automatic trigger. Runs on each submitted prompt; the gate (threshold,
 * cooldowns, reject-suppressor, max 1 visible) is what keeps this from
 * becoming noise, so this only adds the cheap pre-filters.
 */
function autoPropose(prompt, sessionId, workingDirectory) {
    const settings = loadSettings();
    if (!settings.autoPropose || !storeAvailable()) return null;

    const task = extractUserTask(prompt, { minChars: settings.minPromptChars });
    if (!task) return null;

    // Files in play, so `reuse_file_scope` has something to match against.
    // Non-blocking, and empty outside a git repo — which simply means no
    // file-scope hints rather than a failure.
    const files = changedFiles(workingDirectory);

    // User-configured gate overrides (e.g. cooldowns disabled for testing).
    const p = propose({ task, files, trigger: "prompt_submitted", sessionId, config: settings.gate ?? {} });
    if (p.skipped || p.holdout || !p.shown?.length) return null;
    return p.shown[0];
}

async function startServer(instanceId, sessionId) {
    const clients = new Set();
    const server = createServer((req, res) => {
        const url = new URL(req.url, "http://127.0.0.1");

        if (url.pathname === "/events") {
            res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
            });
            res.write("data: connected\n\n");
            clients.add(res);
            req.on("close", () => clients.delete(res));
            return;
        }

        if (url.pathname === "/state") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(currentState(sessionId)));
            return;
        }

        if (url.pathname === "/outcome" && req.method === "POST") {
            // Collect Buffers and decode once. `body += chunk` decodes each
            // chunk separately, so a multi-byte character split across a TCP
            // boundary becomes two U+FFFD replacement characters. Hint IDs are
            // ASCII today, but the bug is silent and only shows up under
            // chunking, which is exactly how it survives testing.
            const chunks = [];
            let size = 0;
            let aborted = false;
            req.on("data", (c) => {
                if (aborted) return;
                const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
                size += buf.length;
                if (size > 64 * 1024) {
                    aborted = true;
                    res.writeHead(413, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: "body too large" }));
                    req.destroy();
                    return;
                }
                chunks.push(buf);
            });
            req.on("end", () => {
                if (aborted) return;
                try {
                    const body = Buffer.concat(chunks).toString("utf8");
                    const { hintId, outcome } = JSON.parse(body || "{}");
                    const out = recordOutcome(hintId, outcome, sessionId);
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify(out));
                } catch (err) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: String(err?.message ?? err) }));
                }
            });
            return;
        }

        // Merge and retire from the panel. Same body handling as /outcome: the
        // chunks are concatenated before decoding, because decoding each chunk
        // separately corrupts any multi-byte character split across a TCP
        // boundary, and rule text is user-written so it will contain them.
        if (url.pathname === "/rules" && req.method === "POST") {
            const chunks = [];
            let size = 0;
            let aborted = false;
            req.on("data", (c) => {
                if (aborted) return;
                const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
                size += buf.length;
                if (size > 64 * 1024) {
                    aborted = true;
                    res.writeHead(413, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: "body too large" }));
                    req.destroy();
                    return;
                }
                chunks.push(buf);
            });
            req.on("end", () => {
                if (aborted) return;
                try {
                    const { merge, retire, restore, outcome } = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
                    const store = loadRules();
                    if (merge) mergeRules(store, merge.keep, merge.remove);
                    if (retire) retireRule(store, retire);
                    if (restore) restoreRule(store, restore);
                    if (outcome) {
                        recordRuleOutcome(store, outcome.id, outcome.outcome);
                        // Take it off the deck for the rest of this
                        // conversation, so the click visibly does something and
                        // a reload cannot answer the same card twice.
                        markAnswered(sessionId, outcome.id);
                    }
                    saveRules(store);
                    broadcast();
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ ok: true }));
                } catch (err) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: String(err?.message ?? err) }));
                }
            });
            return;
        }

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderHtml());
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    return { server, url: `http://127.0.0.1:${port}/`, clients };
}

session = await joinSession({
    canvases: [
        createCanvas({
            id: "adaptive-hints",
            displayName: "Adaptive hints",
            description:
                "Proposes accept/reject hint cards ranked against the user's own prior sessions, and learns from each accept/reject to raise future acceptance. Open it and call `propose` with the user's current task.",
            inputSchema: {
                type: "object",
                properties: {
                    task: { type: "string", description: "What the user is doing now; drives retrieval." },
                    trigger: { type: "string", description: "Trigger point, e.g. session_start, post_plan, pre_commit, on_idle." },
                    files: { type: "array", items: { type: "string" }, description: "Files currently in play, enables the overlap signal." },
                    repository: { type: "string" },
                },
            },
            actions: [
                {
                    name: "propose",
                    description: "Retrieve, rank, gate and display hints for the current task. Logs an impression for each hint shown.",
                    inputSchema: {
                        type: "object",
                        required: ["task"],
                        properties: {
                            task: { type: "string" },
                            trigger: { type: "string" },
                            files: { type: "array", items: { type: "string" } },
                            repository: { type: "string" },
                            config: {
                                type: "object",
                                description: "Override gate/learning knobs, e.g. scoreThreshold, maxVisible, holdoutRate, epsilon.",
                                additionalProperties: true,
                            },
                        },
                    },
                    handler: async (ctx) => {
                        const { task, trigger, files, repository, config } = ctx.input ?? {};
                        if (!storeAvailable()) {
                            throw new CanvasError("session_store_unavailable", `Cannot read ${sessionStorePath()}`);
                        }
                        // Saved settings are the base; a per-call config wins.
                        // Without this, manual proposals silently ignore the
                        // user's own gate configuration.
                        const settings = loadSettings();
                        const p = propose({
                            task, trigger, files, repository,
                            config: { ...(settings.gate ?? {}), ...(config ?? {}) },
                            sessionId: ctx.sessionId,
                        });
                        return {
                            holdout: p.holdout,
                            candidateCount: p.candidateCount,
                            retrievalReason: p.retrievalReason,
                            shown: p.shown.map((h) => ({
                                hintId: h.hintId, type: h.type, title: h.title, body: h.body,
                                finalScore: Number(h.finalScore.toFixed(3)),
                                retrievalScore: Number(h.retrievalScore.toFixed(3)),
                                acceptanceRate: Number(h.acceptanceRate.toFixed(3)),
                                observations: h.observations,
                                explore: h.explore,
                                evidence: h.evidence,
                            })),
                            suppressed: p.suppressed.map((s) => ({ type: s.type, reason: s.reason, score: Number((s.score ?? 0).toFixed(3)) })),
                        };
                    },
                },
                {
                    name: "record_outcome",
                    description: "Record accept/reject/ignore/preempted for a hint. Use `preempted` when the user did the suggested thing without clicking.",
                    inputSchema: {
                        type: "object",
                        required: ["hintId", "outcome"],
                        properties: {
                            hintId: { type: "string" },
                            outcome: { type: "string", enum: ["accepted", "rejected", "ignored", "preempted"] },
                        },
                    },
                    handler: async (ctx) => recordOutcome(ctx.input.hintId, ctx.input.outcome, ctx.sessionId),
                },
                {
                    name: "stats",
                    description: "Return the Phase-5 evaluation metrics and the learned per-type acceptance counters.",
                    handler: async () => {
                        const events = readLog();
                        const counters = computeCounters();
                        const perType = [...counters.values()].map((c) => ({
                            ...c,
                            posteriorAcceptRate: Number(acceptanceRate(counters, c.type, c.trigger).rate.toFixed(3)),
                        }));
                        const settings = loadSettings();
                        return {
                            metrics: summarize(events), perType,
                            config: { ...DEFAULT_CONFIG, ...(settings.gate ?? {}) },
                            testMode: settings.testMode === true,
                            activeSessionStore: sessionStorePath(),
                            usingFixture: sessionStorePath() !== DEFAULT_SESSION_STORE,
                            logFile: LOG_FILE, artifactDir: ARTIFACT_DIR,
                        };
                    },
                },
                {
                    name: "remember_preference",
                    description:
                        "Record that the user stated a durable preference about how they want to be worked with. "
                        + "Reuse an existing ruleId where one fits, rather than writing a near-duplicate. "
                        + "This CANNOT activate anything: a preference only takes effect once three different "
                        + "sessions have independently stated it. Use at most once per session, for genuine "
                        + "standing preferences and corrections — not for ordinary task requests.",
                    inputSchema: {
                        type: "object",
                        required: ["quote"],
                        properties: {
                            ruleId: { type: "string", description: "Existing rule to add weight to, e.g. r1" },
                            rule: {
                                type: "string",
                                description: "The instruction, as the agent should follow it. One line, e.g. 'Explain in plain language'",
                            },
                            ask: {
                                type: "string",
                                description: "The same thing as a short, polite question to the user, for the approval card. "
                                    + "e.g. 'Would you like me to explain things in plain language?' Never quote their prompt back at them.",
                            },
                            when: { type: "string", enum: MOMENTS, description: "When this should reach the agent" },
                            scope: { type: "string", description: "'global', or a repository name" },
                            quote: { type: "string", description: "The user's own words" },
                        },
                    },
                    handler: async (ctx) => {
                        const { ruleId, rule, ask, when, scope, quote } = ctx.input ?? {};
                        const store = loadRules();
                        const target = addObservation(store, {
                            ruleId, rule, ask, when, scope: scope || "global",
                            repository: repositoryOf(session.workspacePath),
                            sessionId: ctx.sessionId,
                            quote,
                        });
                        // Promotion runs here rather than on a schedule: the
                        // only moment the count can change is when something is
                        // written, and counting a few hundred rows is free.
                        const promoted = promote(store);
                        saveRules(store);
                        broadcast();
                        return {
                            ruleId: target.id,
                            rule: target.rule,
                            status: target.status,
                            sessions: distinctSessions(target),
                            needed: 3,
                            activatedNow: promoted.some((p) => p.id === target.id),
                        };
                    },
                },
                {
                    name: "preferences",
                    description: "List learned preferences, and merge or retire one. Read-only unless merge/retire is given.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            merge: {
                                type: "object",
                                description: "Fold one rule into another, keeping all evidence",
                                required: ["keep", "remove"],
                                properties: { keep: { type: "string" }, remove: { type: "string" } },
                            },
                            retire: { type: "string", description: "Rule id to stop applying" },
                        },
                    },
                    handler: async (ctx) => {
                        const store = loadRules();
                        const { merge, retire } = ctx.input ?? {};
                        if (merge) mergeRules(store, merge.keep, merge.remove);
                        if (retire) retireRule(store, retire);
                        if (merge || retire) { saveRules(store); broadcast(); }
                        const { trusted, active, candidates } = describe(store);
                        const shape = (r) => ({
                            id: r.id, rule: r.rule, ask: r.ask ?? null, when: r.when, scope: r.scope, status: r.status,
                            sessions: distinctSessions(r), repositories: distinctRepositories(r),
                            accepts: r.accepts ?? 0, rejects: r.rejects ?? 0,
                            quotes: r.observations.slice(-3).map((o) => o.quote),
                        });
                        return {
                            trusted: trusted.map(shape),
                            active: active.map(shape),
                            candidates: candidates.map(shape),
                        };
                    },
                },
                {
                    name: "explain",
                    description: "Explain, without showing anything, how the current task would be scored and gated. Use for tuning; logs nothing.",
                    inputSchema: {
                        type: "object",
                        required: ["task"],
                        properties: {
                            task: { type: "string" },
                            files: { type: "array", items: { type: "string" } },
                            trigger: { type: "string" },
                        },
                    },
                    handler: async (ctx) => {
                        const { task, files = [], trigger = "session_start" } = ctx.input ?? {};
                        const { candidates, reason } = generateCandidates({ task, excludeSessionId: ctx.sessionId, files });
                        return {
                            retrievalReason: reason,
                            topCandidates: candidates.slice(0, 5).map((c) => ({
                                sessionId: c.sessionId,
                                summary: c.summary,
                                repository: c.repository,
                                updatedAt: c.updatedAt,
                                retrievalScore: Number(c.retrievalScore.toFixed(3)),
                                textScore: Number(c.textScore.toFixed(3)),
                                fileOverlap: Number(c.fileOverlap.toFixed(3)),
                                recency: Number(c.recency.toFixed(3)),
                            })),
                            wouldShow: rankAndGate(buildHintCandidates(candidates, { files }), {
                                trigger, sessionId: ctx.sessionId,
                                config: loadSettings().gate ?? {},
                            }),
                        };
                    },
                },
                {
                    name: "record_relevance",
                    description: "Record the agent's own relevance judgment for a hint it was offered. Call this every time you decide whether to surface a hint — especially when you decide NOT to. Counts at half the weight of a user click.",
                    inputSchema: {
                        type: "object",
                        required: ["hintId", "relevant"],
                        properties: {
                            hintId: { type: "string" },
                            relevant: { type: "boolean", description: "True if you surfaced it as genuinely relevant." },
                            reason: { type: "string", description: "One short phrase, e.g. 'topically unrelated to the question'." },
                        },
                    },
                    handler: async (ctx) => {
                        const { hintId, relevant, reason } = ctx.input ?? {};
                        const known = readLog().some((e) => e.kind === "impression" && e.hintId === hintId);
                        if (!known) throw new CanvasError("unknown_hint", `No impression logged for hintId "${hintId}"`);
                        logAgentJudgment(hintId, relevant, reason);
                        broadcast();
                        return { hintId, judgment: relevant ? "agent_relevant" : "agent_irrelevant", reason: reason ?? null };
                    },
                },
                {
                    name: "configure",
                    description: "Read or change settings. `testMode: true` disables both cooldowns and the holdout so hints fire on every prompt — useful for seeing the system work, but the resulting volume is not representative.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            autoPropose: { type: "boolean", description: "Fire hints automatically on each prompt." },
                            minPromptChars: { type: "number", description: "Prompts shorter than this are skipped." },
                            testMode: { type: "boolean", description: "Zero both cooldowns and the holdout rate; false restores shipped defaults." },
                            cooldownMinutes: { type: "number", description: "Per hint-type cooldown." },
                            globalCooldownMinutes: { type: "number", description: "Cooldown across all types." },
                            scoreThreshold: { type: "number", description: "Minimum final score to show a hint." },
                            maxVisible: { type: "number", description: "Hints shown per trigger point." },
                            holdoutRate: { type: "number", description: "Fraction of trigger points deliberately shown nothing." },
                            epsilon: { type: "number", description: "Exploration rate." },
                            sessionStorePath: {
                                type: ["string", "null"],
                                description: "Absolute path to an alternative session database for evaluation runs. Pass null to restore the real one. Only the searched corpus moves; the learning log and settings stay put.",
                            },
                        },
                    },
                    handler: async (ctx) => {
                        const input = ctx.input ?? {};
                        const patch = {};
                        if (typeof input.autoPropose === "boolean") patch.autoPropose = input.autoPropose;
                        if (typeof input.minPromptChars === "number") patch.minPromptChars = input.minPromptChars;

                        if ("sessionStorePath" in input) {
                            const p = input.sessionStorePath;
                            if (p !== null && typeof p !== "string") {
                                throw new CanvasError("invalid_path", "sessionStorePath must be a string or null");
                            }
                            // Validate up front. A typo'd path would otherwise
                            // surface as "no hints ever", which looks like a
                            // ranking failure and wastes a debugging session.
                            if (p !== null) {
                                if (!existsSync(p)) throw new CanvasError("store_not_found", `No file at ${p}`);
                                try {
                                    const probe = new DatabaseSync(p, { readOnly: true });
                                    const n = probe.prepare("SELECT COUNT(*) AS n FROM search_index").get().n;
                                    probe.close();
                                    if (!n) {
                                        throw new CanvasError(
                                            "store_not_indexed",
                                            `${p} has an empty search_index. Rows written to 'turns' are not searchable until they are also written to 'search_index'.`,
                                        );
                                    }
                                } catch (err) {
                                    if (err instanceof CanvasError) throw err;
                                    throw new CanvasError("store_unreadable", `Cannot read ${p}: ${err?.message ?? err}`);
                                }
                            }
                            patch.sessionStorePath = p;
                            setSessionStore(p);
                        }

                        const current = loadSettings();
                        let gate = { ...(current.gate ?? {}) };

                        if (typeof input.testMode === "boolean") {
                            patch.testMode = input.testMode;
                            // Toggling off clears the overrides rather than
                            // leaving zeroed cooldowns silently in place.
                            gate = input.testMode ? { ...gate, ...TEST_MODE_GATE } : {};
                        }
                        for (const k of ["cooldownMinutes", "globalCooldownMinutes", "scoreThreshold", "maxVisible", "holdoutRate", "epsilon"]) {
                            if (typeof input[k] === "number") gate[k] = input[k];
                        }
                        patch.gate = gate;

                        const saved = Object.keys(input).length ? saveSettings(patch) : current;
                        broadcast();
                        return {
                            ...saved,
                            effectiveGate: { ...DEFAULT_CONFIG, ...(saved.gate ?? {}) },
                            activeSessionStore: sessionStorePath(),
                            usingFixture: sessionStorePath() !== DEFAULT_SESSION_STORE,
                        };
                    },
                },
            ],
            open: async (ctx) => {
                let entry = servers.get(ctx.instanceId);
                if (!entry) {
                    entry = await startServer(ctx.instanceId, ctx.sessionId);
                    servers.set(ctx.instanceId, entry);
                }
                // Opening with a task proposes; opening bare just rehydrates.
                //
                // `open` is re-invoked on provider reconnect, extension reload
                // and host re-focus. Re-proposing there would log a fresh
                // impression and mark the live one "ignored" — recording user
                // disinterest that never happened. So only propose when the
                // previous proposal is not still awaiting an answer.
                const task = ctx.input?.task;
                if (task) {
                    const trigger = ctx.input.trigger ?? "session_start";
                    const prev = loadProposal(ctx.sessionId);
                    const decided = new Set(
                        readLog().filter((e) => e.kind === "outcome").map((e) => e.hintId),
                    );
                    const sameProposal = prev && prev.task === task && prev.trigger === trigger;
                    const stillLive = sameProposal
                        && (prev.holdout || (prev.shown ?? []).some((h) => !decided.has(h.hintId)));

                    if (!stillLive) {
                        propose({
                            task,
                            trigger,
                            files: ctx.input.files ?? [],
                            repository: ctx.input.repository,
                            sessionId: ctx.sessionId,
                            config: loadSettings().gate ?? {},
                        });
                    }
                }
                const st = currentState(ctx.sessionId);
                const waiting = (st.rules?.active ?? []).length;
                return {
                    title: "Adaptive hints",
                    url: entry.url,
                    // A count of things needing attention, and nothing about
                    // how the system works. "2/5 accepted" means something to
                    // whoever wrote the gate and nothing to anyone else.
                    status: waiting ? `${waiting} to review` : "",
                };
            },
            onClose: async (ctx) => {
                const entry = servers.get(ctx.instanceId);
                if (entry) {
                    servers.delete(ctx.instanceId);
                    for (const res of entry.clients) {
                        try {
                            res.end();
                        } catch {
                            // Already torn down.
                        }
                    }
                    await new Promise((resolve) => entry.server.close(() => resolve()));
                }
            },
        }),
    ],
    hooks: {
        // Once per session: hand the agent the learned preferences, and the
        // list it needs in order to add to them instead of inventing
        // near-duplicates. Done at session start rather than per prompt because
        // the list is the expensive part and it does not change mid-session —
        // paying for it on every message would be the same cost many times over.
        onSessionStart: async (input, invocation) => {
            try {
                const sessionId = invocation?.sessionId;
                const repository = repositoryOf(input?.workspacePath);
                const store = syncedRules();
                const silent = silentRules({ moment: "session_start", repository }, store);
                const asking = askingRules({ moment: "session_start", repository }, store);
                const parts = [];

                // Trusted rules have been accepted five times running. They are
                // applied without asking, but never without saying so.
                if (silent.length) {
                    parts.push(
                        `[adaptive-hints] ${silent.length} remembered preference(s) applied:\n`
                        + silent.map((r) => `  - ${r.rule}`).join("\n")
                        + `\n\nFollow these. Say once, briefly, that you are applying `
                        + `${silent.length} remembered preference(s), and that the panel lists them.`,
                    );
                    logInjection(sessionId, "active_rules", silent.map((r) => r.rule).join("; "));
                }

                // Confirmed, but not yet trusted. Repetition showed the user
                // meant it; it has not yet shown that the rule was written down
                // correctly or fires at a useful moment. So it asks.
                if (asking.length) {
                    parts.push(
                        `[adaptive-hints] ${asking.length} learned preference(s) are waiting for approval `
                        + `in the "Adaptive hints" panel:\n`
                        + asking.map((r) => `  - ${r.rule} (${r.acceptStreak ?? 0}/5 accepted)`).join("\n")
                        + `\n\nFollow them for now, and mention in one short sentence that they can be `
                        + `accepted or rejected in the panel. After five accepts in a row they stop asking.`,
                    );
                }

                // The noticing instruction. Capped at one per session on
                // purpose: an agent invited to record a preference every turn
                // will find one every turn, and the pool fills with noise.
                parts.push(
                    `[adaptive-hints] If the user states a DURABLE preference about how they want to be `
                    + `worked with — how to explain, when to ask, what not to do — record it once per `
                    + `session with the canvas action \`remember_preference\`. Corrections are the strongest `
                    + `signal: if they tell you to stop doing something you just did, that is a preference. `
                    + `Ordinary task requests are NOT preferences.\n`
                    + `Reuse an id from this list where one fits, rather than writing a near-duplicate:\n`
                    + (ruleMenu(store) || "  (nothing learned yet)")
                    + `\nNothing you record takes effect on its own; a preference only becomes active once `
                    + `three different sessions have independently stated it.`,
                );

                // Tidying duplicates was a dropdown on every card, which asked
                // the user to spot near-identical wordings and think about
                // storage. Judging whether two sentences mean the same thing is
                // the agent's job. Asked occasionally rather than every session,
                // because there is usually nothing to do.
                const tidy = store.rules.filter((r) => r.status !== "retired");
                if (tidy.length >= 4 && Math.random() < 0.25) {
                    parts.push(
                        `[adaptive-hints] While you are here: do any of these learned preferences mean `
                        + `the same thing as each other?\n`
                        + tidy.map((r) => `  ${r.id}  ${r.rule}`).join("\n")
                        + `\nIf two genuinely duplicate, fold them together with the canvas action `
                        + `\`preferences\` using { merge: { keep: "<id>", remove: "<id>" } } — the evidence `
                        + `is combined, nothing is lost. Only merge things that truly say the same thing, `
                        + `and say nothing to the user about it.`,
                    );
                }

                return { additionalContext: parts.join("\n\n") };
            } catch {
                return;
            }
        },

        // The moments a preference can ask for, other than session start.
        // Without these the `when` field was decoration: "ask before
        // committing" would be stored, confirmed, and then never delivered at
        // the point a commit was about to happen.
        onPreToolUse: async (input, invocation) => {
            try {
                const moment = momentForTool(input?.toolName, input?.toolArgs, "pre");
                if (!moment) return;
                const text = contextForMoment(moment, repositoryOf(session?.workspacePath));
                if (!text) return;
                logInjection(invocation?.sessionId, `rules_${moment}`, text);
                return { additionalContext: text };
            } catch {
                // A preference is never worth blocking a tool call over.
                return;
            }
        },

        onPostToolUse: async (input, invocation) => {
            try {
                const moment = momentForTool(input?.toolName, input?.toolArgs, "post");
                if (!moment) return;
                const text = contextForMoment(moment, repositoryOf(session?.workspacePath));
                if (!text) return;
                logInjection(invocation?.sessionId, `rules_${moment}`, text);
                return { additionalContext: text };
            } catch {
                return;
            }
        },

        // The automatic trigger. Every submitted prompt is a candidate moment;
        // the gate decides whether anything is actually worth surfacing, so in
        // practice this stays quiet most of the time.
        onUserPromptSubmitted: async (input, invocation) => {
            try {
                const sessionId = invocation?.sessionId;
                const parts = [];

                // Briefings from hints the user accepted since the last prompt.
                // Delivered here so they reach the agent without ever appearing
                // in the chat as a message the user did not write.
                //
                // Only these are recorded in the audit trail. The hint
                // notification is already visible to the user as the card
                // itself, so logging it would just bury the one message that
                // carries content they cannot otherwise see.
                for (const text of takeAcceptedContext(sessionId)) {
                    parts.push(text);
                    logInjection(sessionId, "accepted_briefing", text);
                }

                const hint = autoPropose(input?.prompt, sessionId, input?.workingDirectory);
                if (hint) {
                    // The panel no longer renders a hint card — that slot now
                    // belongs to learned preferences — so this must not tell the
                    // user to accept something they cannot see. The proposal is
                    // still made and still logged, which keeps the retrieval
                    // measurements alive without putting a dead affordance in
                    // front of anyone.
                    parts.push(
                        `[adaptive-hints] A prior session may be relevant (${hint.type}, `
                        + `score ${hint.finalScore.toFixed(2)}): ${hint.body} `
                        + `There is no card for this — mention it only if it genuinely helps the user's `
                        + `request, and record your judgment with the canvas action \`record_relevance\`: `
                        + `{ hintId: "${hint.hintId}", relevant: true|false, reason: "<short phrase>" }.`,
                    );
                }

                if (!parts.length) return;
                broadcast();
                return { additionalContext: parts.join("\n\n") };
            } catch {
                // A hint is never worth failing the user's prompt over.
                return;
            }
        },
    },
});
