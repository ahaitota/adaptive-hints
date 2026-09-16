// Tests for the part of preference-learning that must be deterministic.
//
// The agent's judgement is not tested here — it cannot be, offline. What IS
// tested is everything that decides whether to TRUST that judgement, which is
// where a bad rule would actually do damage.
//
//   node rules.test.mjs

import {
    addObservation, promote, rulesFor, mergeRules, retireRule, restoreRule,
    recordRuleOutcome, silentRules, askingRules,
    distinctSessions, distinctRepositories, loadRules, saveRules, ruleMenu,
} from "../src/rules.mjs";
import { join } from "node:path";
import { rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

let pass = 0, fail = 0;
function check(name, condition, detail = "") {
    if (condition) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}

const store = () => ({ version: 1, rules: [] });

console.log(`\nPreference learning — the parts that must be deterministic`);
console.log("=".repeat(62));

// --- The guarantee: one session cannot promote its own rule ----------------
//
// This is the whole safety argument. An agent that has just been told
// something will believe it matters; only evidence from OTHER sessions can
// establish that it is durable. If this test ever fails, the system can invent
// permanent rules about the user from a single conversation.
{
    const s = store();
    for (let i = 0; i < 50; i++) {
        addObservation(s, {
            rule: "Always use tabs", sessionId: "session-A",
            quote: `told you ${i}`, when: "session_start",
        });
    }
    const promoted = promote(s);
    check("50 observations from ONE session promote nothing",
        promoted.length === 0 && s.rules[0].status === "candidate",
        `status=${s.rules[0].status}`);
    check("...and they all land on a single rule, not 50 rules",
        s.rules.length === 1, `${s.rules.length} rules`);
    check("the same sentence written twice does not split the evidence", (() => {
        const s2 = store();
        addObservation(s2, { rule: "Explain in plain language.", sessionId: "A", quote: "q" });
        addObservation(s2, { rule: "explain in plain language", sessionId: "B", quote: "q" });
        addObservation(s2, { rule: "Explain in plain  language", sessionId: "C", quote: "q" });
        return s2.rules.length === 1 && promote(s2).length === 1;
    })());
    check("genuinely different rules stay separate", (() => {
        const s2 = store();
        addObservation(s2, { rule: "Explain in plain language", sessionId: "A", quote: "q" });
        addObservation(s2, { rule: "Ask before committing", sessionId: "A", quote: "q" });
        return s2.rules.length === 2;
    })());
}

// --- Three different sessions do promote -----------------------------------
{
    const s = store();
    const r = addObservation(s, { rule: "Explain in plain language", sessionId: "A", quote: "in simple words" });
    addObservation(s, { ruleId: r.id, sessionId: "B", quote: "simpler please" });
    check("two sessions is still not enough", promote(s).length === 0);
    addObservation(s, { ruleId: r.id, sessionId: "C", quote: "i dont understand" });
    const promoted = promote(s);
    check("three different sessions promote exactly one rule",
        promoted.length === 1 && promoted[0].status === "active");
    check("promoting twice does not re-promote", promote(s).length === 0);
}

// --- Scope widening is arithmetic, not opinion -----------------------------
{
    const s = store();
    const r = addObservation(s, {
        rule: "Ask before committing", scope: "repo-one", repository: "repo-one", sessionId: "A", quote: "dont commit",
    });
    addObservation(s, { ruleId: r.id, repository: "repo-two", sessionId: "B", quote: "ask first" });
    promote(s);
    check("two repositories keep the rule scoped", r.scope === "repo-one", `scope=${r.scope}`);
    addObservation(s, { ruleId: r.id, repository: "repo-three", sessionId: "C", quote: "check with me" });
    promote(s);
    check("three repositories widen it to global", r.scope === "global", `scope=${r.scope}`);
}

// --- Rules only fire at their own moment, in their own scope ---------------
{
    const s = store();
    const a = addObservation(s, { rule: "Plain language", when: "session_start", sessionId: "A", quote: "q" });
    addObservation(s, { ruleId: a.id, sessionId: "B", quote: "q" });
    addObservation(s, { ruleId: a.id, sessionId: "C", quote: "q" });
    const b = addObservation(s, {
        rule: "Ask before committing", when: "before_commit",
        scope: "my-repo", repository: "my-repo", sessionId: "A", quote: "q",
    });
    addObservation(s, { ruleId: b.id, repository: "my-repo", sessionId: "B", quote: "q" });
    addObservation(s, { ruleId: b.id, repository: "my-repo", sessionId: "C", quote: "q" });
    promote(s);

    check("a start-of-session rule fires at session start",
        rulesFor({ moment: "session_start" }, s).map((r) => r.id).join() === a.id);
    check("a commit rule does NOT fire at session start",
        !rulesFor({ moment: "session_start" }, s).some((r) => r.id === b.id));
    check("a repo rule fires in its own repository",
        rulesFor({ moment: "before_commit", repository: "my-repo" }, s).some((r) => r.id === b.id));
    check("a repo rule stays silent in another repository",
        rulesFor({ moment: "before_commit", repository: "other" }, s).length === 0);
    check("candidates never fire", (() => {
        const s2 = store();
        addObservation(s2, { rule: "Unconfirmed", when: "session_start", sessionId: "A", quote: "q" });
        return rulesFor({ moment: "session_start" }, s2).length === 0;
    })());
}

// --- Three stages: confirmed, then asking, then silent --------------------
//
// Repetition proves the user MEANT it. It cannot prove the rule was written
// down correctly or fires at a useful moment, because the user was never
// asked. So a confirmed rule still shows a card, and earns silence separately.
{
    const s = store();
    const r = addObservation(s, { rule: "Plain language", when: "session_start", sessionId: "A", quote: "q" });
    addObservation(s, { ruleId: r.id, sessionId: "B", quote: "q" });
    addObservation(s, { ruleId: r.id, sessionId: "C", quote: "q" });
    promote(s);
    check("three sessions reach 'active', NOT silent", r.status === "active", `status=${r.status}`);
    check("an active rule still asks", askingRules({}, s).length === 1 && silentRules({}, s).length === 0);

    for (let i = 0; i < 4; i++) recordRuleOutcome(s, r.id, "accepted");
    check("four accepts is not yet enough to go silent", r.status === "active", `streak=${r.acceptStreak}`);
    recordRuleOutcome(s, r.id, "accepted");
    check("the fifth accept earns silence", r.status === "trusted");
    check("a trusted rule stops asking",
        silentRules({}, s).length === 1 && askingRules({}, s).length === 0);

    recordRuleOutcome(s, r.id, "rejected");
    check("one rejection sends a silent rule back to asking",
        r.status === "active" && r.acceptStreak === 0, `status=${r.status}`);
    check("...and it must earn silence all over again", (() => {
        for (let i = 0; i < 4; i++) recordRuleOutcome(s, r.id, "accepted");
        return r.status === "active";
    })());
}

// --- A rejection part-way through resets the streak ------------------------
{
    const s = store();
    const r = addObservation(s, { rule: "X", sessionId: "A", quote: "q" });
    addObservation(s, { ruleId: r.id, sessionId: "B", quote: "q" });
    addObservation(s, { ruleId: r.id, sessionId: "C", quote: "q" });
    promote(s);
    recordRuleOutcome(s, r.id, "accepted");
    recordRuleOutcome(s, r.id, "accepted");
    recordRuleOutcome(s, r.id, "rejected");
    recordRuleOutcome(s, r.id, "accepted");
    recordRuleOutcome(s, r.id, "accepted");
    recordRuleOutcome(s, r.id, "accepted");
    recordRuleOutcome(s, r.id, "accepted");
    check("accepts must be CONSECUTIVE to earn silence",
        r.status === "active" && r.accepts === 6, `accepts=${r.accepts} streak=${r.acceptStreak}`);
    recordRuleOutcome(s, r.id, "accepted");
    check("five in a row after the rejection does earn it", r.status === "trusted");
}

// --- Outcomes are only accepted for rules that were actually offered -------
{
    const s = store();
    const r = addObservation(s, { rule: "Unconfirmed", sessionId: "A", quote: "q" });
    const threw = (fn) => { try { fn(); return false; } catch { return true; } };
    check("a candidate cannot be accepted — it was never shown",
        threw(() => recordRuleOutcome(s, r.id, "accepted")));
    check("an unknown outcome is refused", (() => {
        addObservation(s, { ruleId: r.id, sessionId: "B", quote: "q" });
        addObservation(s, { ruleId: r.id, sessionId: "C", quote: "q" });
        promote(s);
        return threw(() => recordRuleOutcome(s, r.id, "maybe"));
    })());
}

// --- The card asks a question; the agent gets an instruction --------------
//
// Showing the instruction on the card reads as the user's own words quoted
// back at them, which is a strange thing to be asked to approve.
{
    const s = store();
    const r = addObservation(s, {
        rule: "Explain in plain language",
        ask: "Would you like me to explain things in plain language?",
        sessionId: "A", quote: "in simple words",
    });
    check("a rule keeps both an instruction and a question",
        r.rule === "Explain in plain language" && /^Would you like/.test(r.ask));
    check("a later session can supply the question a first one omitted", (() => {
        const s2 = store();
        const a = addObservation(s2, { rule: "Ask before committing", sessionId: "A", quote: "q" });
        if (a.ask !== null) return false;
        addObservation(s2, { ruleId: a.id, ask: "Shall I check with you first?", sessionId: "B", quote: "q" });
        return a.ask === "Shall I check with you first?";
    })());
    check("an existing question is not overwritten", (() => {
        addObservation(s, { ruleId: r.id, ask: "Something else entirely?", sessionId: "B", quote: "q" });
        return r.ask === "Would you like me to explain things in plain language?";
    })());
    check("an instruction pasted into the question field is refused", (() => {
        const s2 = store();
        const a = addObservation(s2, {
            rule: "Do not commit without asking",
            ask: "Do not commit without asking",   // an order, not a question
            sessionId: "A", quote: "q",
        });
        // Falls back to showing the instruction, as it would with no question
        // at all — the card must never order the user around in their own words.
        return a.ask === null;
    })());
}

// --- Promotion is recomputed, not remembered -------------------------------
//
// Promotion used to run only when an observation was recorded, so a rule could
// sit at three sessions and stay a candidate if the last write came through
// some other path. Running promote() again on an already-loaded store must be
// safe and must fix it.
{
    const s = store();
    const r = addObservation(s, { rule: "X", when: "session_start", sessionId: "A", quote: "q" });
    addObservation(s, { ruleId: r.id, sessionId: "B", quote: "q" });
    addObservation(s, { ruleId: r.id, sessionId: "C", quote: "q" });
    // Simulate a store written by something that never called promote().
    r.status = "candidate";
    delete r.activatedAt;
    check("a candidate already past the bar is promoted on the next pass",
        promote(s).length === 1 && r.status === "active");
    check("promotion is idempotent", promote(s).length === 0 && r.status === "active");
    check("it does not disturb a trusted rule", (() => {
        for (let i = 0; i < 5; i++) recordRuleOutcome(s, r.id, "accepted");
        if (r.status !== "trusted") return false;
        promote(s);
        return r.status === "trusted";
    })());
}

// --- Declining repeatedly is how a preference goes away -------------------
//
// There were "turn off" and "restore" buttons. Both asked the user to manage
// storage: turning something off left a dead card in the deck, and "turn off"
// read almost the same as "decline". Saying no three times says it without a
// setting, and saying the thing again brings it back without one either.
{
    const s = store();
    const r = addObservation(s, { rule: "Y", when: "session_start", sessionId: "A", quote: "q" });
    addObservation(s, { ruleId: r.id, sessionId: "B", quote: "q" });
    addObservation(s, { ruleId: r.id, sessionId: "C", quote: "q" });
    promote(s);

    recordRuleOutcome(s, r.id, "rejected");
    recordRuleOutcome(s, r.id, "rejected");
    check("two declines still offers it", r.status === "active", `status=${r.status}`);
    recordRuleOutcome(s, r.id, "rejected");
    check("three declines in a row stops it offering itself", r.status === "declined");
    check("a stopped preference leaves the deck", rulesFor({}, s).length === 0);
    check("...and is not re-promoted by the next pass", promote(s).length === 0 && r.status === "declined");
    check("...and cannot be accepted, since it is not shown", (() => {
        try { recordRuleOutcome(s, r.id, "accepted"); return false; } catch { return true; }
    })());

    // No Restore button: saying it again is the user changing their mind.
    addObservation(s, { ruleId: r.id, sessionId: "D", quote: "q" });
    check("stating it again brings it straight back", r.status === "active" && r.declineStreak === 0);
    check("its whole history is still there", r.observations.length === 4 && r.rejects === 3);
}

// --- An accept in between resets the decline streak ------------------------
{
    const s = store();
    const r = addObservation(s, { rule: "Z", sessionId: "A", quote: "q" });
    addObservation(s, { ruleId: r.id, sessionId: "B", quote: "q" });
    addObservation(s, { ruleId: r.id, sessionId: "C", quote: "q" });
    promote(s);
    recordRuleOutcome(s, r.id, "rejected");
    recordRuleOutcome(s, r.id, "rejected");
    recordRuleOutcome(s, r.id, "accepted");
    recordRuleOutcome(s, r.id, "rejected");
    recordRuleOutcome(s, r.id, "rejected");
    check("declines must be consecutive to stop it",
        r.status === "active", `status=${r.status} streak=${r.declineStreak}`);
    recordRuleOutcome(s, r.id, "rejected");
    check("three in a row after that does stop it", r.status === "declined");
}

// --- Turning a preference off is a decision, and it sticks ----------------
//
// Restoring must not demand three fresh mentions — the evidence never went
// away — and re-stating a preference while it is off must not create a second
// rule that promotes itself and quietly overrides the user.
{
    const s = store();
    const r = addObservation(s, { rule: "Test rule", ask: "Do X?", sessionId: "A", quote: "q" });
    addObservation(s, { ruleId: r.id, sessionId: "B", quote: "q" });
    addObservation(s, { ruleId: r.id, sessionId: "C", quote: "q" });
    promote(s);
    retireRule(s, r.id);
    check("turning off keeps every observation", r.observations.length === 3);
    restoreRule(s, r.id);
    promote(s);
    check("restoring brings it straight back, no new mentions needed", r.status === "active");

    retireRule(s, r.id);
    const again = addObservation(s, { rule: "Test rule", sessionId: "D", quote: "q" });
    check("re-stating it while off does not create a second rule",
        again.id === r.id && s.rules.length === 1, `${s.rules.length} rules`);
    check("...and it comes back, since there is no Restore button to press",
        r.status === "active", `status=${r.status}`);
    check("the new evidence is still recorded", r.observations.length === 4);
}

// --- Merge keeps the evidence ----------------------------------------------
{
    const s = store();
    const a = addObservation(s, { rule: "Plain language", sessionId: "A", quote: "simple" });
    const b = addObservation(s, { rule: "Use simple words", sessionId: "B", quote: "simpler" });
    addObservation(s, { ruleId: b.id, sessionId: "C", quote: "easy words" });
    mergeRules(s, a.id, b.id);
    check("merge folds the other rule away", s.rules.length === 1);
    check("merge keeps every observation", distinctSessions(s.rules[0]) === 3,
        `${distinctSessions(s.rules[0])} sessions`);
    check("a merged rule can now be promoted", promote(s).length === 1);
}

// --- Retired rules stay dead ------------------------------------------------
{
    const s = store();
    const r = addObservation(s, { rule: "Bad rule", when: "session_start", sessionId: "A", quote: "q" });
    addObservation(s, { ruleId: r.id, sessionId: "B", quote: "q" });
    addObservation(s, { ruleId: r.id, sessionId: "C", quote: "q" });
    promote(s);
    retireRule(s, r.id);
    check("a retired rule stops firing", rulesFor({ moment: "session_start" }, s).length === 0);
    check("a retired rule is not re-promoted", promote(s).length === 0 && r.status === "retired");
    check("a retired rule is hidden from the agent's menu", !ruleMenu(s).includes(r.id));
    check("a retired rule can be restored", (() => {
        restoreRule(s, r.id);
        return r.status === "candidate" && promote(s).length === 1;
    })(), "retire must be undoable — the evidence is real conversations");
}

// --- Bad input is refused ---------------------------------------------------
{
    const s = store();
    const threw = (fn) => { try { fn(); return false; } catch { return true; } };
    check("an observation without a session is refused",
        threw(() => addObservation(s, { rule: "x", quote: "q" })));
    check("an observation for an unknown rule is refused",
        threw(() => addObservation(s, { ruleId: "r999", sessionId: "A", quote: "q" })));
    check("a rule cannot be merged into itself",
        threw(() => mergeRules(s, "r1", "r1")));
}

// --- Round-trips through disk unchanged -------------------------------------
{
    const path = join(tmpdir(), `adaptive-hints-rules-test-${process.pid}.json`);
    const s = store();
    const r = addObservation(s, { rule: "Plain language", sessionId: "A", quote: "simple" });
    addObservation(s, { ruleId: r.id, sessionId: "B", quote: "simpler" });
    saveRules(s, path);
    const back = loadRules(path);
    check("saving and loading preserves the rules",
        JSON.stringify(back) === JSON.stringify(s));
    rmSync(path, { force: true });
    check("a missing file loads as empty rather than crashing",
        loadRules(join(tmpdir(), "definitely-not-here.json")).rules.length === 0);
    check("the test left no file behind", !existsSync(path));
}

console.log("=".repeat(62));
console.log(`${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
