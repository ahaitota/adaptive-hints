// Builds the four fixture databases and their answer keys.
//
// Why four rather than seven: tests A5, A6 and A7 plant artificial sessions
// (twins differing only in size, meaning, or date). A plant left in a shared
// database becomes a false match for a different test — the "sourdough"
// incident in miniature. Tests A1 to A4 plant nothing, so they can share.
//
// Why every file still gets the full background: word rarity is computed from
// whatever is present. In a two-session database the rarest possible word and
// a common word score identically (0.69 vs 0.69), so scoring behaves nothing
// like production. Each fixture therefore carries the same ~200 varied
// background sessions plus only its own plants.

import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join, basename } from "node:path";
import { TOPICS, FILLER, renderTemplate } from "./topics.mjs";
import { A2_QUESTIONS } from "./questions-a2.mjs";
import {
    DB_DIR, buildBackground, insertSession, openFresh, rng, message, isoDaysAgo,
} from "./generate.mjs";

const BACKGROUND = 200;

function write(db, sessions, opts) {
    for (const s of sessions) insertSession(db, s, opts);
}

// ---------------------------------------------------------------------------
// core.db — used by A1 (find by own words), A2 (is it related), A3 (stay
// quiet), A4 (common words only). No plants, so nothing can skew the others.
// ---------------------------------------------------------------------------
function buildCore() {
    const path = join(DB_DIR, "core.db");
    const db = openFresh(path);
    const bg = buildBackground(BACKGROUND);
    write(db, bg);

    // A1 answer key: a sentence from the MIDDLE of a session, never its
    // summary. The summary is part of what gets searched, so using it would be
    // like hiding an egg and finding it in the same place.
    const knownItem = bg
        .filter((s) => s.turns.length >= 3)
        .slice(0, 50)
        .map((s) => ({
            query: s.turns[Math.floor(s.turns.length / 2)].user,
            expect: s.id,
        }));

    // A2 answer key: hand-written questions that behave like a real user.
    //
    // These deliberately do NOT reuse the template sentences. The first
    // version generated questions from the same templates that built the
    // sessions, so all 50 appeared word for word in the data and the test
    // scored 100% while proving nothing beyond what A1 already checks.
    const topical = A2_QUESTIONS.map(({ topic, difficulty, q }) => ({
        query: q,
        acceptable: bg.filter((s) => s.id.includes(`-${topic}-`)).map((s) => s.id),
        topic,
        difficulty,
    }));

    // A3: questions the background cannot answer. Every word here is checked
    // below to be absent from the fixture — the guard the sourdough incident
    // taught us to build.
    const impossible = [
        "how do I renew my passport before travelling abroad",
        "what temperature should I roast a leg of lamb at",
        "which vaccinations are needed for tropical countries",
        "how do I claim tax relief on charitable donations",
        "what is the best way to remove limescale from a kettle",
        "how long does concrete take to cure in cold weather",
        "what paperwork is needed to adopt a rescue greyhound",
        "how do I register a trademark for a small business",
        "which knots are used for climbing anchors",
        "how do I treat a bee sting on a child",
        "what is the notice period for ending a tenancy",
        "how do I descale an espresso machine safely",
        "which insurance covers flooding in a basement",
        "how do I apply for a fishing licence",
        "what is involved in servicing a gas boiler",
    ];

    // A4: questions built ONLY from words that are genuinely common IN THIS
    // DATABASE. Deriving them rather than using a fixed list matters: "common"
    // is relative to the corpus, and a hardcoded list can miss the words that
    // actually appear everywhere, letting the test pass while production
    // fails. These carry no information and must never produce a hint.
    const fillerOnly = [];
    {
        const probe = new DatabaseSync(join(DB_DIR, "dominance.db"), { readOnly: true });
        const total = probe.prepare(
            `SELECT COUNT(DISTINCT session_id) AS n FROM search_index`).get().n;
        const common = FILLER.filter((w) => {
            const df = probe.prepare(
                `SELECT COUNT(DISTINCT session_id) AS n FROM search_index WHERE search_index MATCH ?`,
            ).get(`"${w}"`).n;
            return df >= total * 0.25; // in at least a quarter of sessions
        });
        probe.close();
        const r2 = rng(999);
        const pool = common.length >= 6 ? common : FILLER;
        for (let i = 0; i < 10; i++) {
            fillerOnly.push(
                Array.from({ length: 9 }, () => pool[Math.floor(r2() * pool.length)]).join(" "),
            );
        }
    }

    db.close();
    return {
        path,
        key: { knownItem, topical, impossible, fillerOnly },
    };
}

// ---------------------------------------------------------------------------
// dominance.db — A4 (common words) and A5 (size bias).
//
// Contains the giant long-running session, because that is what actually
// causes both problems: a session large enough to contain every common word
// matches any question built from common words, at a confident "100%".
//
// Kept out of core.db because such a session dominates every query and would
// swamp the tests measuring whether retrieval finds the right topic at all.
// ---------------------------------------------------------------------------
function buildSizeBias() {
    const path = join(DB_DIR, "dominance.db");
    const db = openFresh(path);
    write(db, buildBackground(BACKGROUND, 12345, { withGiant: true }));

    const r = rng(4242);
    const pairs = [];
    for (let i = 0; i < 10; i++) {
        const topic = TOPICS[i % TOPICS.length];
        const subject = renderTemplate(topic.templates[i % topic.templates.length], topic);
        const iso = isoDaysAgo(20 + i); // identical dates, so only size differs

        // Both sessions say the same thing. The long one simply says more
        // around it, which is exactly how a real long session gains its unfair
        // advantage: more words means more chances to match.
        const short = {
            id: `size-short-${i}`,
            summary: `Short note on ${topic.label}`,
            createdAt: iso, updatedAt: iso,
            turns: [{ user: subject, assistant: message(r, topic, true) }],
        };
        const long = {
            id: `size-long-${i}`,
            summary: `Long thread on ${topic.label}`,
            createdAt: iso, updatedAt: iso,
            turns: [
                { user: subject, assistant: message(r, topic, true) },
                ...Array.from({ length: 79 }, () => ({
                    user: message(r, topic, true),
                    assistant: message(r, topic, true),
                })),
            ],
        };
        write(db, [short, long]);
        pairs.push({ query: subject, short: short.id, long: long.id, topic: topic.id });
    }
    db.close();
    return { path, key: { pairs } };
}

// ---------------------------------------------------------------------------
// paraphrase.db — A6. Same meaning, different words. Measures how much is lost
// by matching words rather than meaning.
// ---------------------------------------------------------------------------
const PARAPHRASES = [
    ["the tests pass locally but fail on the build server", "green on my machine, red in continuous integration"],
    ["the panel shows nothing at all", "the side view renders completely empty"],
    ["the app stops responding after a while", "it freezes up once it has been open a few hours"],
    ["results differ between runs for no clear reason", "the same input sometimes gives a different answer"],
    ["the page takes a long time to appear", "loading is sluggish before anything is drawn"],
    ["it forgets what I selected", "my choice is not kept between visits"],
    ["accented letters come out as question marks", "non english characters are mangled on save"],
    ["two people editing at once overwrite each other", "concurrent edits clobber one another"],
    ["the search returns nothing useful", "queries come back with irrelevant matches"],
    ["memory keeps climbing until it crashes", "the process grows without bound and dies"],
    ["the button does nothing when clicked", "pressing it has no visible effect"],
    ["logs are full of the same message", "identical lines repeat endlessly in the output"],
    ["it works for me but not for new users", "fresh installs hit an error existing ones do not"],
    ["numbers do not add up in the summary", "the totals disagree with the individual rows"],
    ["the connection drops intermittently", "sessions disconnect at random intervals"],
    ["updating one record changes another", "edits leak across unrelated entries"],
    ["the file is written but comes back empty", "saving succeeds yet reading returns nothing"],
    ["it is slow only with large inputs", "performance collapses past a certain size"],
    ["the wrong item is highlighted", "selection lands on a neighbouring row"],
    ["settings revert after restarting", "preferences are not persisted across launches"],
];

function buildParaphrase() {
    const path = join(DB_DIR, "paraphrase.db");
    const db = openFresh(path);
    write(db, buildBackground(BACKGROUND));

    const r = rng(777);
    const pairs = PARAPHRASES.map(([queryText, sessionText], i) => {
        const iso = isoDaysAgo(10 + i);
        const s = {
            id: `para-${i}`,
            summary: sessionText.slice(0, 60),
            createdAt: iso, updatedAt: iso,
            turns: [
                { user: sessionText, assistant: `investigated and resolved: ${sessionText}` },
                { user: `more detail on ${sessionText}`, assistant: message(r, TOPICS[i % TOPICS.length], true) },
            ],
        };
        write(db, [s]);
        // The query says the same thing in different words. A word-matching
        // system should mostly miss this; the score is the measurement.
        return { query: queryText, expect: s.id };
    });
    db.close();
    return { path, key: { pairs } };
}

// ---------------------------------------------------------------------------
// recency.db — A7. Identical content, different dates. Recency should break
// ties, not decide everything.
// ---------------------------------------------------------------------------
function buildRecency() {
    const path = join(DB_DIR, "recency.db");
    const db = openFresh(path);
    write(db, buildBackground(BACKGROUND));

    const r = rng(31337);
    const pairs = [];
    for (let i = 0; i < 10; i++) {
        const topic = TOPICS[i % TOPICS.length];
        const subject = renderTemplate(topic.templates[(i + 3) % topic.templates.length], topic);
        const body = [
            { user: subject, assistant: message(r, topic, true) },
            { user: message(r, topic, true), assistant: message(r, topic, true) },
        ];
        // Byte-identical content. The ONLY difference is the date.
        const recent = {
            id: `rec-new-${i}`, summary: `Recent: ${topic.label}`,
            createdAt: isoDaysAgo(3), updatedAt: isoDaysAgo(3), turns: body,
        };
        const old = {
            id: `rec-old-${i}`, summary: `Older: ${topic.label}`,
            createdAt: isoDaysAgo(90), updatedAt: isoDaysAgo(90), turns: body,
        };
        write(db, [recent, old]);
        pairs.push({ query: subject, recent: recent.id, old: old.id });
    }
    db.close();
    return { path, key: { pairs } };
}

// ---------------------------------------------------------------------------

function main() {
    const built = {
        // dominance first: buildCore derives its common-word list from it.
        sizeBias: buildSizeBias(),
        core: buildCore(),
        paraphrase: buildParaphrase(),
        recency: buildRecency(),
    };

    const keyPath = join(DB_DIR, "answer-key.json");
    writeFileSync(keyPath, JSON.stringify({
        // No build timestamp: it would change on every rebuild and defeat the
        // determinism the fixed seed and reference date provide.
        backgroundSessions: BACKGROUND,
        databases: Object.fromEntries(Object.entries(built).map(([k, v]) => [k, basename(v.path)])),
        core: built.core.key,
        sizeBias: built.sizeBias.key,
        paraphrase: built.paraphrase.key,
        recency: built.recency.key,
    }, null, 2), "utf8");

    for (const [name, v] of Object.entries(built)) {
        console.log(`${name.padEnd(12)} ${v.path}`);
    }
    console.log(`\nanswer key   ${keyPath}`);
}

main();
