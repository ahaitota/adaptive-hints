// Tests for the part of preference-learning that must be deterministic.
//
// The agent's judgement is not tested here — it cannot be, offline. What IS
// tested is everything that decides whether to TRUST that judgement, which is
// where a bad rule would actually do damage.
//
//   node rules.test.mjs

import {
    addObservation, promote, rulesFor, mergeRules, retireRule,
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
