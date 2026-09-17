// Iframe renderer. The host draws no chrome around a canvas, so every
// affordance (accept, reject, pager, why-panel) is wired here and POSTs back
// to the extension's own loopback endpoints.

function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function renderHtml() {
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Adaptive hints</title>
<style>
  :root { color-scheme: light dark; }
  /* Sizes are in rem/em so the whole panel scales together. The root size is
     set from JavaScript rather than with a vw clamp: inside an iframe, vw does
     not recalculate on resize until something forces a repaint, so the panel
     sat stretched until the mouse moved over it. A ResizeObserver updates it
     the moment the panel changes width. This value is only the fallback. */
  html { font-size: 15px; }
  body {
    margin: 0;
    padding: 1.15rem;
    background: var(--background-color-default, #0d1117);
    color: var(--text-color-default, #e6edf3);
    font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
    font-size: 1rem;
    line-height: 1.45;
  }
  h2 {
    font-size: 1.15rem;
    font-weight: var(--font-weight-semibold, 600);
    margin: 0 0 0.3rem;
  }
  .sub { color: var(--text-color-muted, #8b949e); font-size: 0.85rem; margin-bottom: 1.15rem; }
  .row { display: flex; gap: 0.7rem; align-items: flex-start; margin-bottom: 0.85rem; }
  .bulb {
    flex: 0 0 auto; width: 1.4em; text-align: center;
    color: var(--true-color-yellow, #d29922); padding-top: 1em; font-size: 1.05rem;
  }
  .card {
    flex: 1 1 auto;
    min-width: 0;
    border: 1px solid var(--border-color-default, #30363d);
    border-radius: 0.55rem;
    padding: 0.85rem 1rem;
    background: var(--background-color-inset, rgba(255,255,255,0.02));
    /* Paging through cards of different heights made the whole panel jump, and
       the buttons moved under the cursor between clicks. A fixed height with
       the actions pinned to the bottom keeps every card the same shape, so
       only the words change. */
    min-height: 11.5rem;
    display: flex;
    flex-direction: column;
  }
  .card-head { display: flex; align-items: flex-start; gap: 0.6rem; flex-wrap: wrap; }
  .title {
    font-weight: var(--font-weight-semibold, 600); flex: 1 1 12ch; min-width: 0;
    overflow-wrap: anywhere;
    /* Two lines, then ellipsis: a long preference must not push the buttons
       around relative to a short one. */
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
  .pager { display: flex; align-items: center; gap: 0.3rem; font-size: 0.85rem; color: var(--text-color-muted, #8b949e); }
  .card .body {
    color: var(--text-color-muted, #8b949e); margin: 0.45rem 0 0.85rem; overflow-wrap: anywhere;
    font-style: italic;
    display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
  }
  .actions { margin-top: auto; display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
  .verdict {
    font-size: 0.78rem; margin: -0.3rem 0 0.85rem; padding: 0.35rem 0.6rem; border-radius: 0.4rem;
    border: 1px solid var(--border-color-default, #30363d);
    color: var(--text-color-muted, #8b949e);
  }
  .verdict.yes { border-color: var(--true-color-green, #3fb950); }
  .verdict.no { border-color: var(--true-color-red-muted, rgba(248,81,73,0.4)); }
  .actions { margin-top: auto; display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
  .spacer { flex: 1 1 auto; }
  button {
    font-family: inherit; font-size: 0.85rem;
    border-radius: 0.4rem; padding: 0.35rem 0.8rem; cursor: pointer;
    border: 1px solid var(--border-color-default, #30363d);
    background: transparent; color: var(--text-color-default, #e6edf3);
  }
  button:hover { border-color: var(--text-color-muted, #8b949e); }
  button.primary {
    border-color: var(--true-color-blue, #1f6feb);
    background: var(--true-color-blue-muted, rgba(31,111,235,0.15));
  }
  button:disabled { opacity: .45; cursor: default; }
  .empty {
    border: 1px dashed var(--border-color-default, #30363d);
    border-radius: 0.55rem; padding: 1.15rem; color: var(--text-color-muted, #8b949e);
  }
  .sent, .eff { margin-top: 1.4rem; border-top: 1px solid var(--border-color-default, #30363d); padding-top: 0.85rem; }
  .sent > details > summary, .eff > details > summary {
    cursor: pointer; color: var(--text-color-muted, #8b949e);
    font-size: 0.85rem; list-style: none; user-select: none;
  }
  .sent > details > summary::-webkit-details-marker,
  .eff > details > summary::-webkit-details-marker { display: none; }
  .sent > details > summary::before,
  .eff > details > summary::before { content: "\\25B8"; display: inline-block; margin-right: 0.4rem; transition: transform .12s; }
  .sent > details[open] > summary::before,
  .eff > details[open] > summary::before { transform: rotate(90deg); }
  .inj { border: 1px solid var(--border-color-default, #30363d); border-radius: 0.4rem; margin-top: 0.55rem; }
  .inj > summary {
    cursor: pointer; padding: 0.4rem 0.7rem; list-style: none; user-select: none;
    font-size: 0.85rem; color: var(--text-color-default, #e6edf3);
    display: flex; gap: 0.55rem; align-items: baseline;
  }
  .inj > summary::-webkit-details-marker { display: none; }
  .inj > summary::before { content: "\\25B8"; color: var(--text-color-muted, #8b949e); transition: transform .12s; }
  .inj[open] > summary::before { transform: rotate(90deg); }
  .inj .when { color: var(--text-color-muted, #8b949e); }
  .inj .size { margin-left: auto; color: var(--text-color-muted, #8b949e); font-family: var(--font-mono, monospace); }
  .inj pre {
    margin: 0; padding: 0.7rem; border-top: 1px solid var(--border-color-default, #30363d);
    white-space: pre-wrap; word-break: break-word;
    font-family: var(--font-mono, monospace); font-size: 0.78rem; line-height: 1.45;
    color: var(--text-color-muted, #8b949e); max-height: 24rem; overflow: auto;
  }
  .kind {
    display: inline-block; font-size: 0.72rem; padding: 0 0.45rem; border-radius: 1rem;
    border: 1px solid var(--border-color-default, #30363d);
  }
  .badge {
    display: inline-block; font-size: 0.72rem; padding: 0.05rem 0.45rem; border-radius: 1rem;
    border: 1px solid var(--border-color-default, #30363d); color: var(--text-color-muted, #8b949e);
    margin-left: 0.45rem; vertical-align: middle;
  }
  .done { color: var(--text-color-muted, #8b949e); font-size: 0.85rem; padding: 0.3rem 0; }
  .testbadge {
    display: inline-block; font-size: 0.72rem; padding: 0.05rem 0.45rem; border-radius: 1rem;
    border: 1px solid var(--true-color-yellow, #d29922); color: var(--true-color-yellow, #d29922);
    margin-left: 6px; white-space: nowrap;
  }
  .card.off { opacity: .55; }
  .card .hint { color: var(--text-color-muted, #8b949e); font-size: 0.8rem; }
  .card select {
    font-size: 0.8rem; background: transparent; color: var(--text-color-muted, #8b949e);
    border: 1px solid var(--border-color-default, #30363d); border-radius: 0.4rem; padding: 0.3rem 0.4rem;
    max-width: 14ch;
  }
  .pill {
    display: inline-block; font-size: 0.72rem; padding: 0.05rem 0.5rem; border-radius: 1rem;
    border: 1px solid var(--border-color-default, #30363d);
    color: var(--text-color-muted, #8b949e); white-space: nowrap;
  }
  .pill.on { border-color: var(--true-color-green, #3fb950); color: var(--true-color-green, #3fb950); }
  .pill.asking { border-color: var(--true-color-blue, #58a6ff); color: var(--true-color-blue, #58a6ff); }
  .eff ul { list-style: none; margin: 0; padding: 0; }
  .eff li {
    border: 1px solid var(--border-color-default, #30363d); border-radius: 0.4rem;
    margin-top: 0.55rem; padding: 0.4rem 0.7rem; font-size: 0.85rem;
  }
  .eff .meta { color: var(--text-color-muted, #8b949e); font-size: 0.74rem; }
  .eff .effrow { display: flex; align-items: center; gap: 0.5rem; }
  .eff .effrow > div:first-child { flex: 1; min-width: 0; }
  .eff .effstop {
    flex: none; font-size: 0.74rem; padding: 0.2rem 0.5rem; border-radius: 0.4rem;
    background: transparent; color: var(--text-color-muted, #8b949e);
    border: 1px solid var(--border-color-default, #30363d); cursor: pointer;
  }
  .eff .effstop:hover { color: var(--text-color-default, #1f2328); }
</style>
</head>
<body>
<h2>Adaptive hints</h2>
<div class="sub" id="ctx">Loading…</div>
<div id="hints"></div>
<div class="eff">
  <details>
    <summary id="effsum">Being followed now</summary>
    <ul id="efflist"></ul>
  </details>
</div>
<div class="sent">
  <details>
    <summary id="sentsum">Accepted context sent to the agent</summary>
    <div id="sentlist"></div>
  </details>
</div>

<script>
const $ = (id) => document.getElementById(id);

// Scale the panel from its measured width.
//
// Two separate problems here. vw units are not re-evaluated inside an iframe
// until something forces a repaint, so the size was stale; and setting the
// font size alone still left the old frame on screen, because nothing had
// invalidated it. The host repainted on the first mouse move, which is why it
// looked stretched until then.
//
// So: measure, set the size, and rebuild the card. Re-rendering is what
// actually forces the repaint; the size alone does not.
let fitPending = false;
function fitToWidth(rerender) {
  const w = document.documentElement.clientWidth || 360;
  const size = Math.max(12, Math.min(20, 8 + w * 0.0115));
  document.documentElement.style.fontSize = size.toFixed(2) + "px";
  if (rerender && typeof render === "function" && state) {
    if (fitPending) return;
    fitPending = true;
    requestAnimationFrame(() => { fitPending = false; render(); });
  }
}
fitToWidth(false);
if (typeof ResizeObserver === "function") {
  new ResizeObserver(() => fitToWidth(true)).observe(document.documentElement);
}
addEventListener("resize", () => fitToWidth(true));

let state = { hints: [], task: "", trigger: "", holdout: false, suppressed: [] };
let lastSig = null;
let page = 0;

function pct(v) { return v == null ? "–" : Math.round(v * 100) + "%"; }
function num(v) { return v == null ? "–" : (Math.round(v * 100) / 100); }
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}
function ago(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return m + " min ago";
  const h = Math.round(m / 60);
  return h < 24 ? h + " h ago" : Math.round(h / 24) + " d ago";
}

function renderEffect() {
  const list = (state.rules && state.rules.inEffect) || [];
  const when = {
    session_start: "whole session", before_changes: "before a change",
    after_changes: "after a change", before_commit: "before a commit",
    post_plan: "after a plan", every_prompt: "every message",
  };
  $("effsum").textContent = list.length
    ? \`Being followed now — \${list.length}\`
    : "Being followed now — nothing yet";
  $("efflist").innerHTML = list.map(r => \`
    <li>
      <div class="effrow">
        <div>
          <div>\${esc(r.rule)}</div>
          <div class="meta">\${when[r.when] || esc(r.when)}\${r.status === "trusted" ? " · you approved this 5 times, so it no longer asks" : ""}</div>
        </div>
        \${r.status === "trusted"
          ? \`<button class="effstop" data-relax="\${r.id}"
               title="Go back to being asked each time.">Ask me again</button>\`
          : ""}
      </div>
    </li>\`).join("");

  $("efflist").querySelectorAll("[data-relax]").forEach(b => b.onclick = async () => {
    b.disabled = true;
    await fetch("/rules", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ relax: b.dataset.relax }),
    });
    await load();
  });
}

function renderSent() {
  const list = state.injections || [];
  $("sentsum").textContent = list.length
    ? \`Accepted context sent to the agent — \${list.length} message\${list.length === 1 ? "" : "s"}\`
    : "Accepted context sent to the agent — nothing yet";
  $("sentlist").innerHTML = list.map(i => \`
    <details class="inj" data-at="\${i.at}">
      <summary>
        <span class="kind">\${esc(i.kind)}</span>
        <span class="when">\${ago(i.at)}</span>
        <span class="size">\${i.text.length} chars</span>
      </summary>
      <pre>\${esc(i.text)}</pre>
    </details>\`).join("");
}


function render() {
  // The 4s poll re-renders, which would slam every <details> shut and lose
  // scroll position mid-read. Capture what the user has open, and skip the
  // rebuild entirely when nothing has actually changed.
  const openInj = new Set([...document.querySelectorAll(".inj[open]")].map(d => d.dataset.at));
  const sentEl = document.querySelector(".sent > details");
  const sentOpen = sentEl ? sentEl.open : false;
  const whyEl = document.getElementById("why");
  const whyOpen = whyEl ? whyEl.classList.contains("open") : false;
  const prevScroll = {};
  document.querySelectorAll(".inj[open] pre").forEach(p => {
    prevScroll[p.closest(".inj").dataset.at] = p.scrollTop;
  });

  renderInner();

  const sentEl2 = document.querySelector(".sent > details");
  if (sentEl2) sentEl2.open = sentOpen;
  document.querySelectorAll(".inj").forEach(d => {
    if (openInj.has(d.dataset.at)) {
      d.open = true;
      const pre = d.querySelector("pre");
      if (pre && prevScroll[d.dataset.at] != null) pre.scrollTop = prevScroll[d.dataset.at];
    }
  });
  const whyEl2 = document.getElementById("why");
  if (whyEl2 && whyOpen) whyEl2.classList.add("open");
}

function renderInner() {
  const rules = state.rules || { trusted: [], active: [], candidates: [] };
  // Only what the user can act on. A preference that no longer asks belongs in
  // the list below, not in a card slot whose whole purpose is a question.
  const deck = rules.active || [];

  // The header carried counts — how many were waiting, how many were still
  // being learned. Those are the system's bookkeeping, not the user's, and a
  // number like "0/5" only makes sense to someone who has read the code.
  $("ctx").innerHTML = (state.testMode ? '<span class="testbadge">TEST MODE — cooldowns &amp; holdout off</span>' : "")
    + (state.fixtureStore ? \` <span class="testbadge">FIXTURE DB — \${esc(state.fixtureStore.split(/[\\\\/]/).pop())}</span>\` : "");
  $("ctx").style.display = $("ctx").innerHTML ? "" : "none";

  const box = $("hints");
  box.innerHTML = "";

  if (!deck.length) {
    box.innerHTML = rules.answeredHere
      ? '<div class="done">Thanks — that is everything for now. '
        + 'They will come round again next time.</div>'
      : rules.waitingForMoment
      ? '<div class="empty">Nothing needed right now. Your saved preferences show up '
        + 'here at the moment they apply — before a change, before a commit, '
        + 'after a result.</div>'
      : '<div class="empty">Nothing to approve yet. Say how you like to be worked with '
        + '— "explain in simple words", "ask before committing" — and once a few sessions '
        + 'have said the same thing, it will appear here.</div>';
  } else {
    if (page >= deck.length) page = 0;
    const r = deck[page];
    const el = document.createElement("div");
    el.className = "row";
    el.innerHTML = \`
      <div class="bulb">&#128161;</div>
      <div class="card">
        <div class="card-head">
          <div class="title">\${esc(r.ask || r.rule)}</div>
          <div class="pager">
            <button \${deck.length < 2 ? "disabled" : ""} data-nav="-1" title="Previous preference">&lt;</button>
            <span>\${page + 1} / \${deck.length}</span>
            <button \${deck.length < 2 ? "disabled" : ""} data-nav="1" title="Next preference">&gt;</button>
          </div>
        </div>
        <div class="body">
          \${r.quotes && r.quotes.length ? \`You said: "\${esc(r.quotes[r.quotes.length - 1])}"\` : ""}
        </div>
        <div class="verdict">Not applied until you accept it</div>
        <div class="actions">
          <div class="spacer"></div>
          <button class="primary" data-act="accept" data-id="\${r.id}"
            title="Keep working this way">Accept</button>
          <button data-act="reject" data-id="\${r.id}"
            title="Not this time. Decline it a few times and it stops asking.">Decline</button>
        </div>
      </div>\`;
    box.appendChild(el);

    el.querySelectorAll("[data-nav]").forEach(b => b.onclick = () => {
      page = (page + Number(b.dataset.nav) + deck.length) % deck.length;
      render();
    });

    const post = async (body) => {
      el.querySelectorAll("button").forEach(x => x.disabled = true);
      // Answering removes the card, so the next one should be at the top of
      // the deck rather than wherever the old index happens to land.
      page = 0;
      await fetch("/rules", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      await load();
    };
    el.querySelectorAll("[data-act]").forEach(b => b.onclick = () => {
      const id = b.dataset.id;
      if (b.dataset.act === "accept") return post({ outcome: { id, outcome: "accepted" } });
      if (b.dataset.act === "reject") return post({ outcome: { id, outcome: "rejected" } });
    });
  }

  renderEffect();
  renderSent();
}

async function load() {
  try {
    const r = await fetch("/state");
    const next = await r.json();
    // Skip the whole re-render when nothing changed — the common case for a
    // poll, and the cheapest way to stop the UI fighting the user.
    const sig = JSON.stringify(next);
    if (sig === lastSig) return;
    lastSig = sig;
    state = next;
    render();
  } catch {
    // Server gone (extension reloaded). The poll below will recover.
  }
}

// SSE gives instant updates, but the connection dies whenever the extension
// reloads — which silently leaves the panel showing stale data. Reconnect on
// error, and poll as a safety net so the panel always converges.
let es = null;
function connect() {
  try { if (es) es.close(); } catch {}
  es = new EventSource("/events");
  es.onmessage = load;
  es.onerror = () => { try { es.close(); } catch {} ; setTimeout(connect, 3000); };
}
connect();
setInterval(load, 4000);
load();
</script>
</body>
</html>`;
}

export { esc };
