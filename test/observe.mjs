// Records a preference an agent noticed in one session.
//
// This is the write end of the agent's judgement. It deliberately cannot
// activate anything: status is owned by promote(), which requires evidence from
// three different sessions. An agent — or a person — running this a hundred
// times in one session still promotes nothing.
//
//   node observe.mjs --session <id> --rule "Explain in plain language" \
//        --ask "Would you like me to explain things in plain language?" \
//        --when session_start --scope global --quote "in simple words please"
//
//   node observe.mjs --session <id> --id r1 --quote "simpler please"
//   node observe.mjs --list
//   node observe.mjs --promote

import {
    loadRules, updateRules, addObservation, promote, ruleMenu, describe,
    distinctSessions, distinctRepositories, MOMENTS, RULES_PATH,
} from "../src/rules.mjs";

const argv = process.argv.slice(2);
const flag = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? null : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

const store = loadRules();

if (has("list") || !argv.length) {
    const { trusted, active, candidates, dropped } = describe(store);
    console.log(`\nRules file: ${RULES_PATH}\n`);
    if (!store.rules.length) {
        console.log(`  Nothing learned yet.\n`);
    } else {
        console.log(`  APPLIED NOW, WITHOUT ASKING (accepted 5 times running)`);
        if (!trusted.length) console.log(`    none yet`);
        for (const r of trusted) {
            console.log(`    ${r.id}  ${r.rule}`);
            console.log(`        when: ${r.when}   scope: ${r.scope}   `
                + `${distinctSessions(r)} sessions, ${distinctRepositories(r)} repos`);
        }
        console.log(`\n  APPLIED NOW, AND ASKS EACH TIME (the ask is whether to keep it)`);
        if (!active.length) console.log(`    none yet — needs 3 different sessions`);
        for (const r of active) {
            console.log(`    ${r.id}  ${r.rule}`);
            console.log(`        when: ${r.when}   scope: ${r.scope}   `
                + `${distinctSessions(r)} sessions, ${distinctRepositories(r)} repos   `
                + `${r.acceptStreak ?? 0}/5 accepts in a row`);
        }
        console.log(`\n  NOT APPLIED YET (needs 3 different sessions)`);
        if (!candidates.length) console.log(`    none`);
        for (const r of candidates) {
            console.log(`    ${r.id}  ${r.rule}   [${distinctSessions(r)}/3 sessions]`);
            for (const o of r.observations.slice(0, 2)) {
                console.log(`        "${o.quote.slice(0, 74)}"`);
            }
        }
        if (dropped.length) {
            console.log(`\n  STOPPED ASKING (declined repeatedly; say it again to bring it back)`);
            for (const r of dropped) console.log(`    ${r.id}  ${r.rule}`);
        }
        console.log("");
    }
    process.exit(0);
}

if (has("promote")) {
    let promoted = [];
    updateRules((s) => { promoted = promote(s); });
    console.log(`\n${promoted.length} rule(s) became active:`);
    for (const r of promoted) console.log(`  ${r.id}  ${r.rule}  (when: ${r.when}, scope: ${r.scope})`);
    if (!promoted.length) console.log(`  (nothing reached 3 different sessions)`);
    console.log("");
    process.exit(0);
}

const sessionId = flag("session");
if (!sessionId) {
    console.error(`--session is required. Every observation must say which conversation it came from,\n`
        + `because counting DISTINCT sessions is the only thing that makes a rule trustworthy.`);
    process.exit(1);
}

const when = flag("when") || "session_start";
if (!MOMENTS.includes(when)) {
    console.error(`--when must be one of: ${MOMENTS.join(", ")}`);
    process.exit(1);
}

try {
    let rule;
    updateRules((s) => {
        rule = addObservation(s, {
            ruleId: flag("id"),
            rule: flag("rule"),
            // The card asks a question; the agent gets an instruction. Without
            // this, a hand-recorded preference quotes the user back at themselves.
            ask: flag("ask"),
            when,
            scope: flag("scope") || "global",
            repository: flag("repo"),
            sessionId,
            quote: flag("quote") || "",
        });
    });
    console.log(`\n  ${rule.id}  ${rule.ask || rule.rule}`);
    if (!rule.ask) {
        console.log(`  no question yet — pass --ask "…?" so the card does not `
            + `quote the instruction back at the user`);
    }
    console.log(`  ${distinctSessions(rule)} of 3 sessions   status: ${rule.status}\n`);
    if (rule.status === "candidate" && distinctSessions(rule) >= 3) {
        console.log(`  Ready to activate — run:  node observe.mjs --promote\n`);
    }
} catch (e) {
    console.error(`\n  ${e.message}\n`);
    console.error(`Existing rules:\n${ruleMenu(store) || "  (none)"}\n`);
    process.exit(1);
}
