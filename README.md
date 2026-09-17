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

The folder name matters: extensions are discovered as immediate subdirectories
of `~/.copilot/extensions/`. If `COPILOT_HOME` is set, use that instead of
`~/.copilot`.

Then restart the Copilot app, or run `/extensions reload` in the CLI.

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

Open the **Adaptive hints** panel from the app to see preferences as they
appear. It opens by itself the first time there is something to answer.

## Where your data lives

```
~/.copilot/extensions/adaptive-hints/artifacts/
```

Quotes from your own conversations, so it is gitignored and never leaves your
machine. Delete the folder to reset everything.

## More

- **[DESIGN.md](DESIGN.md)** — how it works and why each decision was made,
  including the mistakes that shaped it.
