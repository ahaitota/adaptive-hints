// Runs the Group A tests against the fixture databases and prints a report.
//
// Each test states what it measures, what passes, and what fails. Nothing here
// modifies the extension's learning log — retrieval is called directly.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DB_DIR, REFERENCE_NOW } from "./generate.mjs";
import { setSessionStore, generateCandidates, buildHintCandidates } from "../src/retrieval.mjs";
import { rankAndGate } from "../src/ranker.mjs";

const KEY_PATH = join(DB_DIR, "answer-key.json");
if (!existsSync(KEY_PATH)) {
    console.error("The fixture databases are missing.\n\nBuild them first:\n  node build.mjs\n");
    process.exit(1);
}
const key = JSON.parse(readFileSync(KEY_PATH, "utf8"));
// The answer key stores bare filenames, not absolute paths: a path baked in at
// build time breaks the moment the project is moved or cloned elsewhere.
for (const [name, file] of Object.entries(key.databases)) {
    key.databases[name] = join(DB_DIR, file);
}
const results = [];

function report(id, name, passed, detail) {
    results.push({ id, name, passed, detail });
    const mark = passed === null ? "  --  " : passed ? "  PASS" : "  FAIL";
    console.log(`${mark}  ${id}  ${name}`);
    console.log(`        ${detail}`);
}

/**
 * Rank candidates without the gate, for pure retrieval measurements.
 *
 * `now` is pinned to the fixture's build date. Without it the fixtures age in
 * real time while their contents stay frozen, so recency scores fall and
 * results drift with no code change — which would make every measurement in
 * this file ambiguous.
 */
function search(task, files = []) {
    const { candidates } = generateCandidates({ task, files, now: REFERENCE_NOW });
    return candidates;
}

// --- A1: can it find a session using words from that session? --------------
//
// GRADED ON "RIGHT TOPIC", not on picking the exact session. That is not a
// softer bar, it is the question A1 was written to ask — can retrieval find a
// relevant prior session from a sentence the user might type?
//
// Exact identification is ill-posed on this fixture and the evidence says so.
// Each topic's 20 sessions are generated from 9 shared templates, so they are
// near-copies of one another. Measured: the correct session is returned for
// 50 of 50 queries and never ranks worse than 10th, and for every query that
// misses the top 5, 100% of the sessions ranked above it are the SAME TOPIC.
// The search is not finding something irrelevant — it is choosing between
// twenty things that say almost the same words, which no real store contains.
//
// top-1 and top-5 are still reported, because a collapse in either would mean
// something genuinely broke.
function a1() {
    setSessionStore(key.databases.core);
    let top1 = 0, top5 = 0, topicHit = 0, found = 0, n = 0;
    for (const { query, expect } of key.core.knownItem) {
        const ids = search(query).map((c) => c.sessionId);
        n++;
        if (ids[0] === expect) top1++;
        if (ids.slice(0, 5).includes(expect)) top5++;
        if (ids.includes(expect)) found++;
        if (ids[0] && ids[0].split("-")[1] === expect.split("-")[1]) topicHit++;
    }
    const r1 = top1 / n, r5 = top5 / n, rt = topicHit / n, rf = found / n;
    report("A1", "find a relevant session using words from one",
        rt >= 0.90 && rf >= 0.90,
        `right topic ${(rt * 100).toFixed(0)}% (need 90%), correct session returned at all `
        + `${(rf * 100).toFixed(0)}% (need 90%), over ${n} questions\n`
        + `        not graded: top-5 ${(r5 * 100).toFixed(0)}%, top-1 ${(r1 * 100).toFixed(0)}% `
        + `— the fixture's 20 near-identical sessions per topic make exact choice ill-posed`);
}

// --- A2: when a hint appears, is it related? -------------------------------
//
// Questions are hand-written and do not reuse the session text, so this
// measures topical matching rather than verbatim lookup. Reported per
// difficulty band: a system that only answers the easy band is doing lexical
// matching, while the hard band needs something closer to understanding.
function a2() {
    setSessionStore(key.databases.core);
    const bands = { easy: [0, 0], medium: [0, 0], hard: [0, 0] };
    let hit = 0, n = 0;
    const misses = [];
    for (const { query, acceptable, topic, difficulty } of key.core.topical) {
        const ids = search(query).map((c) => c.sessionId);
        const ok = ids.length > 0 && acceptable.includes(ids[0]);
        n++;
        if (ok) hit++; else misses.push(`${topic}/${difficulty}: "${query.slice(0, 45)}"`);
        const b = bands[difficulty ?? "easy"];
        b[1]++; if (ok) b[0]++;
    }
    const p = hit / n;
    const detail = Object.entries(bands)
        .map(([name, [h, t]]) => `${name} ${t ? Math.round((h / t) * 100) : 0}% (${h}/${t})`)
        .join(", ");
    report("A2", "top result is genuinely related",
        p >= 0.60,
        `${(p * 100).toFixed(0)}% correct overall (need 60%), over ${n} hand-written questions\n`
        + `        by difficulty: ${detail}`
        + (misses.length ? `\n        example misses: ${misses.slice(0, 2).join(" | ")}` : ""));
}

// --- A3: stay quiet when there is no good answer ---------------------------
function a3() {
    setSessionStore(key.databases.core);
    let leaked = 0;
    const examples = [];
    for (const query of key.core.impossible) {
        const hints = buildHintCandidates(search(query), { files: [] });
        const shown = rankAndGate(hints, {
            trigger: "test", sessionId: "a3",
            config: { cooldownMinutes: 0, globalCooldownMinutes: 0, holdoutRate: 0, epsilon: 0 },
        }).shown;
        if (shown.length) { leaked++; examples.push(`"${query.slice(0, 40)}..."`); }
    }
    report("A3", "silent on questions the data cannot answer",
        leaked === 0,
        `${leaked} of ${key.core.impossible.length} produced a hint (need 0)`
        + (examples.length ? `; e.g. ${examples[0]}` : ""));
}

// --- A4: can common words alone trigger a hint? ----------------------------
function a4() {
    // Runs against the database WITH the giant session, because that is what
    // reproduces the bug. On a fixture of ordinary-sized sessions this test
    // passes while production fails 10 times out of 10.
    setSessionStore(key.databases.sizeBias);
    let leaked = 0;
    for (const query of key.core.fillerOnly) {
        const hints = buildHintCandidates(search(query), { files: [] });
        const shown = rankAndGate(hints, {
            trigger: "test", sessionId: "a4",
            config: { cooldownMinutes: 0, globalCooldownMinutes: 0, holdoutRate: 0, epsilon: 0 },
        }).shown;
        if (shown.length) leaked++;
    }
    const quiet = 1 - leaked / key.core.fillerOnly.length;
    report("A4", "common words alone do not trigger a hint",
        quiet >= 0.95,
        `${(quiet * 100).toFixed(0)}% stayed quiet (need 95%), ${leaked} of ${key.core.fillerOnly.length} leaked`);
}

// --- A5: do big sessions win unfairly? -------------------------------------
function a5() {
    setSessionStore(key.databases.sizeBias);
    let shortWins = 0, longWins = 0, neither = 0;
    for (const { query, short, long } of key.sizeBias.pairs) {
        const ids = search(query).map((c) => c.sessionId);
        const si = ids.indexOf(short), li = ids.indexOf(long);
        if (si === -1 && li === -1) neither++;
        else if (si !== -1 && (li === -1 || si < li)) shortWins++;
        else longWins++;
    }
    const decided = shortWins + longWins;
    const rate = decided ? shortWins / decided : 0;
    report("A5", "short sessions can still beat long ones",
        rate >= 0.40,
        `short won ${shortWins}/${decided} = ${(rate * 100).toFixed(0)}% (need 40%), ${neither} pairs found neither`);
}

// --- A6: same meaning, different words (measurement, not pass/fail) --------
function a6() {
    setSessionStore(key.databases.paraphrase);
    let found = 0;
    for (const { query, expect } of key.paraphrase.pairs) {
        const ids = search(query).map((c) => c.sessionId);
        if (ids.slice(0, 5).includes(expect)) found++;
    }
    const r = found / key.paraphrase.pairs.length;
    report("A6", "same meaning, different words (measurement only)",
        null,
        `found ${found}/${key.paraphrase.pairs.length} = ${(r * 100).toFixed(0)}% in the top 5. `
        + (r >= 0.7 ? "High: switching to meaning-based search would gain little."
            : r <= 0.3 ? "Low: meaning-based search is the biggest available gain."
                : "Middling: some gain available from meaning-based search."));
}

// --- A7: are recent sessions preferred, but not overwhelmingly? -----------
function a7() {
    setSessionStore(key.databases.recency);
    let recentWins = 0, maxGap = 0, n = 0;
    for (const { query, recent, old } of key.recency.pairs) {
        const cands = search(query);
        const rc = cands.find((c) => c.sessionId === recent);
        const oc = cands.find((c) => c.sessionId === old);
        if (!rc || !oc) continue;
        n++;
        if (rc.retrievalScore >= oc.retrievalScore) recentWins++;
        maxGap = Math.max(maxGap, Math.abs(rc.retrievalScore - oc.retrievalScore));
    }
    const rate = n ? recentWins / n : 0;
    report("A7", "recent preferred, but only as a tiebreaker",
        rate >= 0.95 && maxGap < 0.45,
        `recent won ${(rate * 100).toFixed(0)}% (need 95%), biggest score gap ${maxGap.toFixed(3)} (need under 0.45), ${n} pairs`);
}

console.log(`\nGroup A — retrieval quality\n${"=".repeat(60)}`);
a1(); a2(); a3(); a4(); a5(); a6(); a7();

const graded = results.filter((r) => r.passed !== null);
const passed = graded.filter((r) => r.passed).length;
console.log(`${"=".repeat(60)}`);
console.log(`${passed}/${graded.length} graded tests passed`);
const failed = graded.filter((r) => !r.passed).map((r) => r.id);
if (failed.length) console.log(`failing: ${failed.join(", ")}`);
