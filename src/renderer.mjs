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
  body {
    margin: 0;
    padding: 16px;
    background: var(--background-color-default, #0d1117);
    color: var(--text-color-default, #e6edf3);
    font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
    font-size: var(--text-body-medium, 14px);
    line-height: var(--leading-body-medium, 20px);
  }
  h2 {
    font-size: var(--text-title-small, 16px);
    font-weight: var(--font-weight-semibold, 600);
    margin: 0 0 4px;
  }
  .sub { color: var(--text-color-muted, #8b949e); font-size: var(--text-body-small, 12px); margin-bottom: 16px; }
  .row { display: flex; gap: 10px; align-items: flex-start; margin-bottom: 12px; }
  .bulb {
    flex: 0 0 auto; width: 20px; text-align: center;
    color: var(--true-color-yellow, #d29922); padding-top: 14px; font-size: 15px;
  }
  .card {
    flex: 1 1 auto;
    border: 1px solid var(--border-color-default, #30363d);
    border-radius: 8px;
    padding: 12px 14px;
    background: var(--background-color-inset, rgba(255,255,255,0.02));
  }
  .card-head { display: flex; align-items: center; gap: 8px; }
  .title { font-weight: var(--font-weight-semibold, 600); flex: 1 1 auto; }
  .pager { display: flex; align-items: center; gap: 4px; font-size: var(--text-body-small, 12px); color: var(--text-color-muted, #8b949e); }
  .body { color: var(--text-color-muted, #8b949e); margin: 6px 0 12px; }
  .verdict {
    font-size: 11px; margin: -6px 0 12px; padding: 5px 8px; border-radius: 6px;
    border: 1px solid var(--border-color-default, #30363d);
    color: var(--text-color-muted, #8b949e);
  }
  .verdict.yes { border-color: var(--true-color-green, #3fb950); }
  .verdict.no { border-color: var(--true-color-red-muted, rgba(248,81,73,0.4)); }
  .actions { display: flex; align-items: center; gap: 8px; }
  .spacer { flex: 1 1 auto; }
  button {
    font-family: inherit; font-size: var(--text-body-small, 12px);
    border-radius: 6px; padding: 5px 12px; cursor: pointer;
    border: 1px solid var(--border-color-default, #30363d);
    background: transparent; color: var(--text-color-default, #e6edf3);
  }
  button:hover { border-color: var(--text-color-muted, #8b949e); }
  button.primary {
    border-color: var(--true-color-blue, #1f6feb);
    background: var(--true-color-blue-muted, rgba(31,111,235,0.15));
  }
  button:disabled { opacity: .45; cursor: default; }
  .why { margin-top: 10px; border-top: 1px solid var(--border-color-default, #30363d); padding-top: 8px; display: none; }
  .why.open { display: block; }
  .why table { width: 100%; border-collapse: collapse; font-size: var(--text-body-small, 12px); }
  .why td { padding: 2px 0; color: var(--text-color-muted, #8b949e); }
  .why td.v { text-align: right; color: var(--text-color-default, #e6edf3); font-family: var(--font-mono, monospace); }
  .why tr.group td { padding-top: 8px; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; opacity: .65; }
  .why tr.sub td:first-child { padding-left: 12px; }
  .why tr.calc td { border-top: 1px solid var(--border-color-default, #30363d); padding-top: 4px; }
  .why tr.calc td, .why tr.calc td.v { color: var(--text-color-default, #e6edf3); font-weight: var(--font-weight-semibold, 600); }
  .why .formula { font-family: var(--font-mono, monospace); font-size: 10px; opacity: .6; }
  .empty {
    border: 1px dashed var(--border-color-default, #30363d);
    border-radius: 8px; padding: 16px; color: var(--text-color-muted, #8b949e);
  }
  .sent { margin-top: 20px; border-top: 1px solid var(--border-color-default, #30363d); padding-top: 12px; }
  .sent > details > summary {
    cursor: pointer; color: var(--text-color-muted, #8b949e);
    font-size: var(--text-body-small, 12px); list-style: none; user-select: none;
  }
  .sent > details > summary::-webkit-details-marker { display: none; }
  .sent > details > summary::before { content: "\\25B8"; display: inline-block; margin-right: 6px; transition: transform .12s; }
  .sent > details[open] > summary::before { transform: rotate(90deg); }
  .inj { border: 1px solid var(--border-color-default, #30363d); border-radius: 6px; margin-top: 8px; }
  .inj > summary {
    cursor: pointer; padding: 6px 10px; list-style: none; user-select: none;
    font-size: var(--text-body-small, 12px); color: var(--text-color-default, #e6edf3);
    display: flex; gap: 8px; align-items: baseline;
  }
  .inj > summary::-webkit-details-marker { display: none; }
  .inj > summary::before { content: "\\25B8"; color: var(--text-color-muted, #8b949e); transition: transform .12s; }
  .inj[open] > summary::before { transform: rotate(90deg); }
  .inj .when { color: var(--text-color-muted, #8b949e); }
  .inj .size { margin-left: auto; color: var(--text-color-muted, #8b949e); font-family: var(--font-mono, monospace); }
  .inj pre {
    margin: 0; padding: 10px; border-top: 1px solid var(--border-color-default, #30363d);
    white-space: pre-wrap; word-break: break-word;
    font-family: var(--font-mono, monospace); font-size: 11px; line-height: 1.45;
    color: var(--text-color-muted, #8b949e); max-height: 340px; overflow: auto;
  }
  .kind {
    display: inline-block; font-size: 10px; padding: 0 6px; border-radius: 10px;
    border: 1px solid var(--border-color-default, #30363d);
  }
  .badge {
    display: inline-block; font-size: 10px; padding: 1px 6px; border-radius: 10px;
    border: 1px solid var(--border-color-default, #30363d); color: var(--text-color-muted, #8b949e);
    margin-left: 6px; vertical-align: middle;
  }
  .done { color: var(--text-color-muted, #8b949e); font-size: var(--text-body-small, 12px); padding: 4px 0; }
  .testbadge {
    display: inline-block; font-size: 10px; padding: 1px 6px; border-radius: 10px;
    border: 1px solid var(--true-color-yellow, #d29922); color: var(--true-color-yellow, #d29922);
    margin-left: 6px; white-space: nowrap;
  }
  .rules { margin-top: 14px; border-top: 1px solid var(--border-color-default, #30363d); padding-top: 10px; }
  .rulecard { margin-bottom: 8px; }
  .rulecard.off { opacity: .55; }
  .rulecard .body { margin-bottom: 10px; font-size: var(--text-body-small, 12px); }
  .rulecard .quote { font-style: italic; margin-top: 4px; opacity: .85; }
  .rulecard .hint { color: var(--text-color-muted, #8b949e); font-size: var(--text-body-small, 11px); }
  .rulecard select {
    font-size: 11px; background: transparent; color: var(--text-color-muted, #8b949e);
    border: 1px solid var(--border-color-default, #30363d); border-radius: 6px; padding: 4px 6px;
  }
  .pill {
    display: inline-block; font-size: 10px; padding: 1px 7px; border-radius: 10px;
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
  // One deck, in the order that matters: things waiting on a decision first,
  // then things still gathering evidence, then what is already running, then
  // what was turned off. The pager walks all of them.
  const deck = [
    ...rules.active,
    ...rules.candidates,
    ...(rules.trusted || []),
    ...(rules.retired || []),
  ];
  const waiting = rules.active.length;

  $("ctx").innerHTML = (deck.length
    ? \`\${waiting ? \`\${waiting} waiting for you\` : "Nothing waiting"} · \${deck.length} learned preference\${deck.length === 1 ? "" : "s"}\`
    : "Nothing learned yet. A preference is offered once three different sessions have stated it.")
    + (state.testMode ? ' <span class="testbadge">TEST MODE — cooldowns &amp; holdout off</span>' : "")
    + (state.fixtureStore ? \` <span class="testbadge">FIXTURE DB — \${esc(state.fixtureStore.split(/[\\\\/]/).pop())}</span>\` : "");

  const box = $("hints");
  box.innerHTML = "";

  if (!deck.length) {
    box.innerHTML = '<div class="empty">Nothing learned yet. Say how you like to be worked with '
      + '— "explain in simple words", "ask before committing" — and after three different '
      + 'sessions it will be offered here.</div>';
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
            <button \${deck.length < 2 ? "disabled" : ""} data-nav="-1">&lt;</button>
            <span>\${page + 1} / \${deck.length}</span>
            <button \${deck.length < 2 ? "disabled" : ""} data-nav="1">&gt;</button>
          </div>
        </div>
        <div class="body">
          \${r.ask ? \`as a rule: \${esc(r.rule)}\` : ""}
          \${r.quotes && r.quotes.length ? \`<div class="quote">You said: "\${esc(r.quotes[r.quotes.length - 1])}"</div>\` : ""}
        </div>
        <div class="verdict \${r.status === "trusted" ? "yes" : ""}">\${
          r.status === "trusted" ? \`Applied without asking · \${r.accepts} accepted in a row\`
          : r.status === "active" ? \`\${badgeText(r)} · \${5 - (r.streak || 0)} more to stop asking\`
          : r.status === "candidate" ? \`Seen in \${r.sessions} of 3 sessions — not offered yet\`
          : \`Turned off · \${r.sessions} session\${r.sessions === 1 ? "" : "s"} of evidence kept\`
        }</div>
        <div class="actions">
          \${deck.length > 1 && r.status !== "retired" ? \`<select data-merge="\${r.id}">
            <option value="">merge into…</option>\${
              deck.filter(o => o.id !== r.id && o.status !== "retired")
                  .map(o => \`<option value="\${o.id}">\${esc((o.rule || "").slice(0, 30))}</option>\`).join("")
            }</select>\` : ""}
          <div class="spacer"></div>
          \${r.status === "active" ? \`
            <button class="primary" data-act="accept" data-id="\${r.id}">Yes, please</button>
            <button data-act="reject" data-id="\${r.id}">Not this time</button>\` : ""}
          \${r.status === "retired"
            ? \`<button data-act="restore" data-id="\${r.id}">Restore</button>\`
            : \`<button data-act="retire" data-id="\${r.id}">\${r.status === "candidate" ? "Discard" : "Turn off"}</button>\`}
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

function badgeText(r) {
  return \`Waiting for your answer · \${r.streak || 0}/5 accepted\`;
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
