# Adaptive hints

Adaptive hints notices the things you keep telling the agent — *explain things
simply*, *ask before committing* — and offers to remember them, so you stop
repeating yourself.

An agent spots a possible preference, but code decides: a preference becomes
real only after **three different sessions** have independently stated it, so
no single conversation can invent a rule about you. Once confirmed, it is
offered on a card at the moment it matters — before a change, before a commit,
after a result — and is followed **only if you accept it**. Accept the same one
five times in a row and it stops asking and just applies; decline three times
in a row and it stops offering itself, until you say the thing again.
Everything it has learned lives in one readable JSON file you can inspect,
edit, or delete at any time.

## Install

Requires **Node 22 or newer** (it uses `node:sqlite`) and the GitHub Copilot
app or CLI. There are no dependencies to install — the Copilot SDK is resolved
for you.

```bash
node --version    # must be v22 or higher
```

Clone it into your Copilot extensions folder:

```powershell
# Windows
git clone https://github.com/ahaitota/adaptive-hints.git `
  "$env:USERPROFILE\.copilot\extensions\adaptive-hints"
```

```bash
# macOS / Linux
git clone https://github.com/ahaitota/adaptive-hints.git \
  ~/.copilot/extensions/adaptive-hints
```

**Keep the folder name `adaptive-hints`.** Extensions are only discovered as
immediate subdirectories of `~/.copilot/extensions/`, and that name is also
where preferences are stored — rename it and the two stop matching. If
`COPILOT_HOME` is set, use that instead of `~/.copilot`.

Then restart the Copilot app, or run `/extensions reload` in the CLI.

### If nothing happens

On an older Node the extension fails to load silently, because `node:sqlite`
does not exist. Check the version first, then the log:

```
~/.copilot/logs/extensions/user-adaptive-hints-*.log
```

There is one log per launch. The **running** one ends with `=== ready ===`;
older files ending in `stopped-normally` are just previous reloads, not
errors. A real failure shows the exception instead.

## Check it loaded

```bash
cd ~/.copilot/extensions/adaptive-hints
node test/rules.test.mjs      # 107 tests
node test/moments.test.mjs    # 19 tests
node test/observe.mjs --list  # what it has learned so far — empty at first
```

`--list` is read-only and safe to run at any time. On a fresh install it prints
`Nothing learned yet`, which is correct: it takes three separate sessions
before anything is offered.

The panel **opens by itself** the first time there is something to answer, so
you do not need to watch for it. You can also open **Adaptive hints** from the
app yourself at any time — worth doing early, since a new install has nothing
to show until three sessions agree.

## Where the data lives

Each person's preferences stay on their own machine, under their own home
folder:

```
~/.copilot/extensions/adaptive-hints/artifacts/
```

It holds quotes from your conversations, so it is gitignored and never leaves
your machine. Nothing is sent anywhere. Delete the folder to reset everything.
