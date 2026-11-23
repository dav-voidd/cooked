/* Cooked cloud sync (phone side): Login with Google via the hosted login page + Firestore REST.
   Same layout and rules as desktop/sync.py so the PC and phone stay in step. */
const FIREBASE = {apiKey: "__FIREBASE_API_KEY__", projectId: "__FIREBASE_PROJECT_ID__"};
const LOGIN_PAGE = "https://dav-voidd.github.io/cooked/login.html";
const X = window.LocalAPI._x;
const SETTINGS_KEYS = ["api_key", "strict", "ai_judge"];
const SY = {busy: false, error: "", tok: null, exp: 0};
const configured = () => !FIREBASE.apiKey.startsWith("__");
const acct = () => (X.db()._sync = X.db()._sync || {});
const signedIn = () => !!acct().rt;
const syncView = () => ({configured: configured(), signed_in: signedIn(), email: acct().email || "", busy: SY.busy, error: SY.error, at: acct().at || 0});
const cap = n => window.Capacitor && (Capacitor.Plugins?.[n] || (Capacitor.registerPlugin && Capacitor.registerPlugin(n)));

class SyncErr extends Error { constructor(m, code = 0) { super(m); this.code = code; } }
async function shttp(method, url, body, opts = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = opts.form ? "application/x-www-form-urlencoded" : "application/json";
  if (opts.token) headers.Authorization = "Bearer " + opts.token;
  let r;
  try { r = await fetch(url, {method, headers, body: body === undefined ? undefined : opts.form ? new URLSearchParams(body).toString() : JSON.stringify(body)}); }
  catch { throw new SyncErr("Offline. Will sync when you're back online.", -1); }
  const t = await r.text(); let j = {}; try { j = JSON.parse(t || "{}"); } catch {}
  if (!r.ok) { const e = j.error; throw new SyncErr(`${r.status}: ${(typeof e === "object" ? e.message : e) || t}`.slice(0, 200), r.status); }
  return j;
}
async function token() {
  if (SY.tok && Date.now() / 1000 < SY.exp - 120) return SY.tok;
  let r;
  try { r = await shttp("POST", "https://securetoken.googleapis.com/v1/token?key=" + FIREBASE.apiKey, {grant_type: "refresh_token", refresh_token: acct().rt}, {form: true}); }
  catch (e) { if ([400, 401, 403].includes(e.code)) { signOut(); throw new SyncErr("Your Google sign-in expired. Sign in again in Settings."); } throw e; }
  acct().rt = r.refresh_token || acct().rt; SY.tok = r.id_token; SY.exp = Date.now() / 1000 + +(r.expires_in || 3600);
  return SY.tok;
}
const base = () => `https://firestore.googleapis.com/v1/projects/${FIREBASE.projectId}/databases/(default)/documents/users/${acct().uid}`;
async function fsList(coll) {
  const out = {}; let page = null;
  do { const r = await shttp("GET", `${base()}/${coll}?pageSize=300&mask.fieldPaths=hash&mask.fieldPaths=deleted${page ? "&pageToken=" + encodeURIComponent(page) : ""}`, undefined, {token: await token()});
    for (const d of r.documents || []) { const f = d.fields || {}; out[d.name.split("/").pop()] = {hash: f.hash?.stringValue || "", deleted: !!f.deleted?.booleanValue}; }
    page = r.nextPageToken; } while (page);
  return out;
}
async function fsGet(coll, key) {
  const f = (await shttp("GET", `${base()}/${coll}/${encodeURIComponent(key)}`, undefined, {token: await token()})).fields || {};
  return f.data ? JSON.parse(f.data.stringValue) : null;
}
async function fsPut(coll, key, data, hash, deleted = false) {
  const fields = {hash: {stringValue: hash}, deleted: {booleanValue: deleted}, at: {integerValue: String(Date.now())}};
  if (!deleted) { const s = JSON.stringify(data);
    if (new Blob([s]).size > 950000) throw new SyncErr(`"${data.title || data.name || key}" is too big to sync (over 1 MB).`);
    fields.data = {stringValue: s}; }
  await shttp("PATCH", `${base()}/${coll}/${encodeURIComponent(key)}`, {fields}, {token: await token()});
}
const stable = o => Array.isArray(o) ? "[" + o.map(stable).join(",") + "]" : o && typeof o === "object" ? "{" + Object.keys(o).sort().map(k => JSON.stringify(k) + ":" + stable(o[k])).join(",") + "}" : JSON.stringify(o ?? null);
async function hashOf(o) { const b = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(stable(o))); return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join(""); }
const clone = o => JSON.parse(JSON.stringify(o));

function localItems() {
  const items = {"state/profile": X.db().profile, "state/settings": Object.fromEntries(SETTINGS_KEYS.map(k => [k, X.db().settings[k] ?? null]))};
  for (const [did, d] of Object.entries(X.db().decks)) items["decks/" + did] = d;
  for (const [mid, m] of Object.entries(X.db().modules)) if (m.status === "ready") items["modules/" + mid] = Object.fromEntries(Object.entries(m).filter(([k]) => !k.startsWith("_")));
  return items;
}
const ts = p => Math.max(p.lr || 0, p.last || 0);
function merge(kind, a, b) {
  if (kind === "profile") { const o = {...a};
    for (const k of ["xp", "best_combo", "best_day_streak", "answered", "correct", "reviews_correct"]) o[k] = Math.max(a[k] || 0, b[k] || 0);
    if ((b.last_day || "") > (a.last_day || "")) { o.last_day = b.last_day; o.day_streak = b.day_streak || 0; }
    o.badges = {...(b.badges || {}), ...(a.badges || {})}; const h = {...(a.history || {})};
    for (const [d, n] of Object.entries(b.history || {})) h[d] = Math.max(h[d] || 0, n); o.history = h; return o; }
  if (kind === "decks") return {...a, order: [...(a.order || []), ...(b.order || []).filter(x => !(a.order || []).includes(x))], exam_date: a.exam_date || b.exam_date};
  if (kind === "modules") {
    const ids = x => (x.questions || []).map(q => q.id).sort().join();
    if (ids(a) !== ids(b)) return clone((a.questions || []).length >= (b.questions || []).length ? a : b);
    const o = clone(a); o.progress_q = o.progress_q || {};
    for (const [qid, p] of Object.entries(b.progress_q || {})) if (!o.progress_q[qid] || ts(p) > ts(o.progress_q[qid])) o.progress_q[qid] = p;
    o.mastered = !!(a.mastered || b.mastered); o.mastered_at = Math.min(...[a.mastered_at, b.mastered_at].filter(Boolean)) || null;
    if (!isFinite(o.mastered_at)) o.mastered_at = null;
    const seen = new Set(); o.exams = [...(a.exams || []), ...(b.exams || [])].sort((x, y) => (x.at || 0) - (y.at || 0)).filter(e => !seen.has(e.at) && seen.add(e.at));
    return o; }
  return Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map(k => [k, a[k] !== null && a[k] !== undefined && a[k] !== "" ? a[k] : b[k]]));
}
async function applyItem(key, data) {
  const [coll, k] = [key.slice(0, key.indexOf("/")), key.slice(key.indexOf("/") + 1)];
  if (coll === "state") { if (k === "profile") X.db().profile = data; else for (const x of SETTINGS_KEYS) if (x in data && data[x] !== null && data[x] !== "") X.db().settings[x] = data[x]; }
  else if (coll === "decks") X.db().decks[k] = data;
  else { const old = X.db().modules[k] || {}; const keep = Object.fromEntries(Object.entries(old).filter(([x]) => x.startsWith("_")));
    if (!X.db().modules[k] && !(await X.fget(`${k}/source`))) keep._nosrc = true;
    X.db().modules[k] = {...data, ...keep}; }
}
function removeItem(key) {
  const [coll, k] = [key.slice(0, key.indexOf("/")), key.slice(key.indexOf("/") + 1)];
  if (coll === "decks" && X.db().decks[k]) { for (const mid of X.db().decks[k].order || []) { delete X.db().modules[mid]; X.fdelPrefix(mid + "/"); } delete X.db().decks[k]; }
  else if (coll === "modules" && X.db().modules[k]) { const d = X.db().decks[X.db().modules[k].deck_id]; if (d) d.order = d.order.filter(x => x !== k); delete X.db().modules[k]; X.fdelPrefix(k + "/"); }
}
function fixup() {
  for (const [did, d] of Object.entries(X.db().decks)) { d.order = (d.order || []).filter(m => X.db().modules[m]);
    for (const [mid, m] of Object.entries(X.db().modules)) if (m.deck_id === did && !d.order.includes(mid)) d.order.push(mid); }
  for (const [mid, m] of Object.entries(X.db().modules)) if (!X.db().decks[m.deck_id]) delete X.db().modules[mid];
}
const b64 = blob => new Promise(res => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.readAsDataURL(blob); });
async function syncMedia(pushed, pulled) {
  const done = new Set(acct().media || []);
  for (const mid of pushed) for (const v of X.db().modules[mid]?.visuals || []) {
    const name = v.ref.split(":")[1], key = `${mid}__${name}`; if (done.has(key)) continue;
    const blob = await X.fget(`${mid}/media/${name}`); if (!blob || blob.size > 700000) continue;
    await fsPut("media", key, {b64: await b64(blob)}, "1"); done.add(key); }
  for (const mid of pulled) for (const v of X.db().modules[mid]?.visuals || []) {
    const name = v.ref.split(":")[1]; if (await X.fget(`${mid}/media/${name}`)) continue;
    let d = null; try { d = await fsGet("media", `${mid}__${name}`); } catch { continue; }
    if (!d) continue; const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
    await X.fput(`${mid}/media/${name}`, new Blob([Uint8Array.from(atob(d.b64), c => c.charCodeAt(0))], {type: X.IMG_MIME[ext] || "image/png"})); done.add(`${mid}__${name}`); }
  acct().media = [...done];
}

async function runSync() {
  if (!configured() || !signedIn() || SY.busy || navigator.onLine === false) return syncView();
  SY.busy = true; SY.error = "";
  try {
    const remote = {};
    for (const coll of ["state", "decks", "modules"]) for (const [k, v] of Object.entries(await fsList(coll))) remote[`${coll}/${k}`] = v;
    const snap = clone(localItems()), known = acct().items = acct().items || {};
    const pushes = [], pulls = [], deletes = [];
    for (const key of [...new Set([...Object.keys(snap), ...Object.keys(remote), ...Object.keys(known)])].sort()) {
      const L = key in snap ? await hashOf(snap[key]) : null, R = remote[key], rh = R?.hash, k = known[key] || {};
      const lchg = L !== (k.l ?? undefined), rchg = rh !== (k.r ?? undefined), hadK = !!known[key];
      if (R && R.deleted) { if (L && !hadK) pushes.push(key); else if (L) deletes.push(key); known[key] = {r: rh, l: null}; }
      else if (L === null) {
        if (R && hadK && !rchg) { await fsPut(key.split("/")[0], key.slice(key.indexOf("/") + 1), null, "x" + Math.random().toString(16).slice(2, 10), true); delete known[key]; }
        else if (R) pulls.push([key, null]); else delete known[key]; }
      else if (!R) pushes.push(key);
      else if (lchg && rchg) pulls.push([key, "merge"]);
      else if (rchg) pulls.push([key, null]);
      else if (lchg) pushes.push(key);
    }
    const fetched = {};
    for (const [key] of pulls) fetched[key] = await fsGet(key.split("/")[0], key.slice(key.indexOf("/") + 1));
    const merged = [], pulledMods = [], pushedMods = [];
    for (const key of deletes) removeItem(key);
    pulls.sort((x, y) => (x[0].startsWith("decks") ? 0 : 1) - (y[0].startsWith("decks") ? 0 : 1));
    for (const [key, how] of pulls) { let data = fetched[key]; if (!data) continue;
      if (how === "merge") { const [c, k] = key.split("/"); data = merge(c === "state" ? k : c, snap[key], data); merged.push(key); }
      await applyItem(key, data); if (key.startsWith("modules/")) pulledMods.push(key.slice(8)); }
    fixup(); X.save();
    const after = clone(localItems());
    for (const [key] of pulls) if (key in after) known[key] = {r: remote[key].hash, l: await hashOf(after[key])};
    for (const key of [...pushes, ...merged]) { if (!(key in after)) continue;
      const h = await hashOf(after[key]); await fsPut(key.split("/")[0], key.slice(key.indexOf("/") + 1), after[key], h); known[key] = {r: h, l: h};
      if (key.startsWith("modules/")) pushedMods.push(key.slice(8)); }
    await syncMedia(pushedMods, pulledMods);
    acct().at = Date.now() / 1000;
    if (pulls.length) window.dispatchEvent(new Event("cooked-synced"));
  } catch (e) { SY.error = e.message; }
  finally { SY.busy = false; X.save(); }
  return syncView();
}

function signOut() { const a = acct(); for (const k of ["rt", "uid", "email", "items", "media", "at"]) delete a[k]; SY.tok = null; X.save(); }
async function startLogin() {
  if (!configured()) throw new X.HttpErr("Cloud sync isn't set up in this build yet.");
  const state = crypto.getRandomValues(new Uint32Array(4)).join("-"); localStorage.setItem("cooked-login-state", state);
  const url = `${LOGIN_PAGE}?to=${encodeURIComponent("cooked://auth")}&state=${state}`;
  const br = cap("Browser"); if (br) await br.open({url}); else window.open(url, "_blank");
  return {url};
}
async function finishLogin(url) {
  const q = Object.fromEntries(new URL(url.replace("cooked://", "https://x/")).searchParams);
  cap("Browser")?.close?.().catch(() => {});
  if (!q.state || q.state !== localStorage.getItem("cooked-login-state")) return;
  localStorage.removeItem("cooked-login-state");
  const a = acct(); if (a.uid && a.uid !== q.uid) a.items = {};
  Object.assign(a, {rt: q.rt, uid: q.uid, email: q.email || ""}); SY.tok = null; X.save();
  window.dispatchEvent(new CustomEvent("cooked-login", {detail: q.email}));
  await runSync();
}
cap("App")?.addListener?.("appUrlOpen", ({url}) => { if (url && url.startsWith("cooked://auth")) finishLogin(url); });
setInterval(() => { if (!document.hidden) runSync(); }, 60000);
setTimeout(runSync, 3000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) runSync(); });

async function syncRoute(method, parts) {
  if (method === "GET" && parts.length === 1) return syncView();
  if (method === "POST" && parts.length === 1) return await runSync();
  if (method === "POST" && parts[1] === "login") return await startLogin();
  if (method === "POST" && parts[1] === "logout") { signOut(); return syncView(); }
  throw new X.HttpErr("Not found", 404);
}
window.CookedSync = {route: syncRoute, view: syncView, run: runSync};
