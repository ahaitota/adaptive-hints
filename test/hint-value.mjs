// Did the guidance actually reach the agent's answer?
//
// Accepting a hint is a PREDICTION: it looks useful. Nothing afterwards ever
// checked whether it WAS useful. This closes that gap using data the extension
// already records — the injected briefing text in artifacts/injections/, and
// the agent's replies in the session store.
//
// Method: measure how much of the briefing's distinctive vocabulary appears in
// the agent's NEXT reply, and compare that against the same measure on OTHER
// replies in the same conversation.
//
// The control matters. Any two messages in one project share plenty of words,
// so a raw overlap number proves nothing — the same trap that made the first
// version of test A2 score 100% while measuring nothing. Only the DIFFERENCE
// between the next reply and the controls is evidence.
//
// Read-only. Writes nothing.
//
//   node hint-value.mjs

import { DatabaseSync } from "node:sqlite";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { DEFAULT_SESSION_STORE, extractTerms } from "../src/retrieval.mjs";

const COPILOT_HOME = process.env.COPILOT_HOME || join(homedir(), ".copilot");
const INJECTION_DIR = join(COPILOT_HOME, "extensions", "adaptive-hints", "artifacts", "injections");

if (!existsSync(INJECTION_DIR)) {
    console.error(`No injections recorded yet at ${INJECTION_DIR}`);
    process.exit(0);
}

const db = new DatabaseSync(DEFAULT_SESSION_STORE, { readOnly: true });
const totalSessions = db.prepare(
    `SELECT COUNT(DISTINCT session_id) AS n FROM search_index`).get().n || 1;
const dfStmt = db.prepare(
    `SELECT COUNT(DISTINCT session_id) AS n FROM search_index WHERE search_index MATCH ?`);

const dfCache = new Map();
function weight(term) {
    if (!dfCache.has(term)) {
        let df = 0;
        try { df = dfStmt.get(`"${term}"`).n; } catch { df = 0; }
        // Rare words carry the signal; words in every session carry none.
        dfCache.set(term, Math.log(1 + (totalSessions - df + 0.5) / (df + 0.5)));
    }
    return dfCache.get(term);
}

/** Share of the briefing's distinctive vocabulary that shows up in `reply`. */
function carryOver(briefingTerms, reply) {
    const inReply = new Set(extractTerms(reply, 4000));
    let total = 0, matched = 0;
    for (const t of briefingTerms) {
        const w = weight(t);
        total += w;
        if (inReply.has(t)) matched += w;
    }
    return total > 0 ? matched / total : 0;
}

function parseTs(v) {
    if (!v) return 0;
    const s = String(v);
    const ms = Date.parse(s.includes("T") ? s : s.replace(" ", "T") + "Z");
    return Number.isFinite(ms) ? ms : 0;
}

const results = [];
for (const file of readdirSync(INJECTION_DIR)) {
    if (!file.endsWith(".json")) continue;
    const sessionId = file.replace(/\.json$/, "");
    let items = [];
    try { items = JSON.parse(readFileSync(join(INJECTION_DIR, file), "utf8")); } catch { continue; }

    const turns = db.prepare(
        `SELECT turn_index, timestamp, assistant_response FROM turns
         WHERE session_id = ? AND assistant_response IS NOT NULL ORDER BY turn_index`)
        .all(sessionId)
        .map((t) => ({ ...t, ms: parseTs(t.timestamp) }));
    if (!turns.length) continue;

    for (const item of items) {
        if (item.kind !== "accepted_briefing") continue;
        // Drop the wrapper the extension adds, keep the prior session's content.
        const body = String(item.text || "").replace(/^\[adaptive-hints:accepted\][^\n]*\n?/, "");
        const briefingTerms = [...new Set(extractTerms(body, 4000))].filter((t) => weight(t) > 1.5);
        if (briefingTerms.length < 20) continue;

        const next = turns.find((t) => t.ms > item.at);
        if (!next) continue;

        const used = carryOver(briefingTerms, next.assistant_response);
        // Controls: other replies in the same conversation, which the briefing
        // could not have influenced because they came before it.
        const controls = turns.filter((t) => t.ms < item.at).slice(-8);
        if (controls.length < 3) continue;
        const base = controls.map((c) => carryOver(briefingTerms, c.assistant_response));
        const baseAvg = base.reduce((s, v) => s + v, 0) / base.length;

        results.push({
            session: sessionId.slice(0, 8),
            terms: briefingTerms.length,
            used, baseAvg, controls: controls.length,
            lift: used - baseAvg,
        });
    }
}
db.close();

console.log(`\nDid accepted guidance reach the agent's answer?\n`);
if (!results.length) {
    console.log(`  Not enough data yet. Need an accepted hint followed by a reply,`);
    console.log(`  with at least 3 earlier replies in the same conversation as controls.\n`);
    process.exit(0);
}

console.log(`  session  | briefing words | next reply | earlier replies | difference`);
console.log(`  ---------+----------------+------------+-----------------+-----------`);
for (const r of results) {
    const pct = (v) => `${(v * 100).toFixed(0)}%`.padStart(4);
    console.log(`  ${r.session} |      ${String(r.terms).padStart(4)}      |    ${pct(r.used)}    |`
        + `      ${pct(r.baseAvg)}       |   ${r.lift >= 0 ? "+" : ""}${(r.lift * 100).toFixed(0)}%`);
}

const avgLift = results.reduce((s, r) => s + r.lift, 0) / results.length;
console.log(`\n  ${results.length} accepted briefing(s) measured. Average difference: `
    + `${avgLift >= 0 ? "+" : ""}${(avgLift * 100).toFixed(0)}%`);
console.log(`
  "next reply" is how much of the briefing's distinctive vocabulary the agent
  used straight after receiving it. "earlier replies" is the same measure on
  replies from BEFORE the briefing arrived, which it cannot have influenced.

  A positive difference means the guidance was taken up. Near zero means the
  briefing was accepted and then ignored.

  Caution: this counts words, so it can miss guidance the agent followed
  without repeating its vocabulary, and it cannot tell useful guidance from
  guidance that was merely echoed.
`);
if (results.length < 20) {
    console.log(`  With ${results.length} sample(s) this is not yet evidence of anything. It exists so the`);
    console.log(`  data accumulates instead of being discarded.\n`);
}
