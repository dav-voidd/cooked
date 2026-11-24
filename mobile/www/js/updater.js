/* Cooked self-updates (phone).
   - App code (everything in www/) updates by itself: the new bundle downloads quietly and applies the next time
     the app opens (or right away when you're not in a quiz).
   - When a release needs a new APK (native changes), a banner offers the download instead. */
(function () {
  const REPO = "dav-voidd/cooked";
  const cap = n => window.Capacitor && (Capacitor.Plugins?.[n] || (Capacitor.registerPlugin && Capacitor.registerPlugin(n)));
  const UP = cap("CapacitorUpdater"), APP = cap("App");
  const LS = "cooked-update";
  let local = {build: 0, native: 0};

  const busyStudying = () => location.hash.startsWith("#/quiz");
  function banner(html, onTap) {
    if (document.getElementById("updBanner")) return;
    const b = document.createElement("div"); b.id = "updBanner"; b.className = "updBanner"; b.innerHTML = html;
    b.onclick = e => { if (e.target.closest(".x")) { b.remove(); return; } onTap && onTap(); };
    document.body.appendChild(b);
  }

  async function check(manual) {
    if (!UP) { if (manual) window.toast?.("Updates work in the installed app."); return; }
    let rel;
    try { rel = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {cache: "no-store"}).then(r => r.ok ? r.json() : null); } catch { rel = null; }
    if (!rel) { if (manual) window.toast?.("Can't check for updates right now (offline?)."); return; }
    const build = +((rel.tag_name || "").match(/\d+/) || [0])[0];
    const native = +(((rel.body || "").match(/native:(\d+)/) || [0, 0])[1]);
    if (build <= local.build) { if (manual) window.toast?.(`You're on the latest version (build ${local.build}).`); return; }
    const apk = (rel.assets || []).find(a => a.name === "Cooked.apk"), zip = (rel.assets || []).find(a => a.name === "www.zip");
    if (native > local.native || !zip) {           // needs a new APK
      if (apk) banner(`🆕 <b>New Cooked version</b> (build ${build}). Tap to download and install.<span class="x">✕</span>`,
        () => { const br = cap("Browser"); br ? br.open({url: apk.browser_download_url}) : window.open(apk.browser_download_url, "_blank"); });
      return;
    }
    const st = JSON.parse(localStorage.getItem(LS) || "{}");
    if (st.build === build && st.id) { apply(st.id, build); return; }   // already downloaded earlier
    try {
      if (manual) window.toast?.("Downloading update...");
      const info = await UP.download({url: zip.browser_download_url, version: String(build)});
      localStorage.setItem(LS, JSON.stringify({build, id: info.id}));
      apply(info.id, build);
    } catch (e) { console.warn("update failed", e); if (manual) window.toast?.("Update download failed. Try again later."); }
  }
  async function apply(id, build) {
    await UP.next({id});                                       // used automatically next launch
    if (!busyStudying()) {
      banner(`✨ <b>Update ready</b> (build ${build}). Tap to restart Cooked now.<span class="x">✕</span>`, () => UP.set({id}));
    }
  }

  async function start() {
    try { local = await fetch("version.json", {cache: "no-store"}).then(r => r.json()); } catch {}
    if (!UP) return;
    try { await UP.notifyAppReady(); } catch {}
    setTimeout(() => check(false), 4000);
    setInterval(() => { if (!document.hidden) check(false); }, 6 * 3600 * 1000);
    APP?.addListener?.("resume", () => check(false));
  }
  window.CookedUpdate = {check: () => check(true), version: () => local};
  start();
})();
