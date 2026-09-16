// Prepares past sessions so preferences can be learned from them today.
//
// Waiting for new sessions would take weeks. The history already holds the
// answer: 46 sessions and hundreds of real messages. This reads them, strips
// the runtime text, and prints what the user actually typed, grouped by
// session, so an agent can read it and record observations.
//
// The filtering is not optional. The session store keeps whatever was
// submitted, so skill documentation and system reminders sit in the same
// `user_message` field as the person's own words, with nothing marking which is
// which. Measured on this database: without the filter, 38 of the 39 most
// "repeated preferences" were lines from an authoring manual.
//
// Read-only. Writes nothing.
//
//   node backfill.mjs                 list sessions, most messages first
//   node backfill.mjs <sessionId>     print one session's real messages
//   node backfill.mjs --batch 3       print the 3rd batch of 5 sessions

import { DatabaseSync } from "node:sqlite";
import { DEFAULT_SESSION_STORE } from "../src/retrieval.mjs";
import { extractUserTask } from "../src/prompt-filter.mjs";

const BATCH_SIZE = 5;
const MAX_CHARS = 400;

const db = new DatabaseSync(DEFAULT_SESSION_STORE, { readOnly: true });
const meta = new Map(db.prepare(`SELECT id, summary, repository FROM sessions`).all()
    .map((r) => [r.id, r]));
const turns = db.prepare(
    `SELECT session_id, turn_index, user_message FROM turns
     WHERE user_message IS NOT NULL ORDER BY session_id, turn_index`).all();
db.close();

/** What the person typed, with runtime text and documentation removed. */
function spoken(message) {
    const task = extractUserTask(message, { minChars: 1 });
    if (!task) return null;
    const lines = task.split(/\n+/).map((l) => l.trim())
        // Documentation shape: bullets, headings, fenced code, bold markup.
        .filter((l) => l && !/^[-*>#|]|^\d+\.\s|\*\*|`{3}/.test(l));
    if (!lines.length) return null;
    const text = lines.join(" ").replace(/\s+/g, " ").trim();
    return text.length >= 10 ? text.slice(0, MAX_CHARS) : null;
}

const bySession = new Map();
for (const t of turns) {
    const text = spoken(t.user_message);
    if (!text) continue;
    if (!bySession.has(t.session_id)) bySession.set(t.session_id, []);
    bySession.get(t.session_id).push({ turn: t.turn_index, text });
}

const sessions = [...bySession.entries()]
    .map(([id, msgs]) => ({
        id,
        summary: meta.get(id)?.summary || "(no summary)",
        repository: meta.get(id)?.repository || null,
        msgs,
    }))
    .sort((a, b) => b.msgs.length - a.msgs.length);

const arg = process.argv[2];

function printSession(s) {
    console.log(`\n=== ${s.id}`);
    console.log(`    ${String(s.summary).replace(/\s+/g, " ").slice(0, 90)}`);
    console.log(`    repository: ${s.repository || "(none)"}   messages: ${s.msgs.length}`);
    console.log("");
    for (const m of s.msgs) console.log(`  [${String(m.turn).padStart(3)}] ${m.text}`);
}

if (!arg) {
    const total = sessions.reduce((n, s) => n + s.msgs.length, 0);
    console.log(`\n${sessions.length} sessions with real user messages (${total} messages)`);
    console.log(`${Math.ceil(sessions.length / BATCH_SIZE)} batches of ${BATCH_SIZE}\n`);
    console.log(`  batch  messages  repository            session`);
    console.log(`  -----  --------  --------------------  -------`);
    sessions.forEach((s, i) => {
        console.log(`   ${String(Math.floor(i / BATCH_SIZE) + 1).padStart(3)}     ${String(s.msgs.length).padStart(4)}    `
            + `${String(s.repository || "-").slice(0, 20).padEnd(20)}  ${s.id.slice(0, 8)}  `
            + `${String(s.summary).replace(/\s+/g, " ").slice(0, 44)}`);
    });
    console.log(`\nRead one batch at a time:  node backfill.mjs --batch 1\n`);
} else if (arg === "--batch") {
    const n = Math.max(1, Number(process.argv[3] || 1));
    const slice = sessions.slice((n - 1) * BATCH_SIZE, n * BATCH_SIZE);
    if (!slice.length) { console.log(`\nNo batch ${n}.\n`); process.exit(0); }
    console.log(`\nBatch ${n} of ${Math.ceil(sessions.length / BATCH_SIZE)}`);
    for (const s of slice) printSession(s);
    console.log("");
} else {
    const s = sessions.find((x) => x.id === arg || x.id.startsWith(arg));
    if (!s) { console.log(`\nNo session matching "${arg}".\n`); process.exit(1); }
    printSession(s);
    console.log("");
}
