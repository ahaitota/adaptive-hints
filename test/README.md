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

**`db/` can be deleted freely.** It is about 10 MB of generated files and
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

## Files

| File | Purpose |
| --- | --- |
| `topics.mjs` | 10 unrelated subject areas with distinctive vocabulary |
| `generate.mjs` | Session generator and database schema |
| `build.mjs` | Builds the four databases and the answer key |
| `run-group-a.mjs` | Runs tests A1 to A7 and prints a report |
| `ask.mjs` | Ask the fake data a question by hand and see why it answered |
| `check-real.mjs` | Old vs new settings on the real store, read-only |
| `tune-real.mjs` | Sweeps the coverage cutoff against the real store, read-only |
| `sweep-gates.mjs` | Sweeps coverage cutoff against the score threshold |
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
PASS  A1  top-5 94% (need 90%), right topic 100%
FAIL  A2  46% overall (need 60%) — easy 75%, medium 35%, hard 10%
PASS  A3  0 of 15 impossible questions produced a hint
PASS  A4  100% stayed quiet (need 95%) — 0 of 10 leaked
PASS  A5  short sessions won 100% (need 40%)
--    A6  0% of same-meaning pairs found (measurement only)
PASS  A7  recent won 100%, biggest gap 0.193 (need under 0.45)
```

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
