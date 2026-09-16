# Evaluation fixtures

Fake session databases for testing the hints, plus the answer keys and a test
runner.

## Running it

Two commands, from this folder:

```
cd <project folder>/test

node run-group-a.mjs    # run the tests (about a minute)
node build.mjs          # rebuild the fake databases
node ask.mjs "..."      # ask the fake data a question by hand
node check-real.mjs     # compare old and new settings on the REAL store
node tune-real.mjs      # sweep the cutoff against the REAL store
node sweep-gates.mjs    # sweep both gates against the fake data
```

`run-group-a.mjs` is the one you want day to day. `build.mjs` is only needed
after changing `topics.mjs` or `generate.mjs` — or if `db/` has been deleted,
in which case the runner says so rather than failing obscurely.

`check-real.mjs` and `tune-real.mjs` open the real session store **read-only**
and write nothing. They exist because the fixtures have been wrong three times
now, and a setting that looks good on synthetic data is not evidence.

**The tests never touch real data.** They read the fixture databases directly,
so the learning log, settings and real session history are untouched. The live
extension keeps pointing at the real store throughout.

**`db/` can be deleted freely.** It is about 23 MB of generated files and
`node build.mjs` recreates it byte for byte.

**One failure is expected.** A2 fails on purpose. The fixtures would pass it at
a lower coverage cutoff, but the real store showed that setting producing false
hints with no gain in recall, so the cutoff stayed where the real data wanted
it. Closing A2 needs meaning-based search, not tuning.

### Honest limits of this fake data

The session text is **generated, not written**, but it reads as English. A
generated message looks like:

> `About the evening trial 21. No steam in the oven means a pale crust and a
> thick shell. Any idea what causes that?`

with a reply like:

> `Short answer, yes. Scoring at a shallow angle gives a better ear on the loaf.
> Give it about 6 days and see if it settles.`

It is assembled from sentence frames rather than composed, so it repeats itself
across sessions and occasionally says something odd. What matters is that it is
readable — an unreadable fixture cannot be checked by eye, and the first version
hid a real bug for exactly that reason.

It is built to have the right *statistical shape* — word frequencies matching
the real store (93% rare against 92%), realistic session lengths and message
sizes, believable topic vocabulary — because that shape is what the scoring
actually reacts to.

What this fixture **can** test: does the search find the right topic, does it
stay quiet when it should, do long sessions win unfairly, is recency a
tiebreaker or a decider.

What it **cannot** test: whether a hint is useful to a person, whether the
phrasing of a card reads well, or whether real conversational language behaves
like this generated language. Those need real sessions and real judgement.

The A2 questions are the exception — hand-written, and the closest thing here to
a real user. They are also the only part of the fixture where the answer key
reflects human judgement rather than construction.

## Building

```
node test/build.mjs      # rebuild all four databases
node test/run-group-a.mjs # run the Group A tests
```

Building is deterministic — a fixed random seed and a fixed reference date mean
rebuilding produces byte-identical databases, so a change in test results
reflects a change in the code rather than a reshuffle of the data. (Verified:
two consecutive builds produce the same file hash.)

### Nothing measures whether a hint was actually *useful*

Every test in Group A measures whether retrieval found the right **subject**.
None measures whether the session it found contained guidance worth having.

Accepting a hint is a **prediction** — it looks useful at click time. The system
recorded 210 impressions, 10 accepts and 4 delivered briefings, and never once
checked what those briefings changed.

`hint-value.mjs` starts closing that gap from data already on disk: it compares
how much of a briefing's distinctive vocabulary appears in the agent's next
reply against replies from **before** the briefing arrived, which it cannot have
influenced. The control is the whole point — any two messages in one project
share vocabulary, so a raw overlap number would repeat the mistake that made the
first version of A2 score 100% while proving nothing.

First run, on 4 briefings: one showed **+10%**, three showed about **0%**. With
n=4 that is not evidence of anything; the script exists so the data accumulates
instead of being discarded.

Two limits worth stating: it counts words, so it misses guidance the agent
followed without reusing the vocabulary, and it cannot separate guidance that
was *useful* from guidance that was merely *echoed*.

The stronger measurement is already half-built and unused: the gate withholds a
hint 8% of the time on purpose (13 holdouts so far), which is the right
experiment design — but no outcome is recorded afterwards, so the arm proves
nothing yet.

### Which signals identify guidance worth reusing?

Nothing in the system separates a reusable instruction from incidental chat.
`repeated-guidance.mjs` tests the cheapest candidate signal: **an instruction
the user repeats in more than one session is a standing preference**, and
repetition needs no model to detect.

It combines two cues — the sentence has instruction shape (*always, never,
don't, instead, prefer, only*) rather than question shape, and it recurs across
sessions.

**The first run found the wrong thing, and that is the useful part.** Its top
"standing preferences" were lines like *"Bind to loopback only"* and *"Read the
bundled SDK docs first"* — text from the canvas-authoring skill, stored in
`turns.user_message` because the session store keeps whatever was submitted,
not only what a person typed.

Runtime text repeats **word for word** across sessions. A human rephrases every
time. So repetition, applied naively, finds the boilerplate and misses the
person:

```
                                   raw      filtered through prompt-filter
  instruction-shaped sentences     402                164
  repeated across 2+ sessions       39                  1
```

**38 of the 39 were documentation.** The single survivor is genuine:

```
  [2 sessions, 2 times]
     "i dont understand this, can you explain in simple words ..."
     "i dont understand this comment, can you make it in simple words ..."
```

That is this user's real standing preference, recovered with no model.

Two conclusions. **`prompt-filter.mjs` matters for stored data, not just live
prompts** — it is currently applied only to incoming prompts, and anything that
mines session history needs it too. And **repetition is high precision, very
low recall**: one true positive out of 164 candidates, because 46 sessions is
not many and people rarely phrase the same request identically twice.

## Preference learning

An agent **notices**, code **confirms**.

A single session cannot know whether a request is a standing preference or a
one-off — it has seen one conversation. So the agent may only record an
**observation**, tagged with its session. Confirmation is arithmetic over
distinct session IDs, which one session cannot fake.

That guarantee is structural, not a promise: `addObservation` has no status
field, and `promote()` is the only function that writes one. The first test in
`rules.test.mjs` fires 50 observations from a single session and asserts that
**nothing** is activated.

```
node backfill.mjs              which past sessions have real messages
node backfill.mjs --batch 1    read one batch, and notice preferences in it
node observe.mjs --session <id> --rule "..." --when ... --quote "..."
node observe.mjs --list
node observe.mjs --promote
```

There is no keyword matching anywhere in this. The agent is shown the existing
rule list and either adds weight to an id or writes a new one-line rule; code
only counts. That is the step that found six preferences in this database where
word-counting found one.

**Run on real history, it works.** Reading four past sessions produced:

```
  ACTIVE
    r1  Explain in plain language                      4 sessions
    r3  Give me the commands so I can run them myself  3 sessions
    r4  Open the result so I can see it                3 sessions

  CANDIDATES
    r2  Do not commit or push without asking first   [2/3 sessions]
```

`r2` being held back is the system working, not failing — two sessions is
coincidence, three is a habit.

Reading real sessions also corrected the design: the list of moments a rule can
fire at was invented, and had nowhere to put *"open it in VS Code so I can see"*.
`after_changes` exists because the data asked for it.

Rules live in `artifacts/rules.json`, which is gitignored — it is personal data,
with quotes from real conversations.

## Files

| File | Purpose |
| --- | --- |
| `topics.mjs` | 10 unrelated subject areas with distinctive vocabulary |
| `generate.mjs` | Session generator and database schema |
| `build.mjs` | Builds the four databases and the answer key |
| `run-group-a.mjs` | Runs tests A1 to A7 and prints a report |
| `ask.mjs` | Ask the fake data a question by hand and see why it answered |
| `check-real.mjs` | Old vs new settings on the real store, read-only |
| `hint-value.mjs` | Did accepted guidance reach the agent's answer? Read-only |
| `repeated-guidance.mjs` | Which instructions does the user repeat across sessions? Read-only |
| `rules.test.mjs` | Deterministic tests for preference learning |
| `backfill.mjs` | Prints what the user really typed in past sessions, read-only |
| `observe.mjs` | Records a noticed preference; lists and promotes rules |
| `tune-real.mjs` | Sweeps the coverage cutoff against the real store, read-only |
| `rarity-real.mjs` | Tests whether word frequency can spot an empty question, read-only |
| `sweep-gates.mjs` | Sweeps coverage cutoff against the score threshold |
| `sweep-bm25.mjs` | Picks the BM25 saturation constant by measurement |
| `db/*.db` | The generated databases (rebuild rather than commit) |
| `db/answer-key.json` | Which session each question should find |

## Why four databases

| Database | Used by | Contains |
| --- | --- | --- |
| `core.db` | A1, A2, A3 | 200 background sessions, ordinary sizes |
| `dominance.db` | A4, A5 | background **plus one giant session**, and 10 short/long pairs |
| `paraphrase.db` | A6 | background + 20 same-meaning sessions |
| `recency.db` | A7 | background + 10 date twins |

Tests that plant artificial sessions need their own database, because a plant
left in a shared one becomes a false match for a different test. A1 to A3 plant
nothing, so they share.

`dominance.db` is separate for a different reason. It contains one enormous
long-running session, and such a session wins nearly every query — realistic,
but it swamps the tests measuring whether retrieval can find the right topic at
all. With the giant present, A2 dropped from 42% to 6%.

Every database still carries the full 200-session background. Word rarity is
computed from whatever is present, and in a two-session database the rarest
possible word and a common word score identically (0.69 each), so a small
isolated database would test behaviour that never occurs in reality.

## The giant session, and why it matters most

The real store contains a session of **1,036,874 characters** — a conversation
that ran for weeks. It is the **only** session containing every one of
"check, parts, started, changes, point".

That single fact explains both failing tests:

- A question of ordinary words leaves about five meaningful terms once common
  ones are dropped. One million-character session contains all five somewhere,
  scores 100% coverage, and fires a confident hint about nothing.
- A long session does not match *better*, it contains *more*, so it wins more
  often.

**The filler-word problem and the size problem are the same problem**, and one
fix should address both.

Without a giant session the fixture cannot reproduce either. That was discovered
the hard way: see the warning below.

## Three things the generator must get right

**Write both tables.** Messages live in `turns`, but search reads only
`search_index`, and nothing copies between them — the real app populates the
index in its own code. A database with messages but no index returns zero
results for every query, which looks exactly like a broken ranker.

**Vary session size.** Real sessions run from 1 message to 329, median 4. The
generator draws from a long-tailed distribution to match. Uniform sizes would
make test A5 meaningless and hide how the search engine handles length.

**Match the real word distribution.** This took several attempts, and two of
them produced fixtures that quietly passed tests production fails:

| Attempt | Result | Problem |
| --- | --- | --- |
| Templates only | 621 words, 30% rare | 72 of 200 topic words never appeared |
| Even sprinkling | ~700 words, 30% rare | every topic word scored the same |
| Invented rare words | 5,936 words, 92% rare | statistics right, text unreadable |
| Real English tail | 6,300 words, 93% rare | matches real (19,601 words, 92%) |

The third attempt padded sentences with made-up syllables ("xeldrovor",
"titez"). The numbers matched but nobody could read it, so nobody could check
it by eye — and it turned out the padding itself was causing the filler-word
test to fail, for the wrong reason.

Checking what the real store's rare words actually are settled it: 9,658 of
17,232 words appear in only one session, and they look like `enabling`,
`decimal`, `report-abuse`, `non-existent`, `tool_start_name`. Real English,
hyphenated compounds and technical identifiers. Never nonsense.

**Match the real message length.** Real messages average 2,184 characters —
long replies with several paragraphs. An early fixture used one-sentence
messages averaging 292 characters, and that alone stopped it reproducing the
filler-word bug.

## Two ways a fixture can lie to you

Both of these happened here, and both looked like passing tests:

1. **The A2 questions were generated from the same templates as the sessions.**
   All 50 appeared word for word in the data, so the test scored 100% while
   proving nothing beyond "the search finds text that is present" — which A1
   already measures.

2. **The fake sessions were far too small.** Biggest 49,754 characters against
   the real 1,036,874, so the filler-word bug could not occur at all. The test
   passed on the fixture and failed 10 times out of 10 on real data.

A test that cannot fail is worse than no test. **Check a new fixture against
real behaviour before trusting its results**, otherwise it measures the fixture
rather than the system.

## Current results

```
PASS  A1  right topic 100%, correct session returned 100% (need 90%)
          not graded: top-5 88%, top-1 20%
FAIL  A2  46% overall (need 60%) — easy 75%, medium 35%, hard 10%
PASS  A3  0 of 15 impossible questions produced a hint
PASS  A4  100% stayed quiet (need 95%) — 0 of 10 leaked
PASS  A5  short sessions won 100% (need 40%)
--    A6  0% of same-meaning pairs found (measurement only)
PASS  A7  recent won 100%, biggest gap 0.374 (need under 0.45)
```

Reproducible: two consecutive runs produce byte-identical output.

A4 and A5 were fixed together by three changes: a rarity gate on the question,
coverage measured within a single message as well as across the session, and a
size penalty that only separates candidates already covering the question
equally. A2 remains the open problem and is not a tuning problem — see below.

### Tuning on fixtures alone was wrong, and real data caught it

The fixtures argued for dropping the coverage cutoff to 0.20, which took A2
from 42% to 76%. A read-only check against the real session store
(`tune-real.mjs`) showed the opposite: recall on real sentences is flat at every
setting because genuine matches land above 90%, while off-topic questions began
producing cards — 0 of 8 at 0.30, 3 of 8 at 0.20.

The fixture gain was on synthetic paraphrases; the cost was on real data. The
settings follow the real data, which is why A2 is still red. Closing it needs
meaning-based search (A6), not another threshold.

### The tests were measuring their own age

A review of the setup found a fault in the tests themselves, not in the system.

The fake sessions are built with **fixed dates**, so that rebuilding produces
identical files. But scoring asks *"how old is this session?"* using **today's
date**. So the fake sessions quietly aged in real time while their contents
stayed frozen, and every score drifted downward as the days passed.

The evidence was sitting in the report already: A7's score gap was **0.227**
when first measured and **0.193** two weeks later, with no code change in
between.

That breaks the one promise the fixtures exist to make — that a change in
results means a change in the code.

**Fixed** by giving the tests a frozen clock as well as frozen data. Two
consecutive runs now produce byte-identical output.

This corrected some numbers, and one correction mattered:

| | drifting clock | frozen clock |
| --- | --- | --- |
| A1 exact session in top 5 | 96% | 88% |
| A7 score gap | 0.193 | 0.374 |

A1 had been reading **8 points too high**. As sessions age, every recency score
sinks toward the same floor, so recency stops separating anything and the
ranking looks cleaner than it is.

### A1 now grades the question it was written to ask

With the clock fixed, A1's exact-session score was 88% against a bar of 90%.
Before moving anything, the misses were examined:

- the correct session was returned for **50 of 50** questions, never lost
- its worst rank was **10th**
- for every question that missed the top 5, **100%** of the sessions ranked
  above it were the **same topic**

So the search was never finding something irrelevant. It was choosing between
twenty sessions that say almost the same words — because each topic's 20
sessions are generated from 9 shared templates. A real session store does not
contain twenty near-copies of one conversation.

A1 is therefore graded on **"did it find a relevant session"** — right topic
100%, correct session returned 100% — and the exact-choice numbers are reported
but not graded, with the reason attached.

This was checked against the alternative explanation first: the three fixes were
tested one at a time on the frozen clock, and they **raised** A1 from 86% to
88%. The drop was entirely the clock.

### The rarity gate has a measured limit

It blocks questions built purely from universal words — verified on the real
store at 10 of 10 leaking before and 0 of 10 after. It does **not** block a
natural but empty sentence such as *"can you check that part again and look at
the changes before we start"*, which still produced an 81% match against the
real store.

Five word-frequency measures were tested as a discriminator (`rarity-real.mjs`):
rarest word, second rarest, median, mean, and a count of distinctive words.
**None separates real questions from empty ones** on a single-subject corpus —
every one overlaps, because a genuine question and an empty one draw on the same
vocabulary, and an empty sentence can still contain an unusual word.

The fixtures cannot show this: with ten unrelated subjects, *sourdough* is
distinctive and *check* is not. That gap does not exist in real data.

### A2 was circular at first, and that mattered

The first version generated its questions from the same templates used to build
the sessions. All 50 questions then appeared **word for word** in the data, and
the test scored 100% — while proving nothing beyond "the search can find text
that is literally present", which is what A1 already measures.

A test that cannot fail is worse than no test, because it produces confidence
that is not earned.

The questions are now hand-written (`questions-a2.mjs`) and phrased the way a
person would ask, not the way the sessions are worded. Only 1 of 50 now shares
wording with the data, and the honest score is **42%**.

The breakdown is the useful part:

| Difficulty | Score | What these questions do |
| --- | --- | --- |
| easy | 75% | share distinctive vocabulary ("sourdough starter", "skeg") |
| medium | 30% | describe the same thing in ordinary words |
| hard | 0% | describe the problem with no shared vocabulary at all |

That curve is the signature of word matching. "The crust comes out pale and
soft" cannot reach a session that says "no steam in the oven means a pale crust"
unless the words happen to overlap — and mostly they do not. Real users write
medium and hard questions constantly.

### Reading the failures

**A4 and A5 are the same defect.** Questions built only from common words
produce a hint every time, and long sessions win 9 of 10 against short ones
saying the same thing. Both trace to one enormous session that contains every
common word — see "The giant session" above. One fix should close both.

**A6 quantifies the ceiling.** Zero of 20 same-meaning pairs were found. Word
matching cannot bridge "the tests pass locally but fail on the build server"
and "green on my machine, red in continuous integration". This is the known
limitation, now measured: meaning-based search is the largest single
improvement available.

## Something the fixture work uncovered

Building A1 revealed that **only the first 12 meaningful words of a question are
searched**. Unique marker words appended to the end of generated sentences had
no effect on identification at all; moving them to the front took A1 from 80% to
98%.

That limit is invisible in normal use, but it means a long question is judged
almost entirely on how it opens. Two consequences worth considering:

- A user who writes several sentences of context before the actual question may
  be matched on the preamble rather than the question.
- Anything the extension prepends to a question competes for those 12 slots.

Not currently a graded test, but a plausible contributor to the poor
mid-conversation results seen in live use, and cheap to investigate.
