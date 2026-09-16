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
  .body {
    color: var(--text-color-muted, #8b949e); margin: 0.45rem 0 0.85rem; overflow-wrap: anywhere;
    display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden;
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
  .sent { margin-top: 1.4rem; border-top: 1px solid var(--border-color-default, #30363d); padding-top: 0.85rem; }
  .sent > details > summary {
    cursor: pointer; color: var(--text-color-muted, #8b949e);
    font-size: 0.85rem; list-style: none; user-select: none;
  }
  .sent > details > summary::-webkit-details-marker { display: none; }
  .sent > details > summary::before { content: "\\25B8"; display: inline-block; margin-right: 0.4rem; transition: transform .12s; }
  .sent > details[open] > summary::before { transform: rotate(90deg); }
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
  .card .quote { font-style: italic; margin-top: 0.3rem; opacity: .85; }
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
</style>
</head>
<body>
<h2>Adaptive hints</h2>
<div class="sub" id="ctx">Loading…</div>
<div id="hints"></div>
<div class="sent">
  <details>
    <summary id="sentsum">Accepted context sent to the agent</summary>
    <div id="sentlist"></div>
  </details>
</div>

<script>
const $ = (id) => document.getElementById(id);

// Scale the panel from its real width, measured, rather than from vw units.
// Inside an iframe a vw-based clamp is not re-evaluated when the frame is
// resized until some other repaint happens, so the panel looked stretched
// until the mouse entered it. Observing the element gives the correct size
// immediately, on the same frame as the resize.
function fitToWidth() {
  const w = document.documentElement.clientWidth || 360;
  const size = Math.max(12, Math.min(20, 8 + w * 0.0115));
  document.documentElement.style.fontSize = size.toFixed(2) + "px";
}
fitToWidth();
if (typeof ResizeObserver === "function") {
  new ResizeObserver(fitToWidth).observe(document.documentElement);
} else {
  addEventListener("resize", fitToWidth);
}

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
  const rules = state.rules || { trusted: [], active: [], candidates: [], retired: [] };
  // Candidates are deliberately absent. A preference that has not reached three
  // sessions has not been offered, so showing it would ask the user to react to
  // something the system has not decided about — and the evidence behind it is
  // still being gathered. They appear the moment they are confirmed.
  const deck = [
    ...rules.active,
    ...(rules.trusted || []),
    ...(rules.retired || []),
  ];
  const waiting = rules.active.length;
  const learning = (rules.candidates || []).length;

  $("ctx").innerHTML = (deck.length
    ? \`\${waiting ? \`\${waiting} waiting for you\` : "Nothing waiting"} · \${deck.length} preference\${deck.length === 1 ? "" : "s"}\`
      + (learning ? \` · \${learning} still being learned\` : "")
    : "Nothing learned yet. A preference is offered once three different sessions have stated it.")
    + (state.testMode ? ' <span class="testbadge">TEST MODE — cooldowns &amp; holdout off</span>' : "")
    + (state.fixtureStore ? \` <span class="testbadge">FIXTURE DB — \${esc(state.fixtureStore.split(/[\\\\/]/).pop())}</span>\` : "");

  const box = $("hints");
  box.innerHTML = "";

  if (!deck.length) {
    box.innerHTML = '<div class="empty">Nothing to approve yet. Say how you like to be worked with '
      + '— "explain in simple words", "ask before committing" — and once three different '
      + 'sessions have said it, it will appear here.'
      + (learning ? \` <br><br>\${learning} preference\${learning === 1 ? " is" : "s are"} still gathering evidence.\` : "")
      + '</div>';
  } else {
    if (page >= deck.length) page = 0;
    const r = deck[page];
    const el = document.createElement("div");
    el.className = "row";
    el.innerHTML = \`
      <div class="bulb">&#128161;</div>
      <div class="card \${r.status === "retired" ? "off" : ""}">
        <div class="card-head">
          <div class="title">\${esc(r.ask || r.rule)}</div>
          <div class="pager">
            <button \${deck.length < 2 ? "disabled" : ""} data-nav="-1" title="Previous preference">&lt;</button>
            <span>\${page + 1} / \${deck.length}</span>
            <button \${deck.length < 2 ? "disabled" : ""} data-nav="1" title="Next preference">&gt;</button>
          </div>
        </div>
        <div class="body">
          \${r.ask ? \`as a rule: \${esc(r.rule)}\` : ""}
          \${r.quotes && r.quotes.length ? \`<div class="quote">You said: "\${esc(r.quotes[r.quotes.length - 1])}"</div>\` : ""}
        </div>
        <div class="verdict \${r.status === "trusted" ? "yes" : ""}">\${
          r.status === "trusted" ? \`Applied without asking · \${r.accepts} accepted in a row\`
          : r.status === "active" ? \`Waiting for your answer · \${r.streak || 0}/5 accepted · \${5 - (r.streak || 0)} more to stop asking\`
          : \`Turned off · \${r.sessions} session\${r.sessions === 1 ? "" : "s"} of evidence kept\`
        }</div>
        <div class="actions">
          \${deck.length > 1 && r.status !== "retired" ? \`<select data-merge="\${r.id}"
            title="These two mean the same thing — fold this card into that one, keeping both sets of evidence">
            <option value="">merge into…</option>\${
              deck.filter(o => o.id !== r.id && o.status !== "retired")
                  .map(o => \`<option value="\${o.id}">\${esc((o.rule || "").slice(0, 30))}</option>\`).join("")
            }</select>\` : ""}
          <div class="spacer"></div>
          \${r.status === "active" ? \`
            <button class="primary" data-act="accept" data-id="\${r.id}"
              title="Apply this. Five in a row and it stops asking.">Yes, please</button>
            <button data-act="reject" data-id="\${r.id}"
              title="Do not apply it now. Resets the count to zero.">Not this time</button>\` : ""}
          \${r.status === "retired"
            ? \`<button data-act="restore" data-id="\${r.id}" title="Use this preference again">Restore</button>\`
            : \`<button data-act="retire" data-id="\${r.id}"
                title="Stop using this preference. Its evidence is kept and it can be restored."
              >Turn off</button>\`}
        </div>
      </div>\`;
    box.appendChild(el);

    el.querySelectorAll("[data-nav]").forEach(b => b.onclick = () => {
      page = (page + Number(b.dataset.nav) + deck.length) % deck.length;
      render();
    });

    const post = async (body) => {
      el.querySelectorAll("button").forEach(x => x.disabled = true);
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
      if (b.dataset.act === "retire") return post({ retire: id });
      if (b.dataset.act === "restore") return post({ restore: id });
    });
    const sel = el.querySelector("select[data-merge]");
    if (sel) sel.onchange = () => {
      if (sel.value) post({ merge: { keep: sel.value, remove: sel.dataset.merge } });
    };
  }

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
