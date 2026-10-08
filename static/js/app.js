(() => {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const log = $("#log"), form = $("#form"), q = $("#q"), send = $("#send");
  const empty = $("#empty"), count = $("#count");
  const STORE = "itsc.history.v1", MAX_KEEP = 40;

  const SOURCES = {
    private_kb:            { label: "Company KB",          cls: "kb" },
    web_search:            { label: "Web search",          cls: "web" },
    direct:                { label: "Direct reply",        cls: "direct" },
    insufficient_evidence: { label: "Not enough evidence", cls: "none" },
  };

  let history = [];
  let busy = false;

  /* ---------- helpers ---------- */
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // Minimal, XSS-safe markdown: input is escaped first, then limited tags are added.
  function md(src) {
    const inline = (s) => s
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    let html = "", list = null;
    const close = () => { if (list) { html += `</${list}>`; list = null; } };
    for (const raw of esc(src).split("\n")) {
      const line = raw.trimEnd();
      let m;
      if ((m = line.match(/^\s*[-*•]\s+(.*)/))) {
        if (list !== "ul") { close(); html += "<ul>"; list = "ul"; }
        html += `<li>${inline(m[1])}</li>`;
      } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) {
        if (list !== "ol") { close(); html += "<ol>"; list = "ol"; }
        html += `<li>${inline(m[1])}</li>`;
      } else if ((m = line.match(/^#{1,4}\s+(.*)/))) {
        close(); html += `<p><strong>${inline(m[1])}</strong></p>`;
      } else if (!line.trim()) {
        close();
      } else {
        close(); html += `<p>${inline(line)}</p>`;
      }
    }
    close();
    return html;
  }

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const scrollDown = () => { log.scrollTop = log.scrollHeight; };
  const hideEmpty = () => { if (empty) empty.hidden = true; };

  function save() {
    try { localStorage.setItem(STORE, JSON.stringify(history.slice(-MAX_KEEP))); } catch (_) {}
  }

  /* ---------- rendering ---------- */
  function renderUser(text) {
    const m = el("div", "msg user");
    m.appendChild(el("div", "bubble", text));
    log.appendChild(m);
  }

  function renderBot(d, openTrace) {
    const src = SOURCES[d.source_used] || SOURCES.direct;
    const m = el("article", `msg bot ${src.cls}`);
    m.appendChild(el("span", `tag ${src.cls}`, src.label));

    const body = el("div", "body");
    body.innerHTML = md(d.answer || "");
    m.appendChild(body);

    const cites = (d.citations || []).filter((c) => c && c.title);
    if (cites.length) {
      const wrap = el("div", "cites");
      cites.forEach((c) => {
        if (c.url && /^https?:\/\//i.test(c.url)) {
          const a = el("a", "cite", c.title);
          a.href = c.url; a.target = "_blank"; a.rel = "noopener noreferrer";
          a.title = c.url;
          wrap.appendChild(a);
        } else {
          wrap.appendChild(el("span", "cite", c.title));
        }
      });
      m.appendChild(wrap);
    }

    if (d.rewritten_query && d.question && d.rewritten_query !== d.question) {
      m.appendChild(el("p", "rewrite", `Searched again as: ${d.rewritten_query}`));
    }

    if (d.trace && d.trace.length) {
      const det = el("details", "trace");
      if (openTrace) det.open = true;
      det.appendChild(el("summary", null, `How this answer was found (${d.trace.length} steps)`));
      const ol = el("ol");
      d.trace.forEach((t) => {
        const [step, ...rest] = String(t).split(" → ");
        const li = el("li");
        li.appendChild(el("span", "step", step));
        if (rest.length) li.appendChild(el("span", "res", rest.join(" → ")));
        ol.appendChild(li);
      });
      det.appendChild(ol);
      m.appendChild(det);
    }

    const tools = el("div", "tools");
    const copy = el("button", "link", "Copy answer");
    copy.type = "button";
    copy.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(d.answer || ""); copy.textContent = "Copied"; }
      catch (_) { copy.textContent = "Copy failed"; }
      setTimeout(() => (copy.textContent = "Copy answer"), 1600);
    });
    tools.appendChild(copy);
    m.appendChild(tools);

    log.appendChild(m);
  }

  function renderError(msg, question) {
    const m = el("article", "msg bot none error");
    m.appendChild(el("span", "tag none", "Something went wrong"));
    m.appendChild(el("div", "body")).innerHTML = `<p>${esc(msg)}</p>`;
    const tools = el("div", "tools");
    const retry = el("button", "link", "Try again");
    retry.type = "button";
    retry.addEventListener("click", () => { m.remove(); ask(question, true); });
    tools.appendChild(retry);
    m.appendChild(tools);
    log.appendChild(m);
  }

  function typingNode() {
    const m = el("div", "msg bot");
    const t = el("div", "typing");
    const bars = el("span", "bars");
    bars.innerHTML = "<i></i><i></i><i></i>";
    const label = el("span", null, "Searching knowledge base…");
    t.append(bars, label);
    m.appendChild(t);
    return { node: m, label };
  }

  /* ---------- chat ---------- */
  async function ask(question, isRetry) {
    if (busy) return;
    busy = true; send.disabled = true;
    hideEmpty();
    if (!isRetry) { renderUser(question); history.push({ role: "user", text: question }); }

    const { node, label } = typingNode();
    log.appendChild(node); scrollDown();
    const t0 = Date.now();
    const tick = setInterval(() => {
      const s = Math.floor((Date.now() - t0) / 1000);
      label.textContent = s < 4 ? "Searching knowledge base…" : `Still working… ${s}s`;
    }, 1000);

    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 90000);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
        signal: ctrl.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const detail = Array.isArray(data.detail)
          ? "Your question must be between 2 and 3000 characters."
          : data.detail || `Server returned ${res.status}.`;
        throw new Error(detail);
      }
      data.question = question;
      node.remove();
      renderBot(data, true);
      history.push({ role: "bot", data });
      save();
    } catch (err) {
      node.remove();
      renderError(err.name === "AbortError"
        ? "The request took too long. Try a shorter question or try again."
        : err.message || "Could not reach the server.", question);
    } finally {
      clearInterval(tick); clearTimeout(timeout);
      busy = false; send.disabled = false;
      scrollDown(); q.focus();
    }
  }

  function restore() {
    try { history = JSON.parse(localStorage.getItem(STORE) || "[]"); } catch (_) { history = []; }
    if (!Array.isArray(history) || !history.length) { history = []; return; }
    hideEmpty();
    history.forEach((h, i) => {
      if (h.role === "user") renderUser(h.text);
      else if (h.data) renderBot(h.data, i === history.length - 1);
    });
    scrollDown();
  }

  /* ---------- composer ---------- */
  const fit = () => {
    q.style.height = "auto";
    q.style.height = Math.min(q.scrollHeight, 180) + "px";
    const n = q.value.length;
    count.hidden = n < 2500;
    count.textContent = `${n}/3000`;
  };
  q.addEventListener("input", fit);
  q.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const v = q.value.trim();
    if (v.length < 2) return;
    q.value = ""; fit();
    ask(v);
  });
  $("#chips").addEventListener("click", (e) => {
    if (e.target.tagName === "BUTTON") ask(e.target.textContent);
  });
  $("#newChat").addEventListener("click", () => {
    if (history.length && !confirm("Clear this conversation?")) return;
    history = []; save();
    log.querySelectorAll(".msg").forEach((n) => n.remove());
    empty.hidden = false; q.focus();
  });

  /* ---------- server health ---------- */
  async function health() {
    const box = $("#health"), txt = box.querySelector("span");
    try {
      const r = await fetch("/api/health", { cache: "no-store" });
      if (!r.ok) throw 0;
      box.className = "status ok"; txt.textContent = "Server online";
    } catch (_) {
      box.className = "status down"; txt.textContent = "Server unreachable";
    }
  }

  /* ---------- ingest dialog ---------- */
  const dlg = $("#ingest"), fileIn = $("#file"), keyIn = $("#adminKey");
  const msg = $("#ingestMsg"), ibtn = $("#ingestBtn"), drop = $("#drop");
  const setMsg = (t, cls) => { msg.textContent = t; msg.className = "msg " + (cls || ""); };

  $("#openIngest").addEventListener("click", () => {
    keyIn.value = sessionStorage.getItem("itsc.key") || "";
    setMsg(""); dlg.showModal();
  });
  fileIn.addEventListener("change", () => {
    $("#fileName").textContent = fileIn.files[0] ? fileIn.files[0].name : "Choose a file or drop it here";
  });
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, () => drop.classList.add("over")));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove("over")));

  $("#ingestForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = fileIn.files[0];
    if (!f) return setMsg("Choose a file first.", "err");
    if (f.size > 20 * 1024 * 1024) return setMsg("File is larger than 20 MB.", "err");
    ibtn.disabled = true; setMsg("Uploading and indexing…");
    const fd = new FormData(); fd.append("file", f);
    try {
      const res = await fetch("/api/ingest", { method: "POST", headers: { "X-Admin-Key": keyIn.value }, body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.detail === "string" ? data.detail : `Upload failed (${res.status}).`);
      sessionStorage.setItem("itsc.key", keyIn.value);
      setMsg(`Indexed ${data.file}: ${data.chunks} chunks.`, "ok");
      fileIn.value = ""; $("#fileName").textContent = "Choose a file or drop it here";
    } catch (err) {
      setMsg(err.message, "err");
    } finally { ibtn.disabled = false; }
  });

  /* ---------- init ---------- */
  restore(); health(); setInterval(health, 30000); fit(); q.focus();
})();