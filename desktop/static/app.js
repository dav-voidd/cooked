/* Cooked frontend */
const $ = (s, el = document) => el.querySelector(s);
const view = $("#view");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
let STATE = null, pollTimer = null, Q = null;

async function api(path, body, method) {
  const opt = {method: method || (body !== undefined ? "POST" : "GET"), headers: {}};
  if (body !== undefined) { opt.headers["Content-Type"] = "application/json"; opt.body = JSON.stringify(body); }
  const r = await fetch("/api/" + path, opt);
  const data = await r.json().catch(() => ({error: "Bad response"}));
  if (!r.ok) { const e = new Error(data.error || r.statusText); e.blocked = data.blocked; e.status = r.status; throw e; }
  return data;
}
function toast(msg, cls = "", ms = 4200) {
  const t = document.createElement("div"); t.className = "toast " + cls; t.innerHTML = msg;
  const box = $("#toasts"); box.appendChild(t); setTimeout(() => t.remove(), ms);
  while (box.children.length > 4) box.firstElementChild.remove();
}
function fail(e) { toast("⚠️ " + esc(e.message || e), "err", 6500); }
setInterval(() => fetch("/api/ping").catch(() => {}), 3000);

/* ---------------- header chips ---------------- */
function renderChips(p) {
  if (!p) return;
  $("#chips").innerHTML = `
    <div class="chip ${p.studied_today ? "hot" : "cold"}" title="Daily streak${p.studied_today ? "" : " (study today to keep it!)"}">🔥 ${p.day_streak}</div>
    <div class="chip ${p.combo >= 5 ? "hot" : ""}" title="Current combo (best ${p.best_combo})">⚡ x${p.combo}</div>
    <div class="chip lvl" title="${p.into}/${p.need} XP to next level">
      <span>Lv ${p.level} · ${esc(p.rank)}</span><div class="bar"><i style="width:${Math.round(100 * p.into / p.need)}%"></i></div>
    </div>`;
}
async function refreshState() { STATE = await api("state"); renderChips(STATE.profile); return STATE; }

/* ---------------- router ---------------- */
window.addEventListener("hashchange", route);
async function route() {
  clearInterval(pollTimer);
  if (Q && !Q.finished && !location.hash.startsWith("#/quiz")) toast("⏸ Paused. Hit ▶ Resume to continue where you left off.", "", 3500);
  if (!location.hash.startsWith("#/quiz")) Q = null;
  const h = location.hash.slice(2).split("/");
  document.querySelectorAll("nav a").forEach(a => a.classList.toggle("on", a.dataset.nav === (h[0] || "home")));
  try {
    if (!h[0]) return await home();
    if (h[0] === "deck") return await deckPage(h[1]);
    if (h[0] === "notes") return await notesPage(h[1]);
    if (h[0] === "badges") return await badgesPage();
    if (h[0] === "settings") return await settingsPage();
    if (h[0] === "quiz") { if (!Q) location.hash = "#/"; return; }
    location.hash = "#/";
  } catch (e) { fail(e); }
}

/* ---------------- home ---------------- */
async function home() {
  const s = await refreshState();
  const p = s.profile;
  const hour = new Date().getHours();
  const greet = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  view.innerHTML = `
  <div class="hero">
    <div><div class="muted">${greet}, chef.</div><h1>Let's get you <em>cooked</em><br>for that exam.</h1></div>
    <div class="row"><span class="tag fire">${p.xp.toLocaleString()} XP</span><span class="tag">${p.accuracy}% accuracy</span></div>
  </div>
  ${!s.settings.has_key && s.settings.provider !== "claude" ? `<div class="banner"><span class="big">🔑</span><div style="flex:1"><b>Connect your AI first.</b><div class="muted small">Use your Claude Pro plan or a free Gemini key to scan modules.</div></div><a class="btn fire" href="#/settings">Open Settings</a></div>` : ""}
  ${(s.active || []).map(a => `<div class="banner"><span class="big">▶</span><div style="flex:1"><b>Continue: ${esc(a.title)}</b><div class="muted small">${a.mode === "exam" ? "Mastery Exam" : a.mode === "review" ? "Spaced review" : "Active recall"} · ${a.left} question${a.left === 1 ? "" : "s"} left</div></div><button class="btn fire" data-resume="${esc(a.mode === "boost" ? a.deck_id : (a.module_id || ""))}" data-mode="${a.mode}">Resume</button></div>`).join("")}
  ${s.due_total ? `<div class="banner"><span class="big">🧠</span><div style="flex:1"><b>${s.due_total} spaced review${s.due_total > 1 ? "s" : ""} due.</b><div class="muted small">Retention check: clear them so mastered modules stay in your long-term memory.</div></div><button class="btn fire" id="revAll">Review now</button></div>` : ""}
  <h2 style="margin-bottom:14px">Your subjects</h2>
  <div class="grid">
    ${s.decks.map(d => {
      const mods = d.modules, done = mods.filter(m => m.mastered).length;
      const pct = mods.length ? Math.round(mods.reduce((a, m) => a + m.mastery, 0) / mods.length) : 0;
      return `<div class="card deck" data-id="${d.id}">
        <div class="ring">${ring(pct)}</div>
        <h3>${esc(d.name)}</h3>
        <div class="muted small">${mods.length} module${mods.length !== 1 ? "s" : ""} · ${done} mastered</div>
        ${d.due ? `<div style="margin-top:10px"><span class="tag fire">🧠 ${d.due} due</span></div>` : ""}
        ${d.forecast && d.forecast.exam_date ? `<div style="margin-top:8px"><span class="tag ${d.forecast.recall >= 85 ? "ok" : d.forecast.recall >= 65 ? "fire" : "critical"}">📅 ${d.forecast.days_left > 0 ? Math.ceil(d.forecast.days_left) + "d left" : "exam day"} · ${d.forecast.recall}% recall</span></div>` : ""}
      </div>`;}).join("")}
    <div class="card new-deck" id="newDeck"><b>+</b><div>New subject</div></div>
  </div>`;
  view.querySelectorAll(".deck").forEach(el => el.onclick = () => location.hash = "#/deck/" + el.dataset.id);
  $("#newDeck").onclick = async () => {
    const name = await promptModal("New subject", "e.g. Discrete Mathematics");
    if (!name) return;
    const r = await api("decks", {name}); location.hash = "#/deck/" + r.id;
  };
  const rv = $("#revAll"); if (rv) rv.onclick = () => startQuiz(null, "review");
  view.querySelectorAll("[data-resume]").forEach(b => b.onclick = () => startQuiz(b.dataset.resume || null, b.dataset.mode));
}
function ring(pct, size = 52) {
  const r = size / 2 - 5, c = 2 * Math.PI * r;
  return `<svg width="${size}" height="${size}"><circle cx="${size/2}" cy="${size/2}" r="${r}" stroke="#ffffff14" stroke-width="5" fill="none"/>
  <circle cx="${size/2}" cy="${size/2}" r="${r}" stroke="${pct >= 100 ? "#35d07f" : "#ff7a1a"}" stroke-width="5" fill="none" stroke-linecap="round"
  stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - pct / 100)}" transform="rotate(-90 ${size/2} ${size/2})"/>
  <text x="50%" y="54%" text-anchor="middle" dominant-baseline="middle" fill="#f6ede6" font-size="12" font-weight="700">${pct}%</text></svg>`;
}
function promptModal(title, ph, val = "") {
  return new Promise(res => {
    const m = $("#modal"); m.classList.remove("hidden");
    m.innerHTML = `<div class="card" style="text-align:left"><h2 style="margin-bottom:14px">${esc(title)}</h2>
      <input id="pm" placeholder="${esc(ph)}" value="${esc(val)}"><div class="row" style="justify-content:flex-end;margin-top:16px">
      <button class="btn ghost" id="pc">Cancel</button><button class="btn fire" id="po">OK</button></div></div>`;
    const done = v => { m.classList.add("hidden"); m.innerHTML = ""; res(v); };
    $("#pm").focus(); $("#pm").onkeydown = e => { if (e.key === "Enter") done($("#pm").value.trim()); if (e.key === "Escape") done(null); };
    $("#po").onclick = () => done($("#pm").value.trim()); $("#pc").onclick = () => done(null);
  });
}
function confirmModal(title, text, ok = "Yes") {
  return new Promise(res => {
    const m = $("#modal"); m.classList.remove("hidden");
    m.innerHTML = `<div class="card"><h2>${esc(title)}</h2><p class="muted">${text}</p><div class="row" style="justify-content:center;margin-top:16px">
      <button class="btn ghost" id="pc">Cancel</button><button class="btn fire" id="po">${esc(ok)}</button></div></div>`;
    const done = v => { m.classList.add("hidden"); res(v); };
    $("#po").onclick = () => done(true); $("#pc").onclick = () => done(false);
  });
}

/* ---------------- deck ---------------- */
const NOTIFIED = new Set();
async function deckPage(did) {
  clearInterval(pollTimer);
  await refreshState();
  const d = await api("decks/" + did);
  const activeIdx = d.modules.findIndex(m => !m.mastered);
  view.innerHTML = `
  <div class="row between"><div><a class="muted small" href="#/">← Kitchen</a><h1 style="font-size:36px;margin-top:4px">${esc(d.name)}</h1>
    <div class="muted">Modules unlock one by one. Score 95%+ on the Mastery Exam to move on.</div></div>
    <div class="row">${d.due ? `<button class="btn fire" id="rev">🧠 ${d.due} reviews due</button>` : ""}
    <button class="btn sm" id="imp" title="Load a question bank Claude made for you in chat">⬇️ Import from Claude</button>
    <a class="btn sm" id="exp" href="/api/decks/${did}/export" download title="Send this subject to your phone or classmates (no scanning needed)">📤 Export</a>
    <button class="btn sm" id="ren">Rename</button><button class="btn sm danger" id="del">Delete</button></div></div>
  ${examPanel(d)}
  <div class="path">${d.modules.map((m, i) => modCard(m, i, i === activeIdx, d.modules.length)).join("") ||
    `<div class="empty"><img src="/logo.svg"><div>No modules yet. Drop Module 1, 2, 3... below.</div></div>`}</div>
  <label class="drop" id="drop"><input type="file" id="file" multiple hidden accept=".pdf,.pptx,.ppsx,.docx,.png,.jpg,.jpeg,.webp,.txt,.md,.json">
    <div style="font-size:30px">📥</div><b>Drop your modules here</b> or click to browse<div class="small">PDF · PPTX · DOCX · images · TXT  —  uploaded in name order (Module 1, 2, 3…)</div></label>`;
  $("#imp").onclick = () => importModal(did);
  if ($("#setExam")) $("#setExam").onclick = async () => {
    const v = await dateModal(d.forecast.exam_date || "");
    if (v === null) return;
    try { await api(`decks/${did}/exam`, {date: v}); toast(v ? "📅 Exam date set. Reviews now land before it." : "Exam date cleared"); deckPage(did); } catch (e) { fail(e); }
  };
  if ($("#boost")) $("#boost").onclick = () => startQuiz(did, "boost");
  $("#ren").onclick = async () => { const n = await promptModal("Rename subject", "", d.name); if (n) { await api(`decks/${did}/rename`, {name: n}); deckPage(did); } };
  $("#del").onclick = async () => { if (await confirmModal("Delete subject?", "All modules and progress in it will be gone.", "Delete")) { await api("decks/" + did, undefined, "DELETE"); location.hash = "#/"; } };
  if ($("#rev")) $("#rev").onclick = () => startQuiz(d.modules.find(m => m.mastered)?.id || null, "review");
  const drop = $("#drop"), input = $("#file");
  drop.ondragover = e => { e.preventDefault(); drop.classList.add("over"); };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove("over"); upload(did, e.dataTransfer.files); };
  input.onchange = () => upload(did, input.files);
  view.querySelectorAll("[data-act]").forEach(b => b.onclick = e => { e.preventDefault(); modAction(did, d, b.dataset.act, b.dataset.id); });
  tickScans();
  if (d.modules.some(m => m.status === "queued" || m.status === "scanning"))
    pollTimer = setInterval(async () => {
      if (location.hash !== "#/deck/" + did) return clearInterval(pollTimer);
      try { const nd = await api("decks/" + did);
        if (JSON.stringify(nd.modules.map(m => [m.status, m.progress])) !== JSON.stringify(d.modules.map(m => [m.status, m.progress]))) {
          nd.modules.forEach(m => { const old = d.modules.find(x => x.id === m.id);
            if (old && old.status === "scanning" && m.status === "ready" && !NOTIFIED.has(m.id)) { NOTIFIED.add(m.id); toast(`✅ <b>${esc(m.title)}</b> is ready: ${m.count} questions`, "gold", 6000); } });
          clearInterval(pollTimer);
          if (location.hash === "#/deck/" + did) deckPage(did);
        }
      } catch {}
    }, 2500);
}
function fmtT(s) { s = Math.max(0, Math.round(s)); return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`; }
function tickScans() {
  document.querySelectorAll(".scanbox").forEach(el => {
    const el0 = +el.dataset.elapsed, eta = Math.max(20, +el.dataset.eta), floor = +el.dataset.floor;
    const t = el0 + (Date.now() - +el.dataset.t) / 1000;
    let pct = t < eta ? 92 * t / eta : 92 + 7 * (1 - Math.exp(-(t - eta) / eta));   // never claims 100% until done
    pct = Math.max(pct, floor); pct = Math.min(pct, 99);
    const fg = el.querySelector(".fg"), c = 2 * Math.PI * 27;
    fg.style.strokeDasharray = c; fg.style.strokeDashoffset = c * (1 - pct / 100);
    el.querySelector(".sring b").textContent = Math.floor(pct) + "%";
    el.querySelector(".stime").textContent = `${fmtT(t)} elapsed · ` + (t < eta ? `about ${fmtT(eta - t)} left` : "almost done, finishing up…");
  });
}
setInterval(tickScans, 1000);
function examPanel(d) {
  const f = d.forecast || {};
  if (!f.exam_date) return `<div class="banner" style="margin-top:18px"><span class="big">📅</span><div style="flex:1"><b>When's the exam?</b>
    <div class="muted small">Set the date and Cooked times your reviews so everything peaks on exam day, and predicts how much you'll remember.</div></div>
    <button class="btn fire" id="setExam">Set exam date</button></div>`;
  const col = f.recall >= 85 ? "var(--ok)" : f.recall >= 65 ? "var(--gold)" : "var(--bad)";
  const dl = f.days_left > 1 ? `${Math.ceil(f.days_left)} days left` : f.days_left > 0 ? "Exam tomorrow" : "Exam day!";
  return `<div class="card" style="margin-top:18px;display:grid;grid-template-columns:auto 1fr auto;gap:22px;align-items:center">
    <div style="text-align:center"><div style="font:800 46px 'Bricolage Grotesque',Inter,sans-serif;color:${col}">${f.recall}%</div><div class="small muted">predicted recall<br>on exam day</div></div>
    <div><b>📅 ${esc(f.exam_date)} · ${dl}</b>
      <div class="bar" style="margin:10px 0 6px;height:10px"><i style="width:${f.recall}%;background:${col}"></i></div>
      <div class="small muted">${f.weak ? `${f.weak} of ${f.total} questions are likely to slip by then.` : "You're locked in. Keep your reviews up."} Based on a forgetting-curve model of every answer you've given.</div></div>
    <div style="display:grid;gap:8px"><button class="btn fire" id="boost" title="Your 15 weakest questions. Each comes back until you get it right">⚡ Boost (15 weakest)</button>
      <button class="btn sm ghost" id="setExam">Change date</button></div></div>`;
}
function dateModal(val) {
  return new Promise(res => {
    const m = $("#modal"); m.classList.remove("hidden");
    m.innerHTML = `<div class="card" style="text-align:left"><h2 style="margin-bottom:12px">📅 Exam date</h2>
      <input type="date" id="dm" value="${esc(val)}" style="color-scheme:dark"><div class="row" style="justify-content:space-between;margin-top:16px">
      <button class="btn sm ghost" id="dc0">Clear date</button><div class="row"><button class="btn ghost" id="dc">Cancel</button><button class="btn fire" id="do">Save</button></div></div></div>`;
    const done = v => { m.classList.add("hidden"); res(v); };
    $("#do").onclick = () => done($("#dm").value); $("#dc").onclick = () => done(null); $("#dc0").onclick = () => done("");
  });
}
function modCard(m, i, active, n) {
  const locked = !m.unlocked;
  let status = "", actions = "";
  if (m.status === "scanning")
    status = `<div class="scanbox" data-elapsed="${m.elapsed || 0}" data-eta="${m.eta || 120}" data-floor="${m.stage_pct || 0}" data-t="${Date.now()}">
      <div class="sring"><svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="27" class="bg"/><circle cx="32" cy="32" r="27" class="fg"/></svg><b>0%</b></div>
      <div><div class="stext">${esc(m.progress || "Scanning...")}</div><div class="small muted stime"></div>
      ${m.pages ? `<div class="small dim">${m.pages} page${m.pages > 1 ? "s" : ""}</div>` : ""}</div></div>`;
  else if (m.status === "queued") status = `<span class="tag"><span class="spin"></span> In line, starts after the current scan</span>`;
  else if (m.status === "error")
    status = `<span class="tag critical">Error</span> <span class="small muted">${esc(m.error)}</span>`;
  else if (m.mastered) status = `<span class="tag ok">✓ Mastered</span><span class="tag">🧠 in spaced review</span>`;
  else if (locked) status = `<span class="tag lock">🔒 Locked — master Module ${i} first</span>`;
  else if (m.exam_ready) status = `<span class="tag fire">🎯 Mastery Exam unlocked</span>`;
  else status = `<span class="tag fire">Learning · ${m.learned}/${m.count} learned</span>`;
  const DL = {critical: "Most important only", important: "Important topics", all: "Everything", custom: "Custom topics"};
  if (m.status === "ready") status += ` <span class="tag fire" title="Only these count for mastery & the exam">${m.detail === "full" ? "📖" : "🔑"} ${DL[m.depth] || "Scope"}${m.detail === "full" ? "" : " · key points"} · ${m.count}${m.count < m.total ? " of " + m.total : ""} questions</span>`;
  const fails = (m.exams || []).filter(x => !x.passed).length;
  if (fails && !m.mastered) status += ` <span class="tag critical">${fails} failed exam${fails > 1 ? "s" : ""}</span>`;
  if (m.status === "ready" && !locked) {
    actions += `<button class="btn sm" data-act="notes" data-id="${m.id}">📖 Reviewer</button>`;
    if (!m.mastered) actions += `<button class="btn sm" data-act="scope" data-id="${m.id}" title="Pick what your prof will cover">🎯 Scope</button>`;
    if (m.session) actions += `<button class="btn sm fire" data-act="${m.session.mode}" data-id="${m.id}">▶ Resume ${m.session.mode === "exam" ? "exam" : m.session.mode.startsWith("practice") ? "practice" : ""} · ${m.session.left} left</button>`;
    else if (m.mastered) actions += `<button class="btn sm fire" data-act="practice" data-id="${m.id}" title="Answer the key questions again. Doesn't change your mastery">🔁 Practice again</button>
      <button class="btn sm" data-act="practice_all" data-id="${m.id}" title="Every question in the module, including the ones outside your scope">📚 All ${m.total}</button>`;
    else if (!m.mastered) actions += m.exam_ready
      ? `<button class="btn sm fire" data-act="exam" data-id="${m.id}">🎯 Mastery Exam</button>`
      : `<button class="btn sm fire" data-act="learn" data-id="${m.id}">🔥 ${m.learned ? "Continue" : "Start"}</button>`;
  }
  if (m.status === "error" && !m.imported) actions += `<button class="btn sm fire" data-act="rescan" data-id="${m.id}">↻ Retry</button>`;
  if (!m.mastered) {
    if (m.status === "ready" && !m.imported) actions += `<button class="btn sm ghost" title="Re-scan with AI (resets this module's progress)" data-act="rescan" data-id="${m.id}">↻</button>`;
    actions += `<button class="btn sm ghost" title="Move up" data-act="up" data-id="${m.id}" ${i === 0 ? "disabled" : ""}>↑</button>
                <button class="btn sm ghost" title="Move down" data-act="down" data-id="${m.id}" ${i === n - 1 ? "disabled" : ""}>↓</button>
                <button class="btn sm ghost danger" title="Remove" data-act="rm" data-id="${m.id}">✕</button>`;
  }
  return `<div class="card mod ${locked ? "locked" : ""} ${m.mastered ? "mastered" : ""} ${active && !locked ? "active" : ""}">
    <div class="num">${m.mastered ? "✓" : locked ? "🔒" : i + 1}</div>
    <div><h3>${esc(m.title)}</h3><div class="small dim">${esc(m.filename)}</div><div class="meta">${status}</div>
      ${m.status === "ready" ? `<div class="pbar"><div class="bar ${m.mastered ? "ok" : ""}"><i style="width:${m.mastery}%"></i></div><div class="small dim" style="margin-top:4px">Mastery ${m.mastery}%</div></div>` : ""}
    </div><div class="actions">${actions}</div></div>`;
}
async function modAction(did, d, act, id) {
  try {
    if (act === "notes") location.hash = "#/notes/" + id;
    else if (act === "scope") scopeModal(did, id);
    else if (act === "practice" || act === "practice_all") startQuiz(id, act);
    else if (act === "learn" || act === "exam") {
      const resuming = d && d.modules && d.modules.find(x => x.id === id)?.session;
      if (act === "exam" && !resuming && !await confirmModal("Start the Mastery Exam?", "Every question, shuffled. You need <b>95% or higher</b> to unlock the next module. Leaving midway counts as a fail, and notes are locked.", "Let's cook")) return;
      startQuiz(id, act);
    }
    else if (act === "rescan") {
      if (!await confirmModal("Rescan module?", "Gemini will re-read it and write a fresh question bank. Progress on this module resets.", "Rescan")) return;
      await api(`modules/${id}/rescan`, {}); deckPage(did);
    }
    else if (act === "rm") { if (await confirmModal("Remove module?", "Its questions and progress will be deleted.", "Remove")) { await api("modules/" + id, undefined, "DELETE"); deckPage(did); } }
    else if (act === "up" || act === "down") {
      const order = d.modules.map(m => m.id), i = order.indexOf(id), j = act === "up" ? i - 1 : i + 1;
      [order[i], order[j]] = [order[j], order[i]];
      await api(`decks/${did}/order`, {order}); deckPage(did);
    }
  } catch (e) { fail(e); }
}
async function scopeModal(did, mid) {
  let sc = await api(`modules/${mid}/scope`);
  const m = $("#modal"); m.classList.remove("hidden");
  const draw = () => {
    m.innerHTML = `<div class="card" style="text-align:left;max-width:640px;max-height:86vh;overflow:auto">
      <h2>🎯 Exam scope</h2><p class="muted small">Only what you pick counts for mastery, the Mastery Exam (95% to pass) and unlocking the next module.</p>
      <div class="row" style="margin:10px 0 14px">
        ${[["critical", "🔥 Most important"], ["important", "⭐ Important"], ["all", "📚 Everything"]].map(([d, l]) =>
          `<button class="btn sm ${sc.depth === d ? "fire" : ""}" data-depth="${d}">${l}</button>`).join("")}
      </div>
      <div class="small muted" style="margin-bottom:6px">How much detail per topic?</div>
      <div class="row" style="margin-bottom:14px">
        <button class="btn sm ${sc.detail !== "full" ? "fire" : ""}" data-detail="key">🔑 Key points: just the main term &amp; idea (1–2 per topic)</button>
        <button class="btn sm ${sc.detail === "full" ? "fire" : ""}" data-detail="full">📖 Full detail: every question</button>
      </div>
      <div class="small muted" style="margin-bottom:8px">Or tick exactly what your prof covered:</div>
      <div style="display:grid;gap:6px">${sc.concepts.map(c => `<label class="sw" style="padding:8px 10px;border-radius:10px;background:var(--bg2)">
        <input type="checkbox" data-c="${esc(c.id)}" ${c.on ? "checked" : ""}> <span style="flex:1">${esc(c.title)}</span>
        <span class="tag ${c.importance}">${c.importance}</span><span class="small dim">${c.count}q</span></label>`).join("")}</div>
      <div class="row between" style="margin-top:16px"><b>${sc.active} of ${sc.total} questions count</b>
        <div class="row"><button class="btn ghost" id="sx">Close</button><button class="btn fire" id="ss">Save topics</button></div></div></div>`;
    m.querySelectorAll("[data-detail]").forEach(b => b.onclick = async () => { try { sc = await api(`modules/${mid}/scope`, {detail: b.dataset.detail}); draw(); } catch (e) { fail(e); } });
    m.querySelectorAll("[data-depth]").forEach(b => b.onclick = async () => { try { sc = await api(`modules/${mid}/scope`, {depth: b.dataset.depth}); draw(); } catch (e) { fail(e); } });
    $("#sx").onclick = () => { m.classList.add("hidden"); deckPage(did); };
    $("#ss").onclick = async () => {
      const topics = [...m.querySelectorAll("[data-c]")].filter(x => x.checked).map(x => x.dataset.c);
      try { sc = await api(`modules/${mid}/scope`, {topics}); toast(`🎯 Scope saved: ${sc.active} questions`, "gold"); m.classList.add("hidden"); deckPage(did); } catch (e) { fail(e); }
    };
  };
  draw();
}
function readB64(f) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result.split(",")[1]); r.onerror = rej; r.readAsDataURL(f); }); }
function importModal(did) {
  const m = $("#modal"); m.classList.remove("hidden");
  m.innerHTML = `<div class="card" style="text-align:left"><h2>⬇️ Import from Claude</h2>
    <p class="muted small">Upload your module to Claude chat and ask for a <b>Cooked question bank</b>. Then load the <b>.cooked.json</b> file here.</p>
    <b>Question bank (.json)</b><input type="file" id="ij" accept=".json" style="margin:6px 0 14px">
    <b>Original PDF</b> <span class="small dim">(optional, so diagram questions can show the page)</span><input type="file" id="ip" accept=".pdf" style="margin-top:6px">
    <div class="row" style="justify-content:flex-end;margin-top:18px"><button class="btn ghost" id="ic">Cancel</button><button class="btn fire" id="io">Import</button></div></div>`;
  $("#ic").onclick = () => m.classList.add("hidden");
  $("#io").onclick = async () => {
    const jf = $("#ij").files[0], pf = $("#ip").files[0];
    if (!jf) return toast("Pick the .json file first", "err");
    $("#io").innerHTML = `<span class="spin"></span>`;
    try {
      const body = {json: await jf.text()};
      if (pf) { body.source_name = pf.name; body.source_data = await readB64(pf); }
      const r = await api(`decks/${did}/import`, body);
      m.classList.add("hidden"); toast(`✅ Imported ${r.count} questions`, "gold"); deckPage(did);
    } catch (e) { $("#io").textContent = "Import"; fail(e); }
  };
}
async function upload(did, files) {
  const list = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, {numeric: true}));
  for (const f of list) {
    if (f.name.toLowerCase().endsWith(".json")) {
      try { const r = await api(`decks/${did}/import`, {json: await f.text()}); toast(`✅ Imported ${r.count} questions from ${esc(f.name)}`, "gold"); }
      catch (e) { fail(e); }
      continue;
    }
    try {
      toast(`Uploading <b>${esc(f.name)}</b>...`, "", 2000);
      const data = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result.split(",")[1]); r.onerror = rej; r.readAsDataURL(f); });
      await api(`decks/${did}/upload`, {filename: f.name, data});
    } catch (e) { fail(e); }
  }
  toast("Scanning starts with the first module. Gemini reads every page & diagram.", "gold");
  deckPage(did);
}

/* ---------------- visuals ---------------- */
let pdfLib = null; const pdfDocs = {};
async function loadPdfJs() {
  if (pdfLib) return pdfLib;
  await new Promise((res, rej) => { const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  return pdfLib = window.pdfjsLib;
}
async function renderVisual(el, mid, ref, box) {
  if (ref.startsWith("img:")) {
    el.innerHTML = `<img src="/api/modules/${mid}/asset/${encodeURIComponent(ref.slice(4))}" alt="diagram">`;
  } else if (ref.startsWith("page:")) {
    const page = parseInt(ref.slice(5));
    el.classList.add("loading"); el.textContent = `Loading page ${page}...`;
    try {
      const lib = await loadPdfJs();
      pdfDocs[mid] = pdfDocs[mid] || lib.getDocument(`/api/modules/${mid}/asset/source`).promise;
      const doc = await pdfDocs[mid];
      const pg = await doc.getPage(Math.min(page, doc.numPages));
      const vp = pg.getViewport({scale: box ? 2.4 : 1.6});
      let c = document.createElement("canvas"); c.width = vp.width; c.height = vp.height;
      await pg.render({canvasContext: c.getContext("2d"), viewport: vp}).promise;
      if (box && box.length === 4) {   // crop to just the diagram (+ small margin)
        const m = 0.02, x0 = Math.max(0, box[0] - m) * c.width, y0 = Math.max(0, box[1] - m) * c.height;
        const w = Math.min(1, box[2] + m) * c.width - x0, h = Math.min(1, box[3] + m) * c.height - y0;
        const cc = document.createElement("canvas"); cc.width = w; cc.height = h;
        cc.getContext("2d").drawImage(c, x0, y0, w, h, 0, 0, w, h); c = cc;
      }
      el.classList.remove("loading"); el.innerHTML = ""; el.appendChild(c);
    } catch (e) { el.textContent = `📄 See page ${page} of your module (couldn't render the page: no internet for the PDF viewer?)`; }
  }
  el.onclick = () => {
    const node = el.firstElementChild; if (!node || el.classList.contains("loading")) return;
    const lb = $("#lightbox"); lb.innerHTML = ""; lb.classList.remove("hidden");
    if (node.tagName === "IMG") lb.appendChild(node.cloneNode());
    else { const c = document.createElement("canvas"); c.width = node.width; c.height = node.height; c.getContext("2d").drawImage(node, 0, 0); lb.appendChild(c); }
  };
}
$("#lightbox").onclick = () => $("#lightbox").classList.add("hidden");

/* ---------------- notes ---------------- */
async function notesPage(mid) {
  await refreshState();
  const n = await api(`modules/${mid}/notes`);
  const inS = new Set(n.in_scope || []);
  const c = [...(n.notes?.concepts || [])].sort((a, b) => (inS.has(b.id) - inS.has(a.id)));
  view.innerHTML = `<a class="muted small" href="javascript:history.back()">← Back</a>
  <div class="row between" style="margin:6px 0 18px"><h1 style="font-size:34px">📖 ${esc(n.title)}</h1>
   ${!n.summary.mastered && n.summary.unlocked ? `<button class="btn fire" id="go">${n.summary.exam_ready ? "🎯 Mastery Exam" : "🔥 Start active recall"}</button>` : ""}</div>
  <div class="card" style="margin-bottom:18px"><b>Summary</b><p class="muted" style="margin:6px 0 0;white-space:pre-wrap">${esc(n.notes?.summary)}</p></div>
  <div class="row" style="margin-bottom:14px"><span class="tag critical">critical = very likely in exam</span><span class="tag high">high</span><span class="tag medium">medium</span></div>
  ${c.map((k, i) => `<div class="card concept" style="${inS.size && !inS.has(k.id) ? "opacity:.45" : ""}"><div class="row between"><span class="tag ${k.importance}">${esc(k.importance)}</span><span class="dim small">${inS.size && !inS.has(k.id) ? "not in your exam scope" : "🎯 in scope"}</span></div>
     <h3>${esc(k.title)}</h3><p>${esc(k.explanation)}</p>
     ${k.visual_ref ? `<div class="visual" data-ref="${esc(k.visual_ref)}" data-box="${esc(JSON.stringify(k.visual_box || null))}"></div>${k.visual_description ? `<div class="small muted">🖼️ ${esc(k.visual_description)}</div>` : ""}` : ""}
     ${(k.must_memorize || []).length ? `<div class="mem">${k.must_memorize.map(x => `<span>${esc(x)}</span>`).join("")}</div>` : ""}</div>`).join("")}`;
  view.querySelectorAll(".visual[data-ref]").forEach(el => { let b = null; try { b = JSON.parse(el.dataset.box); } catch {} renderVisual(el, mid, el.dataset.ref, b); });
  if ($("#go")) $("#go").onclick = () => startQuiz(mid, n.summary.exam_ready ? "exam" : "learn");
}

/* ---------------- quiz ---------------- */
async function startQuiz(mid, mode) {
  try {
    const r = mode === "boost" ? await api(`decks/${mid}/boost`, {}) : mode === "review" ? await api("review", {module_id: mid}) : await api(`modules/${mid}/start`, {mode});
    Q = {session: r.session, mode, module_id: mid, finished: false, backTo: location.hash};
    if (r.resumed) toast("▶ Picked up where you left off", "", 2500);
    if (location.hash !== "#/quiz") history.pushState(null, "", "#/quiz");
    clearInterval(pollTimer);
    document.querySelectorAll("nav a").forEach(a => a.classList.remove("on"));
    showQuestion(r);
  } catch (e) { fail(e); }
}
const MODE_LABEL = {boost: "⚡ Exam Boost: your 15 weakest", practice: "🔁 Practice (doesn't affect mastery)", practice_all: "📚 Practice: all questions", learn: "🔥 Active Recall", exam: "🎯 Mastery Exam — 95% to pass", review: "🧠 Spaced Review"};
function showQuestion(r) {
  if (r.done) return showResults(r);
  renderChips(r.profile);
  const q = r.question, st = r.stats;
  Q.cur = q; Q.answered = false; Q.sel = null;
  const prog = Q.mode === "learn" ? st.mastery : Math.round(100 * (st.total - st.remaining) / st.total);
  let input = "";
  if (q.type === "mcq") input = `<div class="choices">${q.choices.map((c, i) => `<button class="choice" data-i="${i}"><kbd>${i + 1}</kbd><span>${esc(c)}</span></button>`).join("")}</div>`;
  else if (q.type === "true_false") input = `<div class="choices tf">${q.choices.map((c, i) => `<button class="choice" data-i="${i}">${c === "True" ? "✅" : "❌"} ${c}</button>`).join("")}</div>`;
  else if (q.type === "identification" || q.type === "fill_blank") input = `<input id="ans" autocomplete="off" spellcheck="false" placeholder="Type your answer from memory...">`;
  else if (q.type === "enumeration") input = `<div class="enum">${Array.from({length: q.n_items}, (_, i) => `<div class="it" data-i="${i}"><span>${i + 1}.</span><input autocomplete="off" spellcheck="false" placeholder="Item ${i + 1}"></div>`).join("")}</div>
     <div class="kbd-hint" style="margin-top:8px">${q.ordered ? "⚠️ Order matters." : "Any order."} Enter moves to the next box.</div>`;
  else input = `<textarea id="ans" placeholder="Explain in your own words. Be complete: graded against the key points from your module."></textarea>`;
  view.innerHTML = `<div class="quiz">
    <div class="qhead"><button class="btn sm ghost" id="quit">✕</button><div class="bar"><i style="width:${prog}%"></i></div>
      <div class="combo ${r.profile.combo >= 5 ? "hot" : ""}">${r.profile.combo >= 2 ? "🔥 x" + r.profile.combo : ""}</div></div>
    <div class="row between small muted" style="margin:-6px 0 12px"><span>${MODE_LABEL[Q.mode]} · ${esc(r.module_title)}</span>
      <span>${Q.mode === "learn" ? `Mastery ${st.mastery}% · ${st.remaining} left to learn` : `${st.total - st.remaining + 1} / ${st.total}`}</span></div>
    <div class="card qcard" id="qcard">
      <div class="qtype"><span class="tag fire">${q.type_label}</span>
        ${Q.mode === "learn" ? `<div class="dots" title="Get it right ${q.need}× in a row (spaced) to learn it">${Array.from({length: q.need}, (_, i) => `<i class="${i < q.streak ? "on" : ""}"></i>`).join("")}</div>` : ""}</div>
      <div class="prompt">${esc(q.prompt)}</div>
      ${q.visual ? `<div class="visual" id="vis"></div>` : ""}
      ${input}
      <div class="qactions" id="qa"><button class="btn ghost" id="idk">I don't know</button>
        <div class="row"><span class="kbd-hint">Enter ↵ to submit</span><button class="btn fire" id="submit">Submit</button></div></div>
      <div id="fb"></div>
    </div></div>`;
  if (q.visual) renderVisual($("#vis"), q.visual.module_id, q.visual.ref, q.visual.box);
  view.querySelectorAll(".choice").forEach(b => b.onclick = () => {
    if (Q.answered) return;
    view.querySelectorAll(".choice").forEach(x => x.classList.remove("sel")); b.classList.add("sel"); Q.sel = +b.dataset.i;
    if (q.type === "true_false" || q.type === "mcq") submit();
  });
  const enumInputs = [...view.querySelectorAll(".enum input")];
  enumInputs.forEach((inp, i) => inp.onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); if (i < enumInputs.length - 1) enumInputs[i + 1].focus(); else submit(); } });
  (enumInputs[0] || $("#ans"))?.focus();
  $("#submit").onclick = () => submit();
  $("#idk").onclick = () => submit(true);
  $("#quit").title = Q.mode === "exam" ? "Quit exam (counts as a fail)" : "Pause (resume anytime)";
  $("#quit").onclick = async () => {
    const back = Q.backTo;
    if (Q.mode === "exam") {
      if (!await confirmModal("Quit the exam?", "Quitting counts as a <b>failed attempt</b>. (Switching tabs doesn't. Your exam waits for you.)", "Quit")) return;
      await api(`session/${Q.session}/quit`, {}).catch(() => {}); Q.finished = true;
    }
    location.hash = back && back !== "#/quiz" ? back : "#/";
  };
}
function collect() {
  const q = Q.cur;
  if (q.type === "mcq" || q.type === "true_false") return Q.sel;
  if (q.type === "enumeration") return [...view.querySelectorAll(".enum input")].map(i => i.value.trim());
  return $("#ans").value.trim();
}
async function submit(idk = false) {
  if (Q.answered || Q.busy) return;
  const q = Q.cur;
  let ans = idk ? {idk: true} : collect();
  if (!idk && (ans === null || ans === "" || (Array.isArray(ans) && ans.every(x => !x)))) { $("#qcard").classList.add("shake"); setTimeout(() => $("#qcard")?.classList.remove("shake"), 400); return; }
  Q.busy = true; $("#submit").disabled = true; $("#submit").innerHTML = q.type === "essay" ? `<span class="spin"></span> Grading...` : `<span class="spin"></span>`;
  let r;
  try { r = await api(`session/${Q.session}/answer`, {qid: q.id, answer: ans}); }
  catch (e) { Q.busy = false; $("#submit").disabled = false; $("#submit").textContent = "Submit"; return fail(e); }
  Q.busy = false; Q.answered = true;
  const res = r.result, ok = res.correct;
  renderChips(r.profile);
  const cb = $(".combo"); if (cb) { cb.textContent = r.profile.combo >= 2 ? "🔥 x" + r.profile.combo : ""; cb.classList.toggle("hot", r.profile.combo >= 5); }
  view.querySelectorAll(".dots i").forEach((d, i) => d.classList.toggle("on", i < res.streak));
  view.querySelectorAll("input,textarea").forEach(i => i.disabled = true);
  if (q.type === "mcq" || q.type === "true_false") {
    view.querySelectorAll(".choice").forEach((b, i) => { b.disabled = true;
      if (i === res.correct_shown) b.classList.add("right"); else if (i === Q.sel) b.classList.add("wrong"); });
  }
  if (q.type === "enumeration" && res.marks) view.querySelectorAll(".enum .it").forEach((it, i) => it.classList.add(res.marks[i] ? "right" : "wrong"));
  let ansHtml = "";
  const rv = res.reveal;
  if ((q.type === "identification" || q.type === "fill_blank") && !ok)
    ansHtml = `<div class="ans">Answer: ${esc(rv.text)}${rv.accepted?.length ? ` <span class="dim small">(also: ${rv.accepted.map(esc).join(", ")})</span>` : ""}</div>`;
  if (rv.items && !ok) ansHtml = `<div class="ans">Required items${rv.ordered ? " (in order)" : ""}:</div><ul>${rv.items.map(x => `<li>${esc(x)}</li>`).join("")}</ul>`;
  if (rv.rubric) ansHtml = `<div class="ans">Score: ${res.score}/100 (need 80+ with the key points)</div>
      ${res.missing?.length ? `<div class="small">Missing:</div><ul>${res.missing.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
      ${!ok ? `<div class="small" style="margin-top:6px">Full-mark key points:</div><ul>${rv.rubric.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}`;
  const headline = ok ? ["Cooked it! 🔥", "Chef's kiss! 👨‍🍳", "Well done! 🥩", "Sizzling! ✨", "Nailed it! 💯"][Math.floor(Math.random() * 5)]
                      : ["Undercooked. 🥶", "Not yet. Back on the stove.", "Raw! Learn this one. 🧊"][Math.floor(Math.random() * 3)];
  const learnNote = Q.mode === "learn" ? (ok ? (res.learned ? "🎉 Learned! Locked into memory (3/3)." : `Streak ${res.streak}/${res.need} — it'll come back later to make sure it sticks.`)
                     : (res.streak > 0 ? `Dropped to ${res.streak}/${res.need}. It comes back in a few questions.` : "Back to 0. It comes back in a few questions.")) : Q.mode === "review" ? (ok ? "Next review pushed further out." : "Back to the start of the review cycle. Try again soon.") : "";
  $("#fb").innerHTML = `<div class="feedback ${ok ? "right" : "wrong"}"><h3>${headline}${r.reward.xp ? ` <span style="color:var(--gold)">+${r.reward.xp} XP</span>` : ""}</h3>
    ${res.detail ? `<div class="small">${esc(res.detail)}</div>` : ""}${ansHtml}
    ${res.explanation ? `<div class="muted" style="margin-top:8px">💡 ${esc(res.explanation)}</div>` : ""}
    ${learnNote ? `<div class="small" style="margin-top:8px;font-weight:600">${learnNote}</div>` : ""}</div>`;
  $("#qa").innerHTML = `<span></span><div class="row"><span class="kbd-hint">Enter ↵</span><button class="btn fire" id="next">Next →</button></div>`;
  $("#next").onclick = next; $("#next").focus();
  if (ok) { floatXP(r.reward.xp); } else $("#qcard").classList.add("shake");
  r.reward.badges.forEach(b => toast(`<b>${b.icon} Badge unlocked: ${esc(b.name)}</b><div class="small muted">${esc(b.desc)}</div>`, "gold", 6000));
  if (r.reward.level_up) celebrate("⬆️", `Level ${r.profile.level}!`, `You're now <b>${esc(r.profile.rank)}</b>. Keep cooking.`);
}
async function next() {
  if (Q.busy) return; Q.busy = true;
  try { const r = await api(`session/${Q.session}/next`, {}); Q.busy = false; showQuestion(r); }
  catch (e) { Q.busy = false; fail(e); }
}
function floatXP(xp) {
  if (!xp) return; const b = $("#submit") || $("#next"); const rc = (b || view).getBoundingClientRect();
  const f = document.createElement("div"); f.className = "xpfloat"; f.textContent = "+" + xp + " XP";
  f.style.left = rc.left + "px"; f.style.top = rc.top - 10 + "px"; document.body.appendChild(f); setTimeout(() => f.remove(), 1300);
}
document.addEventListener("keydown", e => {
  if (!Q || !location.hash.startsWith("#/quiz") || !$("#modal").classList.contains("hidden")) return;
  if (e.key === "Enter" && !e.shiftKey) {
    if (document.activeElement?.tagName === "TEXTAREA" && !Q.answered && !e.ctrlKey) return; // Ctrl+Enter submits essays
    e.preventDefault(); Q.answered ? next() : submit();
  } else if (!Q.answered && /^[1-4]$/.test(e.key) && document.activeElement?.tagName !== "INPUT" && document.activeElement?.tagName !== "TEXTAREA") {
    const b = view.querySelectorAll(".choice")[+e.key - 1]; if (b) b.click();
  }
});
function showResults(r) {
  Q.finished = true; renderChips(r.profile);
  const pct = r.total ? Math.round(100 * r.right / Math.max(r.right + r.wrong, 1)) : 0;
  let title, sub, em, btns = "";
  if (r.mode === "exam") {
    if (r.passed) { em = "🏆"; title = `MASTERED. ${r.score}%`; sub = `You're fully cooked on <b>${esc(r.module.title)}</b>. +${r.bonus} bonus XP.${r.wrong_count ? `<br><span class="small muted">The ${r.wrong_count} you missed will pop up in a quick review soon.</span>` : ""}${r.next_module ? `<br>🔓 <b>${esc(r.next_module.title)}</b> is now unlocked.` : "<br>Every module in this subject is mastered!"}<br><span class="small muted">It now moves into spaced reviews (1d, 3d, 7d, 16d...) so it stays in long-term memory.</span>`; confetti(); }
    else { em = "🥶"; title = `${r.score}% — need 95%.`; sub = `${r.wrong_count || r.wrong} question(s) went raw. Their streaks were reset: re-learn them, then retake the exam.`; }
  } else if (r.mode === "learn") {
    em = r.module?.exam_ready ? "🎯" : "🔥"; title = r.module?.exam_ready ? "Every question learned!" : "Session done";
    sub = r.module?.exam_ready ? "The <b>Mastery Exam</b> is unlocked. Score 95% or higher to unlock the next module." : `Mastery ${r.module?.mastery}%`;
    if (r.module?.exam_ready) confetti(60);
  } else if (r.mode === "boost") { em = "⚡"; title = "Boosted!"; sub = r.forecast ? `Predicted exam-day recall is now <b>${r.forecast.recall}%</b>.${r.forecast.weak ? ` ${r.forecast.weak} still shaky. Boost again later today (spacing it out beats doing it twice in a row).` : " Everything's solid."}` : "Nice.";
  } else if (r.mode.startsWith("practice")) { em = "🔁"; title = "Practice done!"; sub = `${pct}% accuracy. Run it again anytime. It never touches your mastery.`; if (pct >= 95) confetti(50);
  } else { em = "🧠"; title = "Reviews cleared!"; sub = "Your memory is still sharp. Next reviews are spaced further out."; }
  if (r.module && r.mode.startsWith("practice")) btns += `<button class="btn fire" id="goAgain">🔁 Again</button>`;
  if (r.module && r.mode !== "review" && !r.mode.startsWith("practice")) {
    if (r.module.exam_ready) btns += `<button class="btn fire" id="goExam">🎯 Take Mastery Exam</button>`;
    else if (!r.module.mastered) btns += `<button class="btn fire" id="goLearn">🔥 Keep learning</button>`;
    if (r.next_module && r.next_module.status === "ready") btns += `<button class="btn fire" id="goNext">Start ${esc(r.next_module.title)} →</button>`;
  }
  view.innerHTML = `<div class="quiz"><div class="card" style="text-align:center;padding:44px">
    <div style="font-size:72px">${em}</div><div class="result-big">${esc(title)}</div><p style="font-size:17px">${sub}</p>
    <div class="stats"><div class="card stat"><b>${r.right}</b><span class="muted">correct</span></div><div class="card stat"><b>${r.wrong}</b><span class="muted">wrong</span></div>
    <div class="card stat"><b>${pct}%</b><span class="muted">accuracy</span></div><div class="card stat"><b style="color:var(--gold)">+${r.xp + (r.bonus || 0)}</b><span class="muted">XP</span></div></div>
    <div class="row" style="justify-content:center">${btns}<button class="btn" id="back">Back to subject</button></div></div></div>`;
  (r.badges || []).forEach(b => toast(`<b>${b.icon} Badge unlocked: ${esc(b.name)}</b><div class="small muted">${esc(b.desc)}</div>`, "gold", 7000));
  const mid = Q.module_id, back = Q.backTo;
  $("#back").onclick = () => location.hash = back && back !== "#/quiz" ? back : "#/";
  if ($("#goExam")) $("#goExam").onclick = () => modAction(null, null, "exam", r.module.id);
  if ($("#goAgain")) $("#goAgain").onclick = () => startQuiz(r.module.id, r.mode);
  if ($("#goLearn")) $("#goLearn").onclick = () => startQuiz(r.module.id, "learn");
  if ($("#goNext")) $("#goNext").onclick = () => startQuiz(r.next_module.id, "learn");
}
function celebrate(em, title, html) {
  const m = $("#modal"); m.classList.remove("hidden");
  m.innerHTML = `<div class="card"><div class="em">${em}</div><h2 style="font-size:32px;margin:10px 0">${title}</h2><p class="muted">${html}</p><button class="btn fire" id="cok">Let's go</button></div>`;
  $("#cok").onclick = () => m.classList.add("hidden"); confetti(80);
}
function confetti(n = 160) {
  const c = $("#confetti"), x = c.getContext("2d"); c.width = innerWidth; c.height = innerHeight;
  const cols = ["#ffd23f", "#ff7a1a", "#ff2e3a", "#35d07f", "#fff3b0"];
  const ps = Array.from({length: n}, () => ({x: innerWidth / 2 + (Math.random() - .5) * 300, y: innerHeight * .35, vx: (Math.random() - .5) * 16, vy: -Math.random() * 16 - 4, s: Math.random() * 7 + 4, r: Math.random() * 6, c: cols[Math.floor(Math.random() * cols.length)]}));
  let t = 0; (function f() { x.clearRect(0, 0, c.width, c.height);
    ps.forEach(p => { p.vy += .45; p.x += p.vx; p.y += p.vy; p.r += .2; x.save(); x.translate(p.x, p.y); x.rotate(p.r); x.fillStyle = p.c; x.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2); x.restore(); });
    if (++t < 160) requestAnimationFrame(f); else x.clearRect(0, 0, c.width, c.height); })();
}

/* ---------------- badges / stats ---------------- */
async function badgesPage() {
  const s = await refreshState(), p = s.profile;
  const days = []; for (let i = 55; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); const k = d.toISOString().slice(0, 10); days.push([k, p.history[k] || 0]); }
  const max = Math.max(1, ...days.map(d => d[1]));
  view.innerHTML = `<h1 style="font-size:36px">Rewards</h1><div class="muted">Level up by answering right. Combos multiply XP (up to x2.5). Exams give x1.5.</div>
  <div class="stats">
    <div class="card stat"><b>Lv ${p.level}</b><span class="muted">${esc(p.rank)}</span><div class="bar" style="margin-top:8px"><i style="width:${Math.round(100 * p.into / p.need)}%"></i></div></div>
    <div class="card stat"><b>${p.xp.toLocaleString()}</b><span class="muted">total XP</span></div>
    <div class="card stat"><b>🔥 ${p.day_streak}</b><span class="muted">day streak (best ${p.best_day_streak})</span></div>
    <div class="card stat"><b>⚡ ${p.best_combo}</b><span class="muted">best combo</span></div>
    <div class="card stat"><b>${p.accuracy}%</b><span class="muted">accuracy (${p.answered} answered)</span></div></div>
  <div class="card" style="margin-bottom:24px"><b>Study heat (last 8 weeks)</b><div class="heat">${days.map(([k, v]) => `<i title="${k}: ${v}" style="${v ? `background:rgba(255,122,26,${.25 + .75 * v / max})` : ""}"></i>`).join("")}</div></div>
  <h2 style="margin-bottom:14px">Badges · ${p.badges.filter(b => b.earned).length}/${p.badges.length}</h2>
  <div class="grid">${p.badges.map(b => `<div class="card badge ${b.earned ? "on" : ""}"><div class="ic">${b.icon}</div><b>${esc(b.name)}</b><div class="small muted">${esc(b.desc)}</div></div>`).join("")}</div>`;
}

/* ---------------- settings ---------------- */
async function settingsPage() {
  const s = await refreshState(), st = s.settings, cl = st.claude;
  const isC = st.provider === "claude";
  view.innerHTML = `<h1 style="font-size:36px;margin-bottom:6px">Settings</h1><div class="muted" style="margin-bottom:18px">Choose who scans your modules.</div>
  <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(300px,1fr));max-width:900px">
    <div class="card prov ${isC ? "on" : ""}" data-p="claude">
      <div class="row between"><h3 style="font-size:22px">🟠 Claude Pro</h3>${isC ? `<span class="tag ok">in use</span>` : ""}</div>
      <p class="muted small">Uses your Claude Pro plan (through Claude Code on this PC). No API key, no extra cost.</p>
      <div class="small" style="margin:8px 0">${cl.installed ? `<span class="tag ok">Claude Code found</span>` : `<span class="tag critical">not connected yet</span>`}</div>
      <div class="row"><button class="btn sm fire" id="cSetup">${cl.installed ? "Re-login" : "Connect Claude Pro"}</button>
        <button class="btn sm" id="cTest" ${cl.installed ? "" : "disabled"}>Test</button>
        ${!isC ? `<button class="btn sm" id="useC">Use Claude</button>` : ""}</div>
      <div style="margin-top:12px"><b class="small">Scan speed</b>
        <select id="cModel" style="margin-top:6px">
          <option value="haiku" ${st.claude_model === "haiku" ? "selected" : ""}>⚡ Fast (Haiku): quickest, good questions</option>
          <option value="sonnet" ${st.claude_model === "sonnet" ? "selected" : ""}>⚖️ Balanced (Sonnet): recommended</option>
          <option value="opus" ${st.claude_model === "opus" ? "selected" : ""}>🎯 Thorough (Opus): best, slowest, uses more of your Pro limit</option>
        </select></div>
      <p class="dim small" style="margin-top:10px">Connect opens a window: it installs Claude Code (first time) and asks you to sign in with your Pro account once.</p>
    </div>
    <div class="card prov ${!isC ? "on" : ""}" data-p="gemini">
      <div class="row between"><h3 style="font-size:22px">🔷 Gemini (free)</h3>${!isC ? `<span class="tag ok">in use</span>` : ""}</div>
      <p class="muted small">Free key from <b>aistudio.google.com/apikey</b>. ${isC ? "Optional: if added, it's used for quick essay/answer checks (faster)." : ""}</p>
      <div style="margin:8px 0">${st.has_key ? `<span class="tag ok">key saved ${esc(st.key_hint)}</span>` : `<span class="tag">no key</span>`}</div>
      <input id="key" type="password" placeholder="${st.has_key ? "Paste a new key to replace" : "Paste your key here"}">
      <div style="margin-top:10px"><b class="small">Scan speed</b>
        <select id="gspeed" style="margin-top:6px">
          <option value="balanced" ${st.gemini_speed !== "fast" ? "selected" : ""}>⚖️ Balanced (Flash): better questions</option>
          <option value="fast" ${st.gemini_speed === "fast" ? "selected" : ""}>⚡ Fastest (Flash-Lite): quickest scans</option>
        </select></div>
      <select id="model" style="margin-top:8px"><option value="auto">Model: Auto (recommended)</option>${st.model !== "auto" ? `<option selected>${esc(st.model)}</option>` : ""}</select>
      <div class="row" style="margin-top:10px"><button class="btn sm" id="save">Save key</button><button class="btn sm" id="test">Test</button><button class="btn sm ghost" id="loadM">Models</button>
        ${isC ? `<button class="btn sm" id="useG">Use Gemini</button>` : ""}</div>
    </div>
  </div>
  <div class="card" style="max-width:900px;margin-top:16px"><b>Strictness</b>
    <p class="muted small">How many correct answers in a row each question needs, and what happens when you miss one.</p>
    <select id="strict" style="max-width:520px">
      <option value="chill" ${st.strict === "chill" ? "selected" : ""}>😌 Chill: 2 in a row · a miss drops 1 level</option>
      <option value="normal" ${st.strict === "normal" ? "selected" : ""}>🔥 Normal: 3 in a row · a miss drops 1 level</option>
      <option value="hardcore" ${st.strict === "hardcore" ? "selected" : ""}>💀 Hardcore: 3 in a row · a miss resets to 0</option>
    </select></div>
  <label class="sw" style="margin-top:20px"><input type="checkbox" id="judge" ${st.ai_judge ? "checked" : ""}> Let AI accept correct synonyms in identification (strict)</label>`;
  const setP = async p => { await api("settings", {provider: p}); toast(p === "claude" ? "Using Claude Pro for scanning ✓" : "Using Gemini for scanning ✓", "gold"); settingsPage(); };
  if ($("#useC")) $("#useC").onclick = () => setP("claude");
  if ($("#useG")) $("#useG").onclick = () => setP("gemini");
  $("#cModel").onchange = async () => { await api("settings", {claude_model: $("#cModel").value}); toast("Scan speed saved ✓ (applies to the next scan)"); };
  $("#gspeed").onchange = async () => { await api("settings", {gemini_speed: $("#gspeed").value}); toast("Gemini scan speed saved ✓"); };
  $("#strict").onchange = async () => { await api("settings", {strict: $("#strict").value}); toast("Strictness saved ✓"); };
  $("#judge").onchange = () => api("settings", {ai_judge: $("#judge").checked});
  $("#cSetup").onclick = async () => { try { await api("claude/setup", {}); await api("settings", {provider: "claude"});
    toast("A setup window opened. Sign in with your Pro account there, then come back and press <b>Test</b>.", "gold", 9000);
    let n = 0; const t = setInterval(async () => { n++; const r = await api("state").catch(() => null); if (r?.settings.claude.installed || n > 60) { clearInterval(t); if (location.hash === "#/settings") settingsPage(); } }, 5000);
  } catch (e) { fail(e); } };
  $("#cTest").onclick = async () => { const b = $("#cTest"); b.innerHTML = `<span class="spin"></span> Testing`;
    try { await api("claude/test", {}); toast("✅ Claude Pro is connected! Upload your modules.", "gold"); if (!isC) await setP("claude"); }
    catch (e) { fail(e); } b.textContent = "Test"; };
  $("#loadM").onclick = async () => { try { const r = await api("models"); const cur = $("#model").value;
    $("#model").innerHTML = `<option value="auto">Model: Auto (${esc(r.auto[0] || "")})</option>` + r.models.map(m => `<option ${m === cur ? "selected" : ""}>${esc(m)}</option>`).join(""); } catch (e) { fail(e); } };
  $("#save").onclick = async () => { try { await api("settings", {api_key: $("#key").value, model: $("#model").value}); toast("Saved ✓"); settingsPage(); } catch (e) { fail(e); } };
  $("#test").onclick = async () => { const b = $("#test"); b.innerHTML = `<span class="spin"></span>`;
    try { if ($("#key").value) await api("settings", {api_key: $("#key").value, model: $("#model").value});
      const r = await api("test", {}); toast(`✅ Gemini works (${esc(r.models[0])})`, "gold"); } catch (e) { fail(e); } b.textContent = "Test"; };
}

route();
