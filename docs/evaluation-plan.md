# How to test the hints

This document explains how to check whether the hints are any good.

Every test says three things: what we do, what counts as passing, and what
counts as failing. It also says *why* the line was drawn there, so you can argue
with the reasoning instead of just the number.

---

## Part 1 — What we already know

Before designing tests, here is what the real data says.

### Your past sessions are fewer than they look

| | Count |
| --- | --- |
| Session records in the database | 211 |
| Sessions that actually contain messages | **43** |
| Empty ones | 168 |

The 168 empty ones were created but never used. Most have no name and no
folder. Fifty-one appeared on a single day, which means the app created them
automatically, not you.

They contain no text, so searching them finds nothing. **The real number of
sessions the hints can search is 43.**

### A few big sessions dominate everything

Sessions are very different sizes. The biggest has 329 messages. A typical one
has 4.

This matters a lot:

| Session size | How often it gets chosen as a hint |
| --- | --- |
| 30 or more messages | **14.4 times each** |
| Under 30 messages | **3.0 times each** |

Big sessions get picked almost **5 times more often**. Not because they match
better, but because they contain more words, so they match almost anything.

This explains something you noticed. "Switching to main branch" (84 messages)
kept appearing as a 100% match on questions that had nothing to do with
branches. It was not a better match. It was just a bigger one.

### The moment matters more than the hint

The same kind of hint does very differently depending on when it appears:

| Kind of hint | When it appears | How often you accepted it |
| --- | --- | --- |
| Reuse related chat | after a plan | **90%** |
| Reuse related chat | in the middle of a conversation | **14%** |

That is a six-fold difference, and it is bigger than any difference between the
kinds of hints. **When to interrupt matters more than what to say.**

### Where things stand today

- 93 hints shown, 2,627 blocked before you saw them
- You clicked on 13% of the hints you were shown
- I judged 19 out of 20 hints as not relevant

---

## Part 2 — Three kinds of test

| Kind | Runs against | Takes | Answers |
| --- | --- | --- | --- |
| **Quick checks** | small made-up examples | seconds | Is the code correct? |
| **Search checks** | a set of fake sessions | a minute | Does it find the right things? |
| **Real use** | your actual usage | weeks | Does it actually help? |

The first two run every time something changes. The third decides whether the
feature is worth keeping at all.

---

## Part 3 — The tests

### Group A — Does it find the right past session?

---

#### A1. Can it find a session using words from that session?

**What we do.** Take a sentence from the middle of session X. Search with it.
See whether session X comes back.

We use a sentence from the middle rather than the title, because the title is
part of what gets searched. Using the title would be like hiding an egg and
finding it in the same spot. It proves nothing.

**Passes if** the right session is in the top 5 at least 90% of the time, and is
the top result at least 70% of the time.

**Fails if** it is missing from the top 5 more than 10% of the time.

**Why so strict.** This is the easiest possible test, because the words came out
of that very session. Failure means something is broken — the search index, or
the way we pick words out of your question. It would not be a matter of fine
tuning.

---

#### A2. When a hint appears, is it actually related?

This is the main test.

**What we do.** Write about 50 questions. For each one, decide by hand which
past sessions would be a good answer. Do this *before* running the search, so we
are not tempted to agree with whatever comes back.

Then run the search and count how often the top result is one we marked as good.

**Passes if** the top result is right at least 60% of the time. 80% would be
good.

**Fails if** below 60%.

**Why 60%.** The hint interrupts you. If more than half are wrong, the sensible
response is to stop reading hints entirely — and once you have that habit,
improving the hints later will not bring you back. 60% is roughly where reading
the next hint is still worth your time.

**Where we stand — now measured.** The hand-marked test scores **42%**, below
the 60% bar, so this test currently fails. The breakdown is the useful part:

| Difficulty | Score | What those questions look like |
| --- | --- | --- |
| easy | 75% | share distinctive words with the session |
| medium | 30% | describe the same thing in ordinary words |
| hard | 0% | describe the problem with no shared words |

That curve is the fingerprint of word matching, and it agrees with the live
evidence: I judged 19 of 20 real hints as not relevant. Real questions are
mostly medium and hard, which is where the system scores 30% and 0%.

**A warning from building this test.** The first version generated its
questions from the same templates used to build the fake sessions. All 50 then
appeared word for word in the data, and the test scored a meaningless 100%. A
test that cannot fail is worse than no test, because the confidence it gives is
not earned. The questions are now hand-written; only 1 of 50 shares wording
with the data.

---

#### A3. Does it stay quiet when there is no good answer?

**What we do.** Ask 15 questions your history cannot possibly answer. "How do I
bake sourdough bread." "Book me a flight to Lisbon."

**Passes if** zero hints appear. Every time.

**Fails if** even one hint appears.

**Why all or nothing.** There is no acceptable number of confident answers to a
question your history cannot answer. One leak means the bar is too low, and the
same leak will happen on real questions where it is far harder to notice.

**A trap to avoid.** This is not theoretical. While testing, I used "bake
sourdough bread" as a fake question in a chat. That chat was saved to the
database. Then "sourdough" started matching — against the very conversation
where I invented it.

So the fake questions must not appear anywhere in the test data, and **this test
must be re-checked whenever the test data changes.**

---

#### A4. Can common words alone trigger a hint?

This is the failure you have been watching all day.

**Background.** The system gives rare words more weight than common ones. "The"
appears everywhere, so it means nothing. "Sourdough" appears twice, so it means
a lot.

**The problem.** With only 43 sessions, mostly about the same few topics, almost
every word counts as common. Real numbers from your database:

| Word | How much it counts |
| --- | --- |
| canvas | 0.40 — counts as common |
| use, show | 0.51, 0.59 — common |
| these, exactly | 0.76, 0.81 — common |
| retrieval, bm25 | 3.38 — counts as rare |

**"canvas" counts as a common word.** It appears in 29 of your 43 sessions. That
is arithmetically correct and completely useless. Your collection is too small
and too narrow for the maths to separate your important words from filler.

**What we do.** Write 10 questions made only of common words. Also repeat the
real failure: a question about hint scoring that matched "Switching to main
branch" only because both contained "use", "show", "exactly" and "these".

**Passes if** at least 95% produce no hint, and no hint is ever carried by
common words alone.

**Fails if** any hint is triggered entirely by common words.

**One detail.** The line between "common" and "rare" has to move as the
collection grows. With 43 sessions the highest possible score is about 3.4. With
200 sessions it is about 4.9. So the line is set as a fraction of the maximum,
not a fixed number. Otherwise the test quietly changes meaning as you add data.

---

#### A5. Do big sessions win unfairly?

**A new test, added because the data showed a real problem.**

**What we do.** Put two sessions in the test data describing the same thing. Make
one short (5 messages) and one long (80 messages). Ask a question both should
answer.

**Passes if** the short one wins at least 40% of the time.

**Fails if** the long one wins more than 80% of the time.

**Why not an even split.** Longer sessions genuinely contain more, so some
advantage is fair. But five times is not an advantage, it is a bug. Your data
shows big sessions picked 14.4 times each against 3.0 for small ones.

**Why this matters.** If a handful of long sessions win everything, adding more
sessions will not help. They will just lose to the same few giants.

---

#### A6. What happens when the words differ but the meaning is the same?

**What we do.** Write 20 pairs that mean the same thing in different words.
"Flaky test" and "intermittent CI failure". "The panel goes blank" and "canvas
renders empty".

**No pass or fail.** This is a measurement, not a test.

**What the number tells us.** The system matches words, not meaning, so it will
do badly here. The score tells us *how* badly, and therefore how much would be
gained by switching to a method that understands meaning.

If it already scores 70%, that switch is not worth the cost. If it scores 30%,
it is the most valuable change available.

**Why no pass or fail.** This is a limitation we chose on purpose. Turning a
deliberate decision into a failing test just creates a permanently red test that
everyone learns to ignore.

---

#### A7. Are recent sessions preferred?

**What we do.** Put two identical sessions in the test data. Change only the
date: one from 3 days ago, one from 90 days ago.

**Passes if** the recent one wins at least 95% of the time, *and* the score gap
stays under 0.45.

**Fails if** the old one wins, or the gap is larger than 0.45.

**Why there is a limit on both sides.** Recency should break ties, not decide
everything. If it dominates, the system just shows your most recent session
every time, and all the searching is pointless.

---

### Group B — Is each part of the scoring earning its place?

Turn one part off, re-run test A2, see whether results get worse.

| Test | What we turn off |
| --- | --- |
| B1 | Rare-word weighting — just count matching words instead |
| B2 | The word-counting part — use only the search engine's own ranking |
| B3 | The minimum-match requirement (try values from 0.2 to 0.5) |
| B4 | The preference for recent sessions (try 3 days to 60 days) |
| B5 | File matching (only applies to sessions with files) |

**Keep a part if** removing it makes results clearly worse.

**Remove it if** results stay the same or improve. Simpler is better.

**The important warning.** With 50 test questions the margin of error is about
14 percentage points either way. **You can tell 30% from 70%. You cannot tell
60% from 68%.** If a change looks like a small improvement, it is probably
noise.

Measuring small differences would need around 400 questions. So ignore any
difference under 10 points.

---

### Group C — How often do hints appear?

---

#### C1. Is the amount right?

**What we do.** Replay a week of your real messages through the normal settings
and count hints per hour of active work.

**Passes if** between 0.5 and 2 hints per hour.

**Fails if** outside that range.

**Why there is a minimum too.** This is the important part. Without a minimum,
"make the hints better" can be achieved by showing no hints at all: a perfect
score and a useless feature. The minimum prevents that.

The maximum comes from measurement. At 7.6 hints per session you clicked on
none of them. That is what led to the 45 minute gap between hints.

---

#### C2. Are the waiting periods respected?

**What we do.** Show a hint, then try to show more.

**Passes if** no hint of any kind appears for 45 minutes, none of the same kind
for 30 minutes, and every blocked hint is recorded with its reason.

**Fails if** any hint slips through early.

**Why this test exists.** This broke once already. There was a waiting period
for each kind of hint, but none across all kinds, so one hint of each kind could
appear back to back. That felt like a burst.

---

#### C3. Where should the cut-off be?

**What we do.** Try cut-offs from 0.2 to 0.7. For each, measure how often hints
are right and how many appear.

**Passes if** some cut-off satisfies both C1 and A2.

**Fails if** none does. That means filtering cannot fix this and **the search
itself has to get better.** That is a useful answer, not a disappointing one: it
tells you where to spend effort.

---

#### C4. Is every blocked hint accounted for?

**Passes if** every hint is either shown or recorded as blocked with a reason,
and the numbers add up exactly.

**Fails if** any hint disappears unexplained.

**Why.** The blocked ones are how we judge the filter. If some vanish silently,
test C3 cannot be done at all.

---

### Group D — Does it learn correctly?

---

#### D1. Does it stay neutral before it knows anything?

**Passes if,** with no history, the score is 0.5 and the adjustment is exactly
1.00, meaning no effect at all.

**Fails if** it is anything else.

**Why exactly 1.00.** A brand new user must not be punished or flattered by an
opinion nobody earned. This guards against a real bug: the system once learned a
"7% acceptance rate" from **zero clicks**, and started hiding a kind of hint
nobody had ever rejected.

---

#### D2. Does it actually learn?

**Passes if:**

- 3 rejections of a kind of hint make it stop appearing
- 5 acceptances raise its score by at least 30%
- the score always moves in the direction of the evidence, never bouncing around

**Fails if** rejections do not silence it, or the score moves the wrong way.

---

#### D3. Does it learn *when* to interrupt?

**What we do.** Feed it acceptances at one moment and rejections at another, for
the same kind of hint. Check that the two scores separate.

**Passes if** they separate by at least 0.3 within 10 examples each.

**Fails if** they stay together.

**Why this is the most important one.** Your real data already shows 0.90 versus
0.14 for the same hint at different moments. That is the biggest real effect in
the whole system, so the part that captures it needs a permanent guard.

---

#### D4. Does it occasionally try something different?

The system deliberately shows a lower-ranked hint about 1 time in 10.

**Passes if** that happens between 8% and 12% of the time.

**Fails if** it never happens, or happens more than 20% of the time.

**Why bother.** If it only ever shows its top choice, it only ever learns about
its top choice. It can never find out it was wrong about the others.

---

#### D5. Does anything fake get counted as your opinion?

**What we do.** Create 50 hints, click on none of them, and let them all be
replaced by newer ones.

**Passes if** all scores stay at exactly 0.5, with zero examples counted.

**Fails if** anything moves.

**Why.** This guards against the worst bug found so far. Hints being replaced
were recorded as "the user ignored this". Thirty-nine automatic records produced
a fake 7% score from **no clicks at all**, and the system began hiding hints
nobody had rejected.

That kind of bug is the most dangerous kind, because it looks exactly like
learning.

---

### Group E — Does accepting a hint work properly?

| # | What we check | Passes if | Fails if |
| --- | --- | --- | --- |
| E1 | Accepted context is delivered | exactly once | duplicated or lost |
| E2 | It stays invisible | nothing appears in chat | any visible message |
| E3 | No endless loop | delivered text never triggers a new hint | it triggers itself |
| E4 | Everything is written down | every delivery recorded word for word | anything unrecorded |
| E5 | Size limits | under 10 KB, at most 3 waiting | grows without limit |
| E6 | The confirmation is honest | says "will reach", names source and size | claims it already arrived |
| E7 | My opinion never dismisses a card | card stays until you click | card disappears on its own |

**Why E4 is not optional.** This extension puts text in front of me on every
message, invisibly. That is a lot of trust to ask for. An unrecorded delivery is
indistinguishable from someone sneaking in instructions, so recording everything
is a safety matter rather than a convenience.

**Why E7 exists.** This was a real bug you reported: the hint disappeared about
10 seconds after appearing, because my own judgement was being treated as your
decision.

---

### Group F — Does it fail safely?

| # | Situation | Should do |
| --- | --- | --- |
| F1 | Not a code project | no file hints, no error, other hints still work |
| F2 | Database missing or busy | no hints, no crash, no error shown to you |
| F3 | Broken request to the panel | returns an error code, keeps running |
| F4 | Text split across network chunks | text stays intact, no corrupted characters |
| F5 | Two chats open at once | hints never leak between them |
| F6 | Extension restarts mid-flight | panel recovers within 5 seconds |
| F7 | Over 200 changed files | file matching switches off rather than misbehaving |

**Every one of F3 to F6 is a bug that actually happened:** unlimited request
sizes, corrupted characters, one chat's hints appearing in another chat's panel,
and a panel that silently froze.

**The rule:** when something goes wrong, show *fewer* hints. Never crash, and
never show a wrong hint.

**Why.** A missing hint costs almost nothing. A crash or a confidently wrong
hint costs trust, and trust does not come back.

---

### Group G — Does it actually help?

---

#### G1. The comparison test — the only one that really matters

**What we do.** In 8% of the moments where a hint would appear, deliberately
show nothing. Compare those moments against the ones where a hint did appear,
over at least four weeks.

**Passes if** the moments with hints show a real improvement: fewer messages to
finish something, less re-explaining of decisions already made, or you simply
say it helped.

**Fails if** there is no difference. Then the feature is decoration, no matter
how many hints get clicked.

**Why this beats counting clicks.** Clicks measure whether hints look appealing.
Chasing that produces safe, obvious, clickable suggestions that teach you
nothing. Only this comparison separates "people click it" from "it made the work
go better".

**An honest limitation.** With one person and about 10 hints a week, this
collects very few examples per month. **It will not give a statistically solid
answer for a single user.** Treat it as a smoke alarm: a bad result means
something long before a good one does.

---

#### G2. Do my judgements match yours?

**What we do.** For hints where I judged and you also clicked, count how often
we agreed.

**Passes if** we agree at least 70% of the time. Then my judgements can stand in
for your clicks, which are rare.

**Fails if** under 50%. Then my judgements are noise and should be ignored
completely.

**Why it matters.** I produce far more judgements than you produce clicks: 19
against 12 so far. If mine are trustworthy, the shortage of data is solved. If
they are not, the current setup is actively making things worse.

**The interesting case is disagreement.** You accepting a hint I called
irrelevant is the single most useful piece of information available, because it
shows exactly what word-matching misses.

---

#### G3. Are low-scoring hints actually worse?

**What we do.** Track which accepted hints led to something concrete, grouped by
their score.

**Why this is here.** One real example makes it necessary. A hint scoring
**62%** — one of the weakest ever accepted — found a genuine bug in the code
being written at that moment. Several 100% matches were worth nothing.

**No pass or fail.** This exists to question the assumption everything else
rests on: that a higher score means a more useful hint. If low scores keep
delivering value, then raising the bar is actively harmful.

---

## Part 4 — What the test data needs

| What | For which test | How much |
| --- | --- | --- |
| Hand-marked questions | A2, B | about 50, marked before running |
| Sentences taken from sessions | A1 | 50, from the middle of sessions |
| Impossible questions | A3 | 15, none appearing in the test data |
| Common-word questions | A4 | 10 |
| Same-meaning pairs | A6 | 20 |
| Long and short pairs | A5 | 10 |
| Old and new pairs | A7 | 10 |
| Sessions with files | B5, F7 | 20 |

**How many sessions.** About 200. That is five times what you have now.

**They must cover different topics.** This is not a nice-to-have. The rare-word
maths is calculated from whatever is in the collection. Your current collection
is 43 sessions about mostly the same things, which is why "canvas" counts as
common. Building 200 fake sessions all about canvases and tests would recreate
that same problem at a larger size, and every number measured on it would be
meaningless.

Aim for at least 8 unrelated topics.

**Session sizes must vary.** Your real sessions run from 1 message to 329, with
a typical one around 4. If every fake session is the same size, test A5 cannot
work and the size bias stays hidden.

**Two tables must be filled in, not one.** The messages live in one table and
the search index in another, and nothing copies between them automatically. If
you fill in only the messages, searching finds **nothing at all** — and it will
look like the ranking is broken when really the data was never indexed.

**A cheap experiment worth doing first.** Build the test data twice: once with
50 sessions, once with 200. Run tests A2 and A4 on both.

If results improve just from having more sessions, then the main problem is
**not enough varied data**, not the matching method. That would change what to
work on next, and it costs almost nothing to find out.

---

## Part 5 — Ways to fool yourself

| Trap | Why it happens | How to avoid it |
| --- | --- | --- |
| Testing inside your own test | The chat you test in gets saved and becomes searchable | Always exclude the current chat; re-check A3 after any data change |
| Marking answers after seeing them | You end up agreeing with whatever came back | Mark first, run second, then do not change the marks |
| Reading meaning into small differences | Margin of error is 14 points at 50 questions | Ignore differences under 10 points |
| Fake data that misrepresents reality | Word rarity is calculated from your data | Spread the topics; compare against the real database |
| Measuring the easy thing | Clicks are easy to count, usefulness is not | Never report click rate without also reporting how many hints were shown |
| Too little data to be sure | One person, few hints | Treat Group G as a hint, not proof |

---

## Part 6 — What has to pass

**Must pass — these are plain bugs if they fail:**
C2, C4, D1, D2, D5, all of E, all of F.

**Must pass — quality:**
A1, A3, A4, A5, C1, and A2 above 60% wherever hints are switched on.

**Measured, but not required to pass:**
A6, all of B, G2, G3.

**Decides the feature's future:**
G1.

### Suggested order

1. **Quick checks first.** They are cheap and cover seven bugs that really
   happened.
2. **Then A3, A4 and A5.** These need about 35 questions and target the exact
   problems you have been seeing.
3. **Then the cheap experiment:** build test data at two sizes and see whether
   more data alone fixes things. If it does, skip the expensive step.
4. **Then A2.** Marking 50 questions by hand is the slow part, so do it last.
5. **Consider switching off mid-conversation hints first.** They are accepted
   14% of the time against 90% after a plan. Simply showing hints at better
   moments might improve things more than any amount of tuning — and then you
   would only need to mark questions for the moments you kept.

---

## Part 7 — What I expect to happen

Written down before the tests were built, so the results can prove me wrong.
**Results now added underneath each one.**

1. **The moment matters more than the hint.** 90% against 14% is already a
   six-fold difference. I expect the biggest gain to come from choosing when to
   interrupt.
   → *Not yet tested. Needs the Group D tests.*

2. **A large part of the problem is simply not enough varied data.** With 43
   narrow sessions the maths cannot tell important words from filler. I expect
   results to improve on a bigger, more varied collection with no change to the
   method at all.
   → **Wrong, but not for the reason first recorded.** An earlier version of
   this note claimed the fixture disproved it. That fixture was itself broken:
   its fake text was padded word-salad, and once the text was made readable the
   filler test started passing — while the real database still failed 10 times
   out of 10. Corpus size was then tested directly, at 20, 43, 80 and 200
   sessions, and made almost no difference. So more data does not fix it, but
   the reason is specific and is described below.

3. **Big sessions will keep winning.** Five times more often, in the current
   data. I expect this to need a direct fix, not just more data.
   → **Right, and it turns out to be the root cause of prediction 2 as well.**

4. **Matching by words will do badly on the same-meaning test.** Probably below
   30%.
   → **Right, and worse than predicted.** A6 scored **0 out of 20**.

5. **Click rate will look good while usefulness stays unproven.**
   → *Still true of the live data; not something the fake collection can test.*

### The actual cause of the filler-word problem

One session in the real store is 1,036,874 characters — a conversation that ran
for weeks. It is the **only** session containing every one of "check, parts,
started, changes, point".

That is the whole mechanism. A question made of ordinary words leaves perhaps
five meaningful terms after the common ones are dropped. One enormous session
contains all five somewhere in its million characters, so it scores 100% match
and the hint fires with total confidence about nothing.

It also explains the size bias: a long session does not match *better*, it
simply contains *more*, so it wins more often.

**The filler-word problem and the size problem are the same problem.**

### What this changes

- **One fix addresses both A4 and A5.** Coverage should account for how much a
  session contains, so a million-character session cannot claim a perfect match
  by accident. The usual approach is to weight by length, which the underlying
  search engine already does and this scoring layer then discards.
- **Growing the collection will not help.** Tested directly across four sizes.
- **A6 scoring zero** still makes meaning-based search the largest single
  improvement available, and it is independent of the above.

### A warning the fixture work produced

Twice now, a fixture has quietly passed a test that production fails:

1. The A2 questions were generated from the same templates as the sessions, so
   every question appeared verbatim in the data and the test scored a
   meaningless 100%.
2. The fake sessions were far smaller than real ones (biggest 49,754 characters
   against 1,036,874), so the filler-word bug could not occur at all.

Both looked like passing tests. **A fixture must be checked against real
behaviour before its results are trusted**, otherwise it measures the fixture
rather than the system.
