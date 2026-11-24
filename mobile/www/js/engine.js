/* Cooked mobile engine: everything runs on the phone (port of the desktop engine.py).
   Exposes window.LocalAPI.handle(method, path, body) with the same routes the desktop server has. */
(function () {
"use strict";
const DAY = 86400;
const now = () => Date.now() / 1000;
const uid = (n = 10) => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => (b % 36).toString(36)).join("").slice(0, n);
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
class Blocked extends Error { constructor(m) { super(m); this.blocked = true; this.status = 423; } }
class HttpErr extends Error { constructor(m, s = 400) { super(m); this.status = s; } }

/* ------------------------------------------------------------ storage */
const LS_KEY = "cooked-db-v1";
const empty = () => ({
  profile: {xp: 0, combo: 0, best_combo: 0, day_streak: 0, best_day_streak: 0, last_day: null, answered: 0, correct: 0,
            reviews_correct: 0, badges: {}, history: {}},
  settings: {api_key: "", model: "auto", ai_judge: true, provider: "gemini", strict: "normal", gemini_speed: "balanced"},
  decks: {}, modules: {}, sessions: {}});
let DB;
function load() {
  try { DB = JSON.parse(localStorage.getItem(LS_KEY)) || empty(); } catch { DB = empty(); }
  const e = empty();
  for (const k in e) if (!(k in DB)) DB[k] = e[k];
  for (const k in e.profile) if (!(k in DB.profile)) DB.profile[k] = e.profile[k];
  for (const k in e.settings) if (!(k in DB.settings)) DB.settings[k] = e.settings[k];
}
function save() {      // write immediately: the phone can close the app at any moment
  try { localStorage.setItem(LS_KEY, JSON.stringify(DB)); } catch (e) { console.error("save failed", e); }
}
addEventListener("pagehide", save); document.addEventListener("visibilitychange", () => document.hidden && save());
// binary files (module sources, diagram images) live in IndexedDB
const idb = new Promise((res, rej) => { const r = indexedDB.open("cooked-files", 1);
  r.onupgradeneeded = () => r.result.createObjectStore("f"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
async function fput(key, blob) { const d = await idb; return new Promise((res, rej) => { const t = d.transaction("f", "readwrite"); t.objectStore("f").put(blob, key); t.oncomplete = res; t.onerror = () => rej(t.error); }); }
async function fget(key) { const d = await idb; return new Promise((res, rej) => { const q = d.transaction("f").objectStore("f").get(key); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); }
async function fdelPrefix(prefix) { const d = await idb; return new Promise(res => { const t = d.transaction("f", "readwrite"); const s = t.objectStore("f");
  const c = s.openCursor(); c.onsuccess = () => { const cur = c.result; if (cur) { if (String(cur.key).startsWith(prefix)) cur.delete(); cur.continue(); } }; t.oncomplete = res; }); }
const b64 = async blob => { const buf = new Uint8Array(await blob.arrayBuffer()); let s = ""; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000)); return btoa(s); };
const fromB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

/* ------------------------------------------------------------ gemini client */
const G = "https://generativelanguage.googleapis.com";
const DEFAULT_MODELS = ["gemini-flash-latest", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-flash-lite-latest", "gemini-3.5-flash-lite"];
const GC = {names: null, t: 0, good: null, bad: {}, noThink: new Set()};
class GemErr extends Error { constructor(m, code = 0, details = []) { super(m); this.code = code; this.details = details; this.status = 502; } }
async function greq(url, body, timeout = 300) {
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), timeout * 1000);
  try {
    const r = await fetch(url, {method: body ? "POST" : "GET", headers: {"x-goog-api-key": DB.settings.api_key, "Content-Type": "application/json"},
                                body: body ? JSON.stringify(body) : undefined, signal: ctl.signal});
    const txt = await r.text(); let j = {}; try { j = JSON.parse(txt || "{}"); } catch {}
    if (!r.ok) { const e = j.error || {}; throw new GemErr(`Gemini HTTP ${r.status}: ${(e.message || txt).slice(0, 300)}`, r.status, e.details || []); }
    return j;
  } catch (e) { if (e instanceof GemErr) throw e; throw new GemErr(e.name === "AbortError" ? "Gemini took too long." : "Network error. Check your internet connection.", 0); }
  finally { clearTimeout(tm); }
}
const vkey = n => { const m = n.match(/(\d+(?:\.\d+)?)/); const v = m ? parseFloat(m[1]) : 0; const pen = (n.includes("lite") ? 1 : 0) + (/preview|exp/.test(n) ? 2 : 0); return [-pen, v]; };
const cmpK = (a, b) => { const x = vkey(a), y = vkey(b); return y[0] - x[0] || y[1] - x[1]; };
async function listModels() {
  const out = []; let tok = null;
  do { const j = await greq(`${G}/v1beta/models?pageSize=200${tok ? "&pageToken=" + tok : ""}`, null, 30);
    for (const m of j.models || []) if ((m.supportedGenerationMethods || []).includes("generateContent")) out.push(m.name.replace("models/", ""));
    tok = j.nextPageToken; } while (tok);
  return out;
}
async function pickCandidates(pref) {
  if (pref && pref !== "auto" && pref !== "fast") return [pref];
  let names;
  try { if (!GC.names || now() - GC.t > 3600) { GC.names = await listModels(); GC.t = now(); } names = GC.names; } catch { names = DEFAULT_MODELS; }
  const bad = ["image", "tts", "live", "audio", "embedding", "vision", "learnlm", "gemma", "robotics", "computer", "native"];
  const flash = names.filter(n => n.includes("flash") && !bad.some(b => n.includes(b))).sort(cmpK);
  let out = flash.slice(0, 6); if (!out.length) out = [...DEFAULT_MODELS];
  for (const d of ["gemini-flash-latest", "gemini-flash-lite-latest"]) if (names.includes(d) && !out.includes(d)) out.push(d);
  if (pref === "fast") { const lite = names.filter(n => n.includes("flash-lite") && !bad.some(b => n.includes(b))).sort(cmpK).slice(0, 3); out = [...lite, ...out.filter(m => !lite.includes(m))]; }
  const t = now(); out.sort((a, b) => ((GC.bad[a] || 0) > t) - ((GC.bad[b] || 0) > t) || (pref !== "fast" ? (a !== GC.good) - (b !== GC.good) : 0));
  return out;
}
function thinking(m) { m = m.toLowerCase(); if (/lite|2\.0|1\.5/.test(m)) return null; if (m.includes("2.5")) return m.includes("flash") ? {thinkingBudget: 0} : {thinkingBudget: 128};
  return m.includes("flash") ? {thinkingLevel: "minimal"} : {thinkingLevel: "low"}; }
function parseJSON(t) {
  t = t.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  try { return JSON.parse(t); } catch { const m = t.match(/[\{\[][\s\S]*[\}\]]/); if (m) return JSON.parse(m[0]); throw new Error("bad json"); }
}
const sleep = s => new Promise(r => setTimeout(r, s * 1000));
function retryDelay(e, a) { for (const d of e.details || []) if (d.retryDelay) { const v = parseFloat(d.retryDelay); if (!isNaN(v)) return Math.min(v + 1, 65); } return Math.min(5 * 2 ** a, 60); }
async function generateJSON(parts, schema, system, temperature = .4, log, timeout = 300, quick = false) {
  const body = {contents: [{role: "user", parts}], generationConfig: {temperature, responseMimeType: "application/json"}};
  if (schema) body.generationConfig.responseSchema = schema;
  if (system) body.systemInstruction = {parts: [{text: system}]};
  let last = null; const tried = [];
  let pref = DB.settings.model; if (pref === "auto" && DB.settings.gemini_speed === "fast") pref = "fast";
  for (const model of await pickCandidates(pref)) {
    tried.push(model); let waited = false; let think = GC.noThink.has(model) ? null : thinking(model);
    for (let a = 0; a < (quick ? 1 : 3); a++) {
      if (think) body.generationConfig.thinkingConfig = think; else delete body.generationConfig.thinkingConfig;
      try {
        log && log(`Asking ${model}...`);
        const res = await greq(`${G}/v1beta/models/${model}:generateContent`, body, timeout);
        const c = (res.candidates || [])[0]; if (!c) throw new GemErr("Gemini returned no answer.", -2);
        const text = (c.content?.parts || []).filter(p => !p.thought).map(p => p.text || "").join("");
        try { const o = parseJSON(text); GC.good = model; return o; }
        catch { last = new GemErr("Gemini returned invalid JSON" + (c.finishReason === "MAX_TOKENS" ? " (cut off)" : ""), -1); continue; }
      } catch (e) {
        if (!(e instanceof GemErr)) throw e; last = e; const code = e.code; const msg = (e.message + JSON.stringify(e.details)).toLowerCase();
        if (code === 401 || code === 403 || (code === 400 && msg.includes("api key"))) {
          const k = DB.settings.api_key || "", why = (e.message.split(": ").slice(1).join(": ") || e.message).slice(0, 160);
          throw new GemErr(`Google rejected the key ending "…${k.slice(-4)}" (${k.length} characters): ${why}. On AI Studio tap your key, then "Copy key" (the shortened text in the list won't work).`, code); }
        if (code === 400 && think && msg.includes("think")) { GC.noThink.add(model); think = null; continue; }
        if (code === 400 || code === 404) break;
        if (code === 429) { const dead = msg.includes("limit: 0") || msg.includes("perday") || msg.includes("per day");
          if (dead || waited) { GC.bad[model] = now() + (dead ? 3600 : 120); break; }
          const d = Math.min(retryDelay(e, a), 20); log && log(`Busy, retrying in ${Math.round(d)}s...`); await sleep(d); waited = true; continue; }
        if ([0, 500, 502, 503, 504].includes(code)) { if (quick) break; await sleep(Math.min(retryDelay(e, a), 15)); continue; }
        throw e;
      }
    }
  }
  if (last && last.code === 429) throw new GemErr(`Free-tier quota reached on all models (${tried.join(", ")}). Try again later.`, 429);
  throw last || new GemErr("All Gemini models failed");
}

/* ------------------------------------------------------------ extraction (on the phone) */
const IMG_MIME = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"};
const extOf = n => (n.match(/\.[^.]+$/) || [""])[0].toLowerCase();
const numOf = s => { const m = s.match(/\d+/g); return m ? +m[m.length - 1] : 0; };
async function extract(mid, filename, blob, log) {
  const ext = extOf(filename);
  if (ext === ".pdf") return {kind: "pdf", parts: [{inline_data: {mime_type: "application/pdf", data: await b64(blob)}}], visuals: [], pages: 0};
  if (ext === ".ppt" || ext === ".doc") throw new HttpErr(`Old ${ext} isn't supported. Save it as ${ext}x or PDF.`);
  if (IMG_MIME[ext]) { await fput(`${mid}/media/img1${ext}`, blob);
    return {kind: "image", parts: [{text: '[VISUAL ref="img:img1' + ext + '"]'}, {inline_data: {mime_type: IMG_MIME[ext], data: await b64(blob)}}], visuals: [{ref: "img:img1" + ext}], pages: 1}; }
  if ([".txt", ".md", ".csv", ".html", ".htm"].includes(ext)) { let t = await blob.text(); if (ext.startsWith(".htm")) t = t.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ");
    return {kind: "text", parts: [{text: t}], visuals: [], pages: 1}; }
  if (![".pptx", ".ppsx", ".docx"].includes(ext)) throw new HttpErr(`Unsupported file type ${ext}. Use PDF, PPTX, DOCX, images or TXT.`);
  const zip = await JSZip.loadAsync(blob); const parts = [], visuals = []; const seen = new Set(); let total = 0;
  const xml = async p => new DOMParser().parseFromString(await zip.file(p).async("string"), "application/xml");
  const rels = async p => { const d = p.substring(0, p.lastIndexOf("/")); const rp = `${d}/_rels/${p.substring(p.lastIndexOf("/") + 1)}.rels`; const out = {};
    if (!zip.file(rp)) return out; const x = await xml(rp);
    for (const r of x.getElementsByTagName("Relationship")) { if (r.getAttribute("TargetMode") === "External") continue;
      const segs = (d + "/" + r.getAttribute("Target")).split("/"); const st = []; for (const s of segs) { if (s === "..") st.pop(); else if (s && s !== ".") st.push(s); } out[r.getAttribute("Id")] = st.join("/"); }
    return out; };
  const paras = (doc, ns, ptag, ttag) => [...doc.getElementsByTagNameNS(ns, ptag)].map(p => [...p.getElementsByTagNameNS(ns, ttag)].map(t => t.textContent).join("").trim()).filter(Boolean);
  const A = "http://schemas.openxmlformats.org/drawingml/2006/main", R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships", W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const addImg = async (path, where) => {
    const e = extOf(path); if (!IMG_MIME[e] || !zip.file(path)) return; const data = await zip.file(path).async("uint8array");
    if (data.length < 6144 || visuals.length >= 40 || total + data.length > 14e6) return;
    let h = 0; for (let i = 0; i < data.length; i += 97) h = (h * 31 + data[i]) >>> 0; const hk = h + ":" + data.length; if (seen.has(hk)) return; seen.add(hk);
    total += data.length; const name = `img${visuals.length + 1}_${h.toString(16)}${e}`;
    const bl = new Blob([data], {type: IMG_MIME[e]}); await fput(`${mid}/media/${name}`, bl);
    visuals.push({ref: "img:" + name, where}); parts.push({text: `[VISUAL ref="img:${name}" located at ${where}]`}, {inline_data: {mime_type: IMG_MIME[e], data: await b64(bl)}});
  };
  let pages = 1;
  if (ext === ".docx") {
    const doc = await xml("word/document.xml"); const rl = await rels("word/document.xml"); let buf = [], n = 0;
    for (const p of doc.getElementsByTagNameNS(W, "p")) { n++; const t = [...p.getElementsByTagNameNS(W, "t")].map(x => x.textContent).join("").trim(); if (t) buf.push(t);
      for (const bl of p.getElementsByTagNameNS(A, "blip")) { const tgt = rl[bl.getAttributeNS(R, "embed")]; if (tgt) { parts.push({text: buf.join("\n")}); buf = []; await addImg(tgt, `paragraph ${n}`); } } }
    parts.push({text: buf.join("\n")}); pages = Math.max(1, Math.round(blob.size / 40000));
  } else {
    const slides = Object.keys(zip.files).filter(f => /^ppt\/slides\/slide\d+\.xml$/.test(f)).sort((a, b) => numOf(a) - numOf(b));
    if (!slides.length) throw new HttpErr("No slides found in that PPTX.");
    pages = slides.length; const usage = {}; const R2 = {};
    for (const s of slides) { R2[s] = await rels(s); for (const t of new Set(Object.values(R2[s]))) if (t.includes("/media/")) usage[t] = (usage[t] || 0) + 1; }
    const logoLimit = Math.max(3, Math.floor(slides.length / 3));
    for (const s of slides) {
      log && log(`Reading slide ${numOf(s)}/${slides.length}...`);
      const doc = await xml(s); const lines = paras(doc, A, "p", "t"); let notes = "";
      for (const t of Object.values(R2[s])) if (t.includes("notesSlide") && zip.file(t)) { const nl = paras(await xml(t), A, "p", "t").filter(l => !/^\d+$/.test(l)); if (nl.length) notes = "\nSpeaker notes: " + nl.join(" "); }
      parts.push({text: `\n=== Slide ${numOf(s)} ===\n` + lines.join("\n") + notes});
      for (const bl of doc.getElementsByTagNameNS(A, "blip")) { const tgt = R2[s][bl.getAttributeNS(R, "embed")]; if (tgt && (usage[tgt] || 0) <= logoLimit) await addImg(tgt, `slide ${numOf(s)}`); }
    }
  }
  return {kind: ext.slice(1), parts: parts.filter(p => p.inline_data || (p.text || "").trim()), visuals, pages};
}

/* ------------------------------------------------------------ prompts & validation */
const XP_BASE = {mcq: 10, true_false: 5, identification: 15, fill_blank: 12, enumeration: 20, essay: 30};
const TYPE_LABEL = {mcq: "Multiple Choice", true_false: "True or False", identification: "Identification", fill_blank: "Fill in the Blank", enumeration: "Enumeration", essay: "Essay"};
const SYSTEM = "You are an expert university exam setter and tutor. You read course modules completely, including every diagram, figure, table, chart, formula and slide, and you never invent facts that are not supported by the module. Write in the same language as the module.";
const STR = {type: "STRING"}, ARR = it => ({type: "ARRAY", items: it});
const CONCEPT = {type: "OBJECT", required: ["id", "title", "explanation", "importance"], properties: {id: STR, title: STR, explanation: STR,
  importance: {type: "STRING", enum: ["critical", "high", "medium"]}, must_memorize: ARR(STR), visual_ref: STR, visual_box: ARR({type: "NUMBER"}), visual_description: STR}};
const QUESTION = {type: "OBJECT", required: ["type", "concept_id", "prompt", "explanation"], properties: {type: {type: "STRING", enum: Object.keys(XP_BASE)},
  concept_id: STR, prompt: STR, choices: ARR(STR), correct_index: {type: "INTEGER"}, answer: STR, accepted: ARR(STR),
  items: ARR({type: "OBJECT", required: ["text"], properties: {text: STR, accepted: ARR(STR)}}), ordered: {type: "BOOLEAN"}, rubric: ARR(STR),
  explanation: STR, visual_ref: STR, visual_box: ARR({type: "NUMBER"}), difficulty: {type: "INTEGER"}}};
const ONE_PASS = {type: "OBJECT", required: ["title", "summary", "concepts", "questions"], properties: {title: STR, summary: STR, concepts: ARR(CONCEPT), questions: ARR(QUESTION)}};
const NOTES_ONLY = {type: "OBJECT", required: ["title", "summary", "concepts"], properties: {title: STR, summary: STR, concepts: ARR(CONCEPT)}};
const Q_ONLY = {type: "OBJECT", required: ["questions"], properties: {questions: ARR(QUESTION)}};
function visualRules(kind, visuals) {
  if (kind === "pdf") return 'VISUALS: This is a PDF. ONLY when a question truly needs a picture (diagram, network topology, flowchart, chart, labeled figure, table, architecture/layer model), set visual_ref to "page:N" (1-based) AND visual_box to [left, top, right, bottom] as fractions 0-1 tightly around just the diagram. NEVER for text-only slides, title slides, photos, logos, icons. Most questions should have NO visual.';
  if (visuals.length) return `VISUALS: Images are embedded with markers like [VISUAL ref="img:..."]. ONLY when a question truly needs a picture (diagram, topology, flowchart, chart, labeled figure, table), set visual_ref to its exact ref. Valid refs: ${visuals.map(v => v.ref).join(", ")}. NEVER use photos, logos, icons or decorative images. Most questions should have NO visual.`;
  return "VISUALS: there are no images; leave visual_ref empty.";
}
const NOTES_PROMPT = `Scan this ENTIRE module, every page/slide, every diagram, figure, table and chart.
Extract EVERYTHING that is very important to understand and that could appear in an exam: definitions, terms, classifications, lists/steps (with exact count and order), formulas, rules, properties, differences/comparisons, examples, dates, people, causes/effects, and what each important diagram shows.
Be exhaustive. Skip only trivia like headers, logos, instructor names and housekeeping.
Each concept: a short title, a complete but clear explanation (as a reviewer), importance (critical = very likely in exam), and must_memorize = exact terms/items to memorize word-for-word. Give concepts ids c1, c2, ... in the module's order. `;
const ONE_PASS_RULES = `
THEN, in the same JSON, write the question bank ("questions") for ACTIVE RECALL:
- For EVERY concept: 2 core questions about its key term/idea (one identification or fill_blank for the exact term, one mcq or true_false from a different angle).
- Every list/types/steps/components: one enumeration (say how many). ordered=true only if order matters.
- Every exam-relevant diagram: one question about what it shows, with visual_ref set.
- Critical "explain/compare/discuss" concepts: one essay with a 3-5 point rubric.
- mcq: exactly 4 plausible choices, correct_index 0-3. true_false: correct_index 0=True 1=False, about half False.
- identification/fill_blank: answer + accepted variants. fill_blank prompt contains "____".
- explanation: ONE short sentence. concept_id must match. No duplicates. Only facts from the module.`;
const box = b => { try { b = b.map(x => clamp(+x, 0, 1)); if (b.length === 4 && b[2] - b[0] > .08 && b[3] - b[1] > .08) return b.map(x => Math.round(x * 1000) / 1000); } catch {} return null; };
function validate(raw, visuals, kind) {
  const refs = new Set(visuals.map(v => v.ref)), out = [], seen = new Set();
  for (const q of raw || []) {
    const t = q.type, p = (q.prompt || "").trim(), key = p.toLowerCase().replace(/\W+/g, "");
    if (!p || seen.has(key) || !XP_BASE[t]) continue;
    let vr = (q.visual_ref || "").trim(); if (vr && !((kind === "pdf" && /^page:\d+$/.test(vr)) || refs.has(vr))) vr = "";
    const c = {id: uid(), type: t, prompt: p, concept_id: q.concept_id || "", explanation: q.explanation || "", visual_ref: vr, difficulty: q.difficulty || 2,
               visual_box: vr.startsWith("page:") ? box(q.visual_box || []) : null};
    if (t === "mcq") { const ch = (q.choices || []).filter(x => String(x).trim()); const ci = q.correct_index; if (ch.length < 3 || !Number.isInteger(ci) || ci < 0 || ci >= ch.length) continue; Object.assign(c, {choices: ch, correct_index: ci}); }
    else if (t === "true_false") { let ci = q.correct_index; if (ci !== 0 && ci !== 1) { const a = String(q.answer || "").toLowerCase(); if (a !== "true" && a !== "false") continue; ci = a === "true" ? 0 : 1; } Object.assign(c, {choices: ["True", "False"], correct_index: ci}); }
    else if (t === "identification" || t === "fill_blank") { const a = (q.answer || "").trim(); if (!a) continue; c.answer = a; c.accepted = [...new Set([a, ...(q.accepted || []).filter(x => x && x.trim())])]; }
    else if (t === "enumeration") { const items = (q.items || []).filter(i => (i.text || "").trim()).map(i => ({text: i.text.trim(), accepted: [...new Set([i.text.trim(), ...(i.accepted || []).filter(Boolean)])]})); if (items.length < 2) continue; Object.assign(c, {items, ordered: !!q.ordered}); }
    else if (t === "essay") { const r = (q.rubric || []).filter(x => x.trim()); if (r.length < 2) continue; c.rubric = r; }
    seen.add(key); out.push(c);
  }
  return out;
}

/* ------------------------------------------------------------ scanning */
const newProg = () => ({streak: 0, correct: 0, wrong: 0, box: -1, due: null, last: null});
const SCANQ = []; let scanning = false;
function queueScan(mid) { SCANQ.push(mid); runScans(); }
async function runScans() {
  if (scanning) return; scanning = true;
  while (SCANQ.length) {
    const mid = SCANQ.shift(); const m = DB.modules[mid]; if (!m) continue;
    m.status = "scanning"; m.error = ""; m.scan_started = now(); m.stage_pct = 2; m.eta = estimate(m); save();
    try { await scanModule(m); const h = DB.settings.scan_hist = DB.settings.scan_hist || []; h.push({sec: now() - m.scan_started, pages: m.pages || 10, model: "gemini"}); h.splice(0, Math.max(0, h.length - 12)); }
    catch (e) { console.error(e); m.status = "error"; m.error = e.message || String(e); }
    save(true);
  }
  scanning = false;
}
function estimate(m) { const h = (DB.settings.scan_hist || []).filter(x => x.pages); const per = h.length ? h.reduce((a, x) => a + x.sec / x.pages, 0) / h.length : 4; return Math.round((h.length ? 15 : 25) + per * (m.pages || 10)); }
async function scanModule(m) {
  if (!DB.settings.api_key) throw new GemErr("No Gemini API key yet. Open Settings and paste your free key.");
  const log = s => { m.progress = s; };
  log("Reading file..."); const blob = await fget(`${m.id}/source`);
  const ex = await extract(m.id, m.filename, blob, log);
  m.kind = ex.kind; m.visuals = ex.visuals; m.pages = ex.pages || m.pages;
  if (ex.kind === "pdf" && !m.pages) { const s = await blob.text().catch(() => ""); m.pages = (s.match(/\/Type\s*\/Page[^s]/g) || []).length || Math.max(1, Math.round(blob.size / 80000)); }
  m.eta = estimate(m); m.stage_pct = 8; log("Gemini is reading every page & writing questions...");
  const vr = visualRules(ex.kind, ex.visuals);
  let concepts = [], questions = [], res = null;
  try {
    res = await generateJSON([...ex.parts, {text: NOTES_PROMPT + vr + ONE_PASS_RULES}], ONE_PASS, SYSTEM, .3, log);
    concepts = res.concepts || []; questions = validate(res.questions, ex.visuals, ex.kind);
  } catch (e) { if (/API key|quota/i.test(e.message)) throw e; }
  if (!concepts.length || questions.length < Math.max(5, concepts.length)) {
    m.stage_pct = 15; log("Big module: two-step scan...");
    res = await generateJSON([...ex.parts, {text: NOTES_PROMPT + vr}], NOTES_ONLY, SYSTEM, .2, log);
    concepts = res.concepts || []; if (!concepts.length) throw new GemErr("Gemini found no content in this file.");
    questions = [];
    for (let i = 0; i < concepts.length; i += 12) {
      const ch = concepts.slice(i, i + 12); m.stage_pct = 45 + Math.round(50 * i / concepts.length); log(`Writing questions (${Math.floor(i / 12) + 1}/${Math.ceil(concepts.length / 12)})...`);
      const r = await generateJSON([...ex.parts, {text: `Using the module and these key concepts, write active-recall questions.${ONE_PASS_RULES}\n${vr}\nCONCEPTS: ${JSON.stringify(ch)}`}], Q_ONLY, SYSTEM, .5, log);
      questions.push(...validate(r.questions, ex.visuals, ex.kind));
    }
  }
  if (questions.length < 3) throw new GemErr("Gemini produced too few valid questions. Try Rescan.");
  for (const c of concepts) { let v = (c.visual_ref || "").trim(); if (v && !((ex.kind === "pdf" && /^page:\d+$/.test(v)) || ex.visuals.some(x => x.ref === v))) c.visual_ref = ""; c.visual_box = (c.visual_ref || "").startsWith("page:") ? box(c.visual_box || []) : null; }
  m.notes = {title: res.title || m.filename, summary: res.summary || "", concepts}; m.title = m.notes.title;
  m.questions = questions; m.progress_q = Object.fromEntries(questions.map(q => [q.id, newProg()]));
  m.status = "ready"; m.progress = `${questions.length} questions from ${concepts.length} key concepts`;
}

/* ------------------------------------------------------------ decks / modules / scope */
function createDeck(name) { const id = uid(8); DB.decks[id] = {id, name: (name || "").trim() || "My Subject", created: now(), order: []}; save(); return id; }
async function addModule(did, filename, data) {
  const deck = DB.decks[did]; const mid = uid(8);
  const blob = new Blob([fromB64(data)]); await fput(`${mid}/source`, blob);
  DB.modules[mid] = {id: mid, deck_id: did, filename, title: filename.replace(/\.[^.]+$/, ""), status: "queued", error: "", progress: "Waiting in line...",
                     created: now(), notes: null, questions: [], progress_q: {}, mastered: false, mastered_at: null, exams: [], pages: null};
  deck.order.push(mid); save(true); queueScan(mid); return mid;
}
function importModule(did, data, sourceName, sourceData) {
  if (typeof data === "string") data = parseJSON(data);
  if (!data || !data.questions) throw new HttpErr("That file has no 'questions'. Use the .cooked.json file Claude made for you.");
  const mid = uid(8); const kind = sourceName && sourceName.toLowerCase().endsWith(".pdf") ? "pdf" : "text";
  const concepts = (data.concepts || []).filter(c => c && c.title).map((c, i) => ({id: c.id || `c${i + 1}`, importance: c.importance || "high", explanation: c.explanation || "", ...c}));
  for (const c of concepts) if (!(kind === "pdf" && /^page:\d+$/.test(c.visual_ref || ""))) c.visual_ref = "";
  const qs = validate(data.questions, [], kind); if (qs.length < 3) throw new HttpErr(`Only ${qs.length} valid questions found in that file.`);
  const title = (data.title || "Imported module").trim();
  DB.modules[mid] = {id: mid, deck_id: did, filename: sourceName || title + ".cooked.json", title, status: "ready", error: "", progress: `${qs.length} questions (imported)`,
    created: now(), kind, visuals: [], imported: true, notes: {title, summary: data.summary || "", concepts}, questions: qs,
    progress_q: Object.fromEntries(qs.map(q => [q.id, newProg()])), mastered: false, mastered_at: null, exams: []};
  if (sourceData) fput(`${mid}/source`, new Blob([fromB64(sourceData)], {type: "application/pdf"}));
  DB.decks[did].order.push(mid); save(true); return {id: mid, count: qs.length};
}
function exportDeck(did) {
  const d = DB.decks[did];
  return {cooked_subject: 1, name: d.name, modules: d.order.map(mid => DB.modules[mid]).filter(m => m.status === "ready").map(m => ({
    title: m.title, summary: m.notes?.summary || "", concepts: m.notes?.concepts || [], questions: m.questions.map(({id, ...q}) => q)}))};
}
const DEPTHS = {critical: ["critical"], important: ["critical", "high"], all: ["critical", "high", "medium"]};
const KEY_RANK = {identification: 0, fill_blank: 1, mcq: 2, true_false: 3};
function keyPick(qs, per = 2) {
  const by = {};
  for (const q of qs) { let r = KEY_RANK[q.type]; if (q.type === "enumeration" && (q.items || []).length <= 3) r = 4; if (r === undefined) continue; (by[q.concept_id] = by[q.concept_id] || []).push([r, q.difficulty || 2, q.prompt.length, q]); }
  return Object.values(by).flatMap(l => l.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]).slice(0, per).map(x => x[3]));
}
function scoped(m, ids, every) { let qs = m.questions.filter(q => ids.has(q.concept_id) || (every && !ids.has(q.concept_id))); if ((m.detail || "key") === "key") qs = keyPick(qs); return qs; }
function scopeInfo(m) {
  const cs = m.notes?.concepts || []; const imp = Object.fromEntries(cs.map(c => [c.id, c.importance || "high"]));
  let ids;
  if (m.scope) ids = new Set(m.scope);
  else { const depth = m.depth || "critical"; ids = new Set(Object.keys(imp).filter(k => (DEPTHS[depth] || DEPTHS.all).includes(imp[k])));
    for (const w of ["important", "all"]) { if (scoped(m, ids, ids.size >= Object.keys(imp).length).length >= 10) break; ids = new Set(Object.keys(imp).filter(k => DEPTHS[w].includes(imp[k]))); } }
  return [ids, ids.size >= Object.keys(imp).length];
}
const activeQs = m => { const [ids, every] = scopeInfo(m); const qs = scoped(m, ids, every); return qs.length ? qs : m.questions; };
function setScope(mid, depth, topics, detail) {
  const m = DB.modules[mid]; if (m.mastered) throw new HttpErr("Already mastered. Its scope is locked in.", 403);
  if (detail === "key" || detail === "full") { m.detail = detail; if (depth == null && topics == null) { save(); return; } }
  if (topics) { const all = new Set((m.notes?.concepts || []).map(c => c.id)); topics = topics.filter(t => all.has(t)); if (!topics.length) throw new HttpErr("Pick at least one topic.");
    m.scope = topics.length === all.size ? null : topics; if (!m.scope) m.depth = "all"; }
  else if (DEPTHS[depth]) { m.depth = depth; m.scope = null; }
  save();
}
function scopeView(mid) {
  const m = DB.modules[mid]; const [ids, every] = scopeInfo(m); const cnt = {}; for (const q of m.questions) cnt[q.concept_id] = (cnt[q.concept_id] || 0) + 1;
  return {depth: m.scope ? "custom" : (m.depth || "critical"), detail: m.detail || "key", mastered: m.mastered,
    concepts: (m.notes?.concepts || []).map(c => ({id: c.id, title: c.title, importance: c.importance || "high", count: cnt[c.id] || 0, on: every || ids.has(c.id)})),
    active: activeQs(m).length, total: m.questions.length};
}

/* ------------------------------------------------------------ mastery, memory model, forecast */
const STRICT = {chill: [2, 1], normal: [3, 1], hardcore: [3, 99]};
const need = () => (STRICT[DB.settings.strict] || STRICT.normal)[0];
const penalty = () => (STRICT[DB.settings.strict] || STRICT.normal)[1];
const PASS_PCT = 95;
const REVIEW0 = 600;
function isUnlocked(m) { const o = DB.decks[m.deck_id].order; const i = o.indexOf(m.id); return o.slice(0, i).every(x => DB.modules[x].mastered); }
function learnRatio(m) { const qs = activeQs(m); if (!qs.length) return 0; return qs.reduce((a, q) => a + Math.min(m.progress_q[q.id].streak, need()), 0) / (need() * qs.length); }
const retr = (p, at) => (!p.S || !p.lr) ? 0 : Math.pow(1 + 19 / 81 * Math.max(0, ((at || now()) - p.lr) / DAY) / p.S, -0.5);
function updateMemory(p, ok) { const R = retr(p), S = p.S; p.S = ok ? (!S ? .6 : Math.min(365, S * (1.4 + 2.2 * (1 - R)))) : (!S ? .15 : Math.max(.15, S * .35)); p.lr = now(); }
function examTs(did) { const d = DB.decks[did]?.exam_date; if (!d) return null; const t = new Date(d + "T08:00:00").getTime() / 1000; return isNaN(t) ? null : t; }
function schedule(p, did) { let gap = Math.max(.25, p.S || 1) * DAY; const ex = examTs(did); const t = now(); if (ex && ex > t) gap = Math.min(gap, Math.max(4 * 3600, .3 * (ex - t))); p.due = t + gap; }
function dueReviews(did) { const t = now(), out = []; for (const m of Object.values(DB.modules)) if (m.mastered && (!did || m.deck_id === did)) for (const q of activeQs(m)) { const p = m.progress_q[q.id]; if (p.due && p.due <= t) out.push([m.id, q.id]); } return out; }
function forecast(did) {
  const ex = examTs(did); const at = ex && ex > now() ? ex : now(); const rs = []; let weak = 0;
  for (const mid of DB.decks[did].order) { const m = DB.modules[mid]; if (m.status !== "ready") continue; for (const q of activeQs(m)) { const r = retr(m.progress_q[q.id], at); rs.push(r); if (r < .8) weak++; } }
  return {exam_date: DB.decks[did].exam_date || null, days_left: ex ? Math.round((ex - now()) / DAY * 10) / 10 : null, recall: rs.length ? Math.round(100 * rs.reduce((a, b) => a + b, 0) / rs.length) : 0, weak, total: rs.length};
}
function setExamDate(did, d) { DB.decks[did].exam_date = d || null; for (const mid of DB.decks[did].order) { const m = DB.modules[mid]; if (m.mastered) for (const q of activeQs(m)) { const p = m.progress_q[q.id]; if (p.lr) schedule(p, did); } } save(); }
const activeSession = (mid, mode) => Object.values(DB.sessions).find(s => !s.done && s.module_id === mid && (!mode || s.mode === mode) && s.queue.length);
function moduleSummary(m) {
  const aq = activeQs(m); const learned = aq.filter(q => m.progress_q[q.id].streak >= need()).length; const [ids, every] = scopeInfo(m); const nc = (m.notes?.concepts || []).length;
  const types = {}; for (const q of aq) types[q.type] = (types[q.type] || 0) + 1; const a = activeSession(m.id);
  return {id: m.id, title: m.title, filename: m.filename, status: m.status, error: m.error, progress: m.progress, unlocked: isUnlocked(m), mastered: m.mastered,
    count: aq.length, total: m.questions.length, depth: m.scope ? "custom" : (m.depth || "critical"), detail: m.detail || "key", scope_topics: every ? nc : ids.size,
    learned, mastery: m.mastered ? 100 : Math.round(learnRatio(m) * 99), exam_ready: !!aq.length && learned === aq.length && !m.mastered,
    exams: (m.exams || []).slice(-5), types, concepts: nc, kind: m.kind, imported: !!m.imported,
    elapsed: m.status === "scanning" && m.scan_started ? Math.round(now() - m.scan_started) : null, eta: m.eta, stage_pct: m.stage_pct || 0, pages: m.pages,
    session: a ? {mode: a.mode, left: new Set(a.queue.map(x => x[1])).size} : null};
}
const deckView = did => { const d = DB.decks[did]; return {id: did, name: d.name, modules: d.order.map(x => moduleSummary(DB.modules[x])), due: dueReviews(did).length, forecast: forecast(did)}; };

/* ------------------------------------------------------------ grading */
function norm(s) { return String(s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9+#]+/g, " ").replace(/\b(a|an|the)\b/g, " ").replace(/\s+/g, " ").trim(); }
function lev(a, b) { if (a.length < b.length) [a, b] = [b, a]; let prev = Array.from({length: b.length + 1}, (_, i) => i);
  for (let i = 1; i <= a.length; i++) { const cur = [i]; for (let j = 1; j <= b.length; j++) cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] !== b[j - 1]))); prev = cur; } return prev[b.length]; }
function similar(a, b) { a = norm(a); b = norm(b); if (!a || !b) return 0; if (a === b || a.replace(/ /g, "") === b.replace(/ /g, "")) return 1; return 1 - lev(a, b) / Math.max(a.length, b.length); }
function match(ans, accepted) {
  const a = norm(ans).replace(/ /g, ""); let best = 0, ok = false;
  for (const x of accepted || []) { const b = norm(x).replace(/ /g, ""); if (!a || !b) continue; const r = similar(ans, x); best = Math.max(best, r); const n = b.length;
    const allow = n <= 4 ? 0 : n <= 8 ? 1 : n <= 14 ? 2 : null; if (a === b || (allow !== null && lev(a, b) <= allow) || (allow === null && r >= .85)) ok = true; }
  return [ok, best];
}
const STOP = new Set("a an the of to in on for and or is are be by with as at it its this that from into which what who how your you".split(" "));
const stems = t => new Set(norm(t).split(" ").filter(w => w.length > 2 && !STOP.has(w)).map(w => w.slice(0, 5)));
function plausible(ans, refs, ctx = "") { if (Math.max(0, ...refs.map(r => similar(ans, r))) >= .55) return true; const a = stems(ans); const pool = new Set([...refs.flatMap(r => [...stems(r)]), ...stems(ctx)]); return [...a].some(x => pool.has(x)); }
const JC = {};
const canAI = () => !!DB.settings.api_key && navigator.onLine !== false;
async function aiJSON(prompt, schema, fast = true) { return generateJSON([{text: prompt}], schema, null, 0, null, fast ? 12 : 60, fast); }
async function aiJudge(q, ans) {
  if (!DB.settings.ai_judge || !canAI()) return null; const k = q.id + "|" + norm(ans); if (k in JC) return JC[k];
  if (!plausible(ans, q.accepted || [q.answer], q.explanation)) return null;
  try { const r = await aiJSON(`You are a STRICT exam checker. Decide if the student's answer means exactly the same thing as the expected answer (a correct synonym, translation, or equivalent wording). Vague, partial, or related-but-different answers are WRONG.\nQuestion: ${q.prompt}\nExpected: ${q.answer}\nStudent: ${ans}\nReturn {"correct": true/false}`,
      {type: "OBJECT", properties: {correct: {type: "BOOLEAN"}}, required: ["correct"]}); return JC[k] = !!r.correct; } catch { return null; }
}
async function grade(q, answer, cmap) {
  const t = q.type;
  if (answer == null || answer === "" || (Array.isArray(answer) && !answer.length) || (typeof answer === "object" && answer.idk)) return {correct: false, score: 0, detail: "No answer (counts as wrong)."};
  if (t === "mcq" || t === "true_false") { const shown = parseInt(answer); const orig = cmap ? cmap[shown] : shown; const ok = orig === q.correct_index; return {correct: ok, score: ok ? 100 : 0, chosen: shown}; }
  if (t === "identification" || t === "fill_blank") { const [ok] = match(answer, q.accepted); if (!ok && norm(answer).length >= 2 && await aiJudge(q, answer)) return {correct: true, score: 100, detail: "Accepted as an equivalent answer."}; return {correct: ok, score: ok ? 100 : 0}; }
  if (t === "enumeration") {
    const given = (Array.isArray(answer) ? answer : String(answer).split("\n")).filter(a => norm(a)); const used = new Set(); const marks = [];
    q.items.forEach((it, idx) => { let hit = null; const cands = q.ordered ? [idx] : given.map((_, i) => i);
      for (const gi of cands) if (gi < given.length && !used.has(gi) && match(given[gi], it.accepted)[0]) { hit = gi; break; }
      if (hit !== null) used.add(hit); marks.push(hit !== null); });
    const leftReq = marks.map((ok, k) => ok ? null : k).filter(k => k !== null);
    const refs = leftReq.flatMap(k => [q.items[k].text, ...(q.items[k].accepted || [])]);
    const leftAns = given.filter((g, gi) => !used.has(gi) && plausible(g, refs, q.explanation));
    const ck = q.id + "|" + leftAns.map(norm).join("|") + "|" + leftReq.join(",");
    if (ck in JC) JC[ck].forEach(k => marks[k] = true);
    else if (leftReq.length && leftAns.length && !q.ordered && DB.settings.ai_judge && canAI()) {
      try { const r = await aiJSON(`STRICT exam checker for an enumeration question. For each REQUIRED item, say whether one of the student's entries states the same idea (own words/synonyms OK; vague, partial or different ideas are NOT). Each student entry can match at most one required item.\nQuestion: ${q.prompt}\nREQUIRED (unmatched): ${JSON.stringify(Object.fromEntries(leftReq.map(k => [k, q.items[k].text])))}\nSTUDENT entries: ${JSON.stringify(leftAns)}\nReturn {"matched": [REQUIRED keys that are correctly stated]}`,
          {type: "OBJECT", properties: {matched: {type: "ARRAY", items: {type: "INTEGER"}}}, required: ["matched"]});
        const ok = (r.matched || []).map(Number).filter(k => leftReq.includes(k)).slice(0, leftAns.length); JC[ck] = ok; ok.forEach(k => marks[k] = true); } catch {}
    }
    const got = marks.filter(Boolean).length;
    return {correct: got === q.items.length, score: Math.round(100 * got / q.items.length), marks, detail: `${got}/${q.items.length} items correct` + (q.ordered ? " (order matters)" : "")};
  }
  if (t === "essay") {
    if (norm(answer).split(" ").length < 8) return {correct: false, score: 0, detail: "Too short. Explain fully in your own words."};
    if (!canAI()) throw new HttpErr("Essay grading needs internet and your Gemini key.", 502);
    const r = await aiJSON(`Grade this exam essay STRICTLY against the rubric. Each rubric point must be clearly and correctly stated (own words are fine). Wrong statements reduce the score.\nQuestion: ${q.prompt}\nRubric key points: ${JSON.stringify(q.rubric)}\nReference: ${q.explanation || ""}\nStudent essay: ${answer}\nReturn JSON: score 0-100, covered and missing rubric points (copy them), and 1-3 sentences of feedback.`,
      {type: "OBJECT", required: ["score", "covered", "missing", "feedback"], properties: {score: {type: "INTEGER"}, covered: ARR(STR), missing: ARR(STR), feedback: STR}}, false);
    const score = clamp(parseInt(r.score) || 0, 0, 100); const ok = score >= 80 && (r.missing || []).length <= (q.rubric.length >= 5 ? 1 : 0);
    return {correct: ok, score, covered: r.covered || [], missing: r.missing || [], detail: r.feedback || ""};
  }
  return {correct: false, score: 0};
}
function reveal(q) { const t = q.type;
  if (t === "mcq" || t === "true_false") return {correct_index: q.correct_index, text: q.choices[q.correct_index]};
  if (t === "identification" || t === "fill_blank") return {text: q.answer, accepted: q.accepted.slice(1, 4)};
  if (t === "enumeration") return {items: q.items.map(i => i.text), ordered: !!q.ordered};
  return {rubric: q.rubric}; }

/* ------------------------------------------------------------ rewards */
const RANKS = ["Raw", "Rare", "Medium Rare", "Medium", "Medium Well", "Well Done", "Seared", "Flame-Grilled", "Fully Cooked", "Michelin Star", "Master Chef", "Legendary Chef"];
const BADGES = {first_bite: ["First Bite", "Answer your first question correctly", "🍳"], on_fire: ["On Fire", "Reach a 10-answer combo", "🔥"], inferno: ["Inferno", "Reach a 25-answer combo", "🌋"],
  fully_cooked: ["Fully Cooked", "Reach a 50-answer combo", "👨‍🍳"], well_done: ["Well Done", "Pass your first Mastery Exam (95%+)", "🥩"], chefs_kiss: ["Chef's Kiss", "Pass a Mastery Exam on the first try", "💋"],
  simmer3: ["3-Day Simmer", "Study 3 days in a row", "🍲"], roast7: ["Week-Long Roast", "Study 7 days in a row", "🍗"], slow30: ["Slow-Cooked", "Study 30 days in a row", "🏆"],
  century: ["Century", "Answer 100 questions", "💯"], wordsmith: ["Wordsmith", "Score 95+ on an essay", "✍️"], never_forget: ["Never Forget", "Get 10 spaced reviews right", "🧠"],
  night_owl: ["Night Owl", "Study after 11 PM", "🦉"], xp5k: ["Hot Kitchen", "Earn 5,000 XP", "⭐"], triple: ["Triple Course", "Master 3 modules", "🍽️"]};
function levelOf(xp) { let l = 1, need_ = 150, acc = 0; while (xp >= acc + need_) { acc += need_; l++; need_ = 150 + (l - 1) * 100; } return [l, xp - acc, need_]; }
const dayStr = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function profileView() {
  const p = DB.profile; const [lvl, into, nd] = levelOf(p.xp); const td = dayStr(new Date()); const yd = dayStr(new Date(Date.now() - 864e5));
  return {xp: p.xp, level: lvl, into, need: nd, rank: RANKS[Math.min(lvl - 1, RANKS.length - 1)], combo: p.combo, best_combo: p.best_combo,
    day_streak: [td, yd].includes(p.last_day) ? p.day_streak : 0, studied_today: p.last_day === td, best_day_streak: p.best_day_streak, answered: p.answered, correct: p.correct,
    accuracy: p.answered ? Math.round(100 * p.correct / p.answered) : 0, badges: Object.entries(BADGES).map(([k, v]) => ({id: k, name: v[0], desc: v[1], icon: v[2], earned: k in p.badges})), history: p.history};
}
function award(p, id, list) { if (!(id in p.badges)) { p.badges[id] = now(); list.push({id, name: BADGES[id][0], icon: BADGES[id][2], desc: BADGES[id][1]}); } }
function reward(ok, type, mode, essayScore = 0) {
  const p = DB.profile, nb = []; const td = dayStr(new Date()), yd = dayStr(new Date(Date.now() - 864e5));
  if (p.last_day !== td) { p.day_streak = p.last_day === yd ? p.day_streak + 1 : 1; p.last_day = td; p.best_day_streak = Math.max(p.best_day_streak, p.day_streak); }
  p.answered++; p.history[td] = (p.history[td] || 0) + 1; const before = levelOf(p.xp)[0]; let xp = 0;
  if (ok) { p.correct++; p.combo++; p.best_combo = Math.max(p.best_combo, p.combo);
    const mult = Math.min(1 + .1 * (p.combo - 1), 2.5) * (mode === "exam" ? 1.5 : ["review", "boost"].includes(mode) ? 1.2 : mode.startsWith("practice") ? .5 : 1);
    xp = Math.round(XP_BASE[type] * mult); if (mode === "review") p.reviews_correct++; award(p, "first_bite", nb); } else p.combo = 0;
  p.xp += xp;
  [[10, "on_fire"], [25, "inferno"], [50, "fully_cooked"]].forEach(([n, b]) => p.combo >= n && award(p, b, nb));
  [[3, "simmer3"], [7, "roast7"], [30, "slow30"]].forEach(([n, b]) => p.day_streak >= n && award(p, b, nb));
  if (p.answered >= 100) award(p, "century", nb); if (p.reviews_correct >= 10) award(p, "never_forget", nb); if (type === "essay" && essayScore >= 95) award(p, "wordsmith", nb);
  const h = new Date().getHours(); if (h >= 23 || h < 4) award(p, "night_owl", nb); if (p.xp >= 5000) award(p, "xp5k", nb);
  return {xp, combo: p.combo, badges: nb, level_up: levelOf(p.xp)[0] > before};
}

/* ------------------------------------------------------------ sessions */
const S = () => DB.sessions;
function newSession(fields) { const id = uid(); S()[id] = {id, cur: null, done: false, right: 0, wrong: 0, wrong_ids: [], xp: 0, step: 0, ...fields, total: fields.queue.length}; save(); return id; }
function tidy() { for (const [k, s] of Object.entries(S())) if (s.done) delete S()[k]; }
function startSession(mid, mode) {
  const m = mid ? DB.modules[mid] : null;
  const old = activeSession(mid, mode);
  if (old) { if (mode === "learn" && m) { const ok = new Set(activeQs(m).filter(x => m.progress_q[x.id].streak < need()).map(x => x.id)); old.queue = old.queue.filter(x => ok.has(x[1])); }
    if (old.queue.length) { const r = nextQuestion(old.id); r.resumed = true; return r; } old.done = true; }
  for (const s of Object.values(S())) if (!s.done && s.module_id === mid && s.mode !== "exam" && mode === "exam") s.done = true;
  tidy(); let q;
  if (mode === "practice" || mode === "practice_all") {
    if (!m || m.status !== "ready") throw new Blocked("This module isn't ready yet."); if (!isUnlocked(m)) throw new Blocked("LOCKED. Pass the previous module's Mastery Exam (95%+) first.");
    q = shuffle((mode === "practice_all" ? m.questions : activeQs(m)).map(x => [mid, x.id]));
  } else if (mode === "review") {
    const items = dueReviews(m ? m.deck_id : null); if (!items.length) throw new Blocked("No reviews due right now. Come back later!"); q = shuffle(items);
  } else {
    if (!m || m.status !== "ready") throw new Blocked("This module isn't ready yet.");
    if (!isUnlocked(m)) throw new Blocked("LOCKED. Pass the previous module's Mastery Exam (95%+) first.");
    const due = dueReviews(m.deck_id); if (due.length && !m.mastered) throw new Blocked(`Retention check first! You have ${due.length} due review(s) from mastered modules. Clear them to continue.`);
    if (m.mastered) throw new Blocked("Already mastered. Use 🔁 Practice again.");
    const prog = m.progress_q;
    if (mode === "learn") { q = activeQs(m).filter(x => prog[x.id].streak < need()).map(x => [mid, x.id]); if (!q.length) throw new Blocked("Every question is learned. Take the Mastery Exam!"); shuffle(q); q.sort((a, b) => prog[a[1]].streak - prog[b[1]].streak); }
    else if (mode === "exam") { if (activeQs(m).some(x => prog[x.id].streak < need())) throw new Blocked("Exam locked. Learn every question first."); q = shuffle(activeQs(m).map(x => [mid, x.id])); }
    else throw new Blocked("bad mode");
  }
  return nextQuestion(newSession({mode, module_id: mid, queue: q}));
}
function startBoost(did) {
  const old = Object.values(S()).find(s => !s.done && s.mode === "boost" && s.deck_id === did && s.queue.length); if (old) { const r = nextQuestion(old.id); r.resumed = true; return r; }
  const ex = examTs(did); const at = ex && ex > now() ? ex : now(); const pool = [];
  for (const mid of DB.decks[did].order) { const m = DB.modules[mid]; if (m.status !== "ready" || !isUnlocked(m)) continue;
    for (const q of activeQs(m)) { const p = m.progress_q[q.id]; if (p.lr || p.streak > 0 || m.mastered) pool.push([retr(p, at), Math.random(), mid, q.id]); } }
  if (!pool.length) throw new Blocked("Nothing to boost yet. Start learning a module first.");
  pool.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return nextQuestion(newSession({mode: "boost", module_id: null, deck_id: did, queue: shuffle(pool.slice(0, 15).map(x => [x[2], x[3]]))}));
}
const getQ = (mid, qid) => { const m = DB.modules[mid]; return [m, m.questions.find(x => x.id === qid)]; };
function nextQuestion(sid) {
  const s = S()[sid]; if (!s.queue.length) return finish(s);
  const [mid, qid] = s.queue[0]; const [m, q] = getQ(mid, qid); let choices = null, cmap = null;
  if (q.type === "mcq") { cmap = shuffle([...q.choices.keys()]); choices = cmap.map(i => q.choices[i]); } else if (q.type === "true_false") { cmap = [0, 1]; choices = ["True", "False"]; }
  s.cur = {mid, qid, cmap}; save();
  const p = m.progress_q[qid];
  return {session: sid, mode: s.mode, done: false, module_title: m.title,
    question: {id: qid, type: q.type, type_label: TYPE_LABEL[q.type], prompt: q.prompt, choices, n_items: (q.items || []).length, ordered: !!q.ordered,
      visual: q.visual_ref ? {ref: q.visual_ref, module_id: mid, kind: m.kind, box: q.visual_box} : null, streak: p.streak, need: need(), difficulty: q.difficulty || 2},
    stats: {remaining: new Set(s.queue.map(x => x[1])).size, total: s.total, right: s.right, wrong: s.wrong, mastery: s.module_id && s.mode === "learn" ? Math.round(learnRatio(DB.modules[s.module_id]) * 99) : null},
    profile: profileView()};
}
async function answer(sid, qid, ans) {
  const s = S()[sid]; if (!s || s.done) throw new Blocked("Session expired. Start again."); const cur = s.cur; if (!cur || cur.qid !== qid) throw new Blocked("That's not the current question.");
  const [m, q] = getQ(cur.mid, qid); const res = await grade(q, ans, cur.cmap);
  if (res.chosen != null && cur.cmap) res.correct_shown = cur.cmap.indexOf(q.correct_index);
  const p = m.progress_q[qid]; const ok = res.correct; updateMemory(p, ok); p.last = now(); p[ok ? "correct" : "wrong"]++;
  s.queue.shift(); s.step++;
  const back = (n) => s.queue.splice(Math.min(n, s.queue.length), 0, [cur.mid, qid]);
  if (s.mode === "learn") { if (ok) { p.streak++; if (p.streak < need()) back(5 + Math.floor(Math.random() * 4) + p.streak * 2); } else { p.streak = Math.max(0, p.streak - penalty()); back(3); } }
  else if (s.mode === "review") { if (ok) { p.box = Math.min(p.box + 1, 6); schedule(p, m.deck_id); } else { p.box = 0; p.due = now() + REVIEW0; back(3); } }
  else if (s.mode === "exam") { if (!ok) s.wrong_ids.push(qid); }
  else if (s.mode === "boost") { if (!ok) back(3); else if (m.mastered) schedule(p, m.deck_id); }
  else if (!ok) back(3);   // practice
  if (ok) s.right++; else s.wrong++;
  const r = reward(ok, q.type, s.mode, res.score || 0); s.xp += r.xp; save();
  return {result: {...res, reveal: reveal(q), explanation: q.explanation || "", streak: p.streak, need: need(), learned: s.mode === "learn" && ok && p.streak >= need()}, reward: r, profile: profileView()};
}
function master(m, out, firstTry, wrongIds = []) {
  m.mastered = true; m.mastered_at = now(); const t = now();
  for (const q of activeQs(m)) { const p = m.progress_q[q.id]; p.box = 0; if (p.lr) schedule(p, m.deck_id); else p.due = t + DAY; }
  for (const id of wrongIds) if (m.progress_q[id]) Object.assign(m.progress_q[id], {box: 0, due: t + REVIEW0});
  const p = DB.profile; const bonus = 500 + (firstTry ? 250 : 0); p.xp += bonus; out.bonus = bonus; award(p, "well_done", out.badges);
  if (firstTry) award(p, "chefs_kiss", out.badges); if (Object.values(DB.modules).filter(x => x.mastered).length >= 3) award(p, "triple", out.badges);
}
function finishExam(s, abandoned = false) {
  const m = DB.modules[s.module_id]; const score = s.total ? Math.floor(100 * s.right / s.total) : 0;
  const passed = !s.queue.length && !abandoned && score >= PASS_PCT; const firstTry = !(m.exams || []).length;
  (m.exams = m.exams || []).push({t: now(), right: s.right, total: s.total, score, passed, abandoned});
  const out = {passed, bonus: 0, badges: [], score};
  if (passed) master(m, out, firstTry, s.wrong_ids); else for (const id of s.wrong_ids) m.progress_q[id].streak = penalty() > 1 ? 0 : Math.max(0, need() - 1);
  s.done = true; save(); return out;
}
function finish(s) {
  const out = {session: s.id, mode: s.mode, done: true, right: s.right, wrong: s.wrong, total: s.total, xp: s.xp};
  if (s.mode === "exam" && !s.done) { const r = finishExam(s); Object.assign(out, r, {wrong_count: s.wrong_ids.length, pass_pct: PASS_PCT}); }
  s.done = true; const m = s.module_id ? DB.modules[s.module_id] : null;
  if (m) { out.module = moduleSummary(m); const o = DB.decks[m.deck_id].order; const i = o.indexOf(m.id); if (m.mastered && i + 1 < o.length) out.next_module = moduleSummary(DB.modules[o[i + 1]]); }
  if (s.deck_id) out.forecast = forecast(s.deck_id);
  out.profile = profileView(); save(); return out;
}
const examActive = mid => Object.values(S()).some(s => s.mode === "exam" && !s.done && s.module_id === mid);
const sessionsView = () => Object.values(S()).filter(s => !s.done && s.queue.length).map(s => { const m = s.module_id ? DB.modules[s.module_id] : null;
  return {id: s.id, module_id: s.module_id, deck_id: s.deck_id, mode: s.mode, title: m ? m.title : (s.mode === "boost" ? "Exam Boost" : "Spaced review"), left: new Set(s.queue.map(x => x[1])).size}; });

/* ------------------------------------------------------------ router (same API as the desktop server) */
async function handle(method, path, body) {
  const parts = path.replace(/^\/?api\//, "").split("/").filter(Boolean);
  const P = (...x) => parts.length === x.length && x.every((v, i) => v === "*" || v === parts[i]);
  if (parts[0] === "sync") return window.CookedSync.route(method, parts, body);
  if (P("ping")) return {ok: true};
  if (method === "GET" && P("state")) return {decks: Object.keys(DB.decks).sort((a, b) => DB.decks[a].created - DB.decks[b].created).map(deckView), profile: profileView(),
    settings: {has_key: !!DB.settings.api_key, key_hint: DB.settings.api_key ? "..." + DB.settings.api_key.slice(-4) : "", model: DB.settings.model, ai_judge: DB.settings.ai_judge,
      provider: "gemini", strict: DB.settings.strict, gemini_speed: DB.settings.gemini_speed, mobile: true}, due_total: dueReviews().length, active: sessionsView(), sync: window.CookedSync?.view()};
  if (method === "POST" && P("settings")) {
    if (body.api_key && body.api_key.trim()) {
      const k = body.api_key.replace(/\s+/g, "").replace(/^["']|["']$/g, "").replace(/^.*key=/, "");
      if (k.length < 30 || /…|\*|\.\.\./.test(k)) throw new HttpErr(`That's only part of a key (${k.length} characters). On aistudio.google.com/apikey tap your key, then "Copy key", and paste the whole thing.`, 400);
      DB.settings.api_key = k; GC.names = null; GC.good = null; GC.bad = {}; }
    for (const k of ["model", "ai_judge", "strict", "gemini_speed"]) if (k in body) DB.settings[k] = body[k];
    for (const m of Object.values(DB.modules)) if (m.status === "error" && /API key/.test(m.error)) { m.status = "queued"; m.error = ""; queueScan(m.id); }
    save(true); return {ok: true};
  }
  if (P("models")) { if (!DB.settings.api_key) throw new HttpErr("Add your API key first"); return {models: await listModels(), auto: await pickCandidates("auto")}; }
  if (P("test")) { const r = await generateJSON([{text: 'Return {"ok": true}'}], null, null, 0, null, 40, true); return {ok: !!r.ok, models: [GC.good || DB.settings.model]}; }
  if (parts[0] === "decks") {
    if (method === "POST" && parts.length === 1) return {id: createDeck(body.name)};
    const did = parts[1]; if (!DB.decks[did]) throw new HttpErr("Not found", 404);
    if (method === "GET" && parts.length === 2) return deckView(did);
    if (method === "DELETE" && parts.length === 2) { for (const mid of DB.decks[did].order) { delete DB.modules[mid]; fdelPrefix(mid + "/"); } delete DB.decks[did]; save(true); return {ok: true}; }
    const act = parts[2];
    if (act === "upload") return {id: await addModule(did, body.filename.replace(/[\\/:*?"<>|]/g, "_"), body.data)};
    if (act === "import") { const j = typeof body.json === "string" ? parseJSON(body.json) : body.json;
      if (j && j.cooked_subject) { let n = 0; for (const mod of j.modules || []) n += importModule(did, mod).count; return {id: did, count: n}; }
      return importModule(did, j, body.source_name, body.source_data); }
    if (act === "export") return exportDeck(did);
    if (act === "order") { const o = body.order; const d = DB.decks[did]; if ([...o].sort().join() !== [...d.order].sort().join()) throw new HttpErr("bad order");
      const mp = d.order.filter(x => DB.modules[x].mastered); if (o.slice(0, mp.length).join() !== mp.join()) throw new HttpErr("Mastered modules stay in place.", 403); d.order = o; save(); return {ok: true}; }
    if (act === "rename") { DB.decks[did].name = (body.name || "").trim() || DB.decks[did].name; save(); return {ok: true}; }
    if (act === "exam") { setExamDate(did, (body.date || "").trim()); return deckView(did); }
    if (act === "boost") return startBoost(did);
  }
  if (parts[0] === "modules") {
    const mid = parts[1]; const m = DB.modules[mid]; if (!m) throw new HttpErr("Not found", 404); const act = parts[2];
    if (act === "notes") { if (examActive(mid)) throw new Blocked("Notes are locked during the Mastery Exam. No peeking!"); if (!isUnlocked(m)) throw new Blocked("Locked. Master the previous module first.");
      return {title: m.title, notes: m.notes, kind: m.kind, in_scope: [...scopeInfo(m)[0]], summary: moduleSummary(m)}; }
    if (act === "scope") { if (method === "POST") setScope(mid, body.depth, body.topics, body.detail); return scopeView(mid); }
    if (act === "rescan") { if (m.mastered) throw new HttpErr("Already mastered.", 403); if (m.imported) throw new HttpErr("Imported modules can't be rescanned.", 403);
      if (m._nosrc) throw new HttpErr("This module was scanned on your other device. Rescan it there.", 403);
      await fdelPrefix(mid + "/media/"); Object.assign(m, {status: "queued", error: "", progress: "Waiting in line...", questions: [], progress_q: {}, notes: null}); save(); queueScan(mid); return {ok: true}; }
    if (method === "DELETE" && parts.length === 2) { const d = DB.decks[m.deck_id]; d.order = d.order.filter(x => x !== mid); delete DB.modules[mid]; fdelPrefix(mid + "/"); save(true); return {ok: true}; }
    if (act === "start") return startSession(mid, body.mode || "learn");
  }
  if (P("review")) return startSession(body.module_id || null, "review");
  if (parts[0] === "session") {
    const sid = parts[1], act = parts[2];
    if (act === "answer") return await answer(sid, body.qid, body.answer);
    if (act === "next") { if (!S()[sid]) throw new Blocked("Session expired."); return nextQuestion(sid); }
    if (act === "quit") { const s = S()[sid]; if (s && s.mode === "exam" && !s.done) { finishExam(s, true); delete S()[sid]; return {ok: true, failed_exam: true}; } return {ok: true, paused: true}; }
  }
  throw new HttpErr("unknown endpoint", 404);
}
async function assetURL(mid, name) { const b = await fget(name === "source" ? `${mid}/source` : `${mid}/media/${name}`); return b ? URL.createObjectURL(b) : ""; }

load();
for (const m of Object.values(DB.modules)) if (m.status === "queued" || m.status === "scanning") { m.status = "queued"; SCANQ.push(m.id); }
setTimeout(runScans, 500);
window.LocalAPI = {handle, assetURL, _db: () => DB, _x: {db: () => DB, save, fget, fput, fdelPrefix, HttpErr, IMG_MIME}};
})();
