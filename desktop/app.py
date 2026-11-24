"""Cooked - active recall that gets you exam-ready.  Run:  python app.py"""
import base64, json, mimetypes, os, re, shutil, socket, subprocess, sys, threading, time, webbrowser
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

import engine, gemini, claude_cli, sync, updater

ROOT = os.path.dirname(os.path.abspath(__file__))
FROZEN = getattr(sys, "frozen", False)
STATIC = os.path.join(getattr(sys, "_MEIPASS", ROOT), "static")
LAST_PING = [time.time()]
MAX_UPLOAD = 200 * 1024 * 1024


def j(h, obj, code=200):
    b = json.dumps(obj, ensure_ascii=False).encode()
    h.send_response(code)
    h.send_header("Content-Type", "application/json; charset=utf-8")
    h.send_header("Content-Length", str(len(b)))
    h.send_header("Cache-Control", "no-store")
    h.end_headers()
    h.wfile.write(b)


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_UPLOAD:
            raise ValueError("File too large (max 200 MB)")
        return json.loads(self.rfile.read(n) or b"{}") if n else {}

    def send_file(self, path, ctype=None):
        if not os.path.isfile(path):
            return j(self, {"error": "not found"}, 404)
        with open(path, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype or mimetypes.guess_type(path)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.route("GET")

    def do_POST(self):
        self.route("POST")

    def do_DELETE(self):
        self.route("DELETE")

    def route(self, method):
        u = urlparse(self.path)
        p = u.path
        try:
            return self._route(method, p, u)
        except engine.Blocked as e:
            j(self, {"error": str(e), "blocked": True}, 423)
        except PermissionError as e:
            j(self, {"error": str(e)}, 403)
        except (gemini.GeminiError, claude_cli.ClaudeError) as e:
            j(self, {"error": str(e)}, 502)
        except (ValueError, json.JSONDecodeError) as e:
            j(self, {"error": str(e)}, 400)
        except KeyError:
            j(self, {"error": "Not found"}, 404)
        except Exception as e:
            import traceback; traceback.print_exc()
            j(self, {"error": f"{type(e).__name__}: {e}"}, 500)

    def _route(self, method, p, u):
        d = engine.db()
        if method == "GET" and p == "/auth":
            q = {k: v[0] for k, v in parse_qs(u.query).items()}
            try:
                sync.finish_login(q)
                msg = f"Signed in as {q.get('email', '')}. Cooked is syncing now. You can close this tab."
            except Exception as e:
                msg = str(e)
            body = ("<!doctype html><meta charset=utf-8><title>Cooked</title><body style='background:#110d0b;color:#f6ede6;"
                    "font:18px system-ui;display:grid;place-items:center;height:90vh;text-align:center'><div><h1 style='color:#ff7a1a'>"
                    f"Cooked.</h1><p>{msg.replace('<', '&lt;')}</p></div>").encode()
            self.send_response(200); self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
            return
        if not p.startswith("/api/"):
            f = os.path.normpath(os.path.join(STATIC, p.lstrip("/") or "index.html"))
            if not f.startswith(STATIC):
                return j(self, {"error": "no"}, 403)
            return self.send_file(f)
        parts = p.strip("/").split("/")[1:]
        if method == "GET" and parts == ["ping"]:
            LAST_PING[0] = time.time()
            return j(self, {"ok": True})
        if method == "GET" and parts == ["state"]:
            decks = [engine.deck_view(did) for did in sorted(d["decks"], key=lambda x: d["decks"][x]["created"])]
            s = d["settings"]
            return j(self, {"decks": decks, "profile": engine.profile_view(),
                            "settings": {"has_key": bool(engine.api_key()), "model": s["model"], "ai_judge": s["ai_judge"],
                                         "provider": s.get("provider", "gemini"), "claude": claude_cli.status(),
                                         "claude_model": s.get("claude_model", "sonnet"), "strict": s.get("strict", "normal"),
                                         "gemini_speed": s.get("gemini_speed", "balanced"),
                                         "key_hint": ("..." + engine.api_key()[-4:]) if engine.api_key() else ""},
                            "due_total": len(engine.due_reviews()), "active": engine.sessions_view(), "sync": sync.view(), "update": updater.view()})
        if method == "POST" and parts == ["settings"]:
            b = self.body()
            if "api_key" in b and b["api_key"].strip():
                d["settings"]["api_key"] = b["api_key"].strip()
            for k in ("model", "ai_judge", "provider", "claude_model", "strict", "gemini_speed"):
                if k in b:
                    d["settings"][k] = b[k]
            engine.save()
            # retry modules that failed because of a missing key
            for m in d["modules"].values():
                if m["status"] == "error" and ("API key" in m["error"] or "Claude" in m["error"]):
                    m["status"], m["error"] = "queued", ""
                    engine.SCAN_Q.put(m["id"])
            return j(self, {"ok": True})
        if parts and parts[0] == "update":
            if method == "GET":
                return j(self, updater.view())
            if parts == ["update", "check"]:
                return j(self, updater.check())
            if parts == ["update", "restart"]:
                engine.save()
                if not updater.install(relaunch=True):
                    return j(self, {"error": "No update ready yet."}, 400)
                threading.Timer(0.6, lambda: os._exit(0)).start()
                return j(self, {"ok": True})
        if parts and parts[0] == "sync":
            if method == "GET" and parts == ["sync"]:
                return j(self, sync.view())
            if method == "POST" and parts == ["sync"]:
                return j(self, sync.run())
            if method == "POST" and parts == ["sync", "login"]:
                if not sync.configured():
                    return j(self, {"error": "Cloud sync isn't set up in this build yet."}, 400)
                url = sync.login_url(self.server.server_address[1])
                webbrowser.open(url)
                return j(self, {"url": url})
            if method == "POST" and parts == ["sync", "logout"]:
                sync.sign_out()
                return j(self, sync.view())
        if method == "GET" and parts == ["models"]:
            key = engine.api_key()
            if not key:
                return j(self, {"error": "Add your API key first"}, 400)
            names = gemini.list_models(key)
            return j(self, {"models": names, "auto": gemini.pick_candidates(key, "auto")})
        if method == "POST" and parts == ["claude", "setup"]:
            claude_cli.open_setup()
            return j(self, {"ok": True})
        if method == "POST" and parts == ["claude", "test"]:
            ok = claude_cli.test()
            if ok:   # re-queue modules that failed before Claude was signed in
                for m in d["modules"].values():
                    if m["status"] == "error" and "Claude" in m["error"]:
                        m["status"], m["error"], m["progress"] = "queued", "", "Waiting in line..."
                        engine.SCAN_Q.put(m["id"])
                engine.save()
            return j(self, {"ok": ok})
        if method == "POST" and parts == ["test"]:
            if not engine.api_key():
                return j(self, {"error": "Paste your API key first."}, 400)
            r = gemini.generate_json(engine.api_key(), d["settings"]["model"], [{"text": 'Return {"ok": true}'}], timeout=40, quick=True)
            return j(self, {"ok": bool(r.get("ok")), "models": [gemini._CACHE["good"] or d["settings"]["model"]]})
        if parts[0] == "decks":
            if method == "POST" and len(parts) == 1:
                return j(self, {"id": engine.create_deck(self.body().get("name", ""))})
            did = parts[1]
            if did not in d["decks"]:
                raise KeyError(did)
            if method == "GET" and len(parts) == 2:
                return j(self, engine.deck_view(did))
            if method == "DELETE" and len(parts) == 2:
                engine.delete_deck(did)
                return j(self, {"ok": True})
            if method == "POST" and parts[2:] == ["upload"]:
                b = self.body()
                name = re.sub(r'[\\/:*?"<>|]', "_", b["filename"])
                mid = engine.add_module(did, name, base64.b64decode(b["data"]))
                return j(self, {"id": mid})
            if method == "GET" and parts[2:] == ["export"]:
                data = json.dumps(engine.export_deck(did), ensure_ascii=False).encode()
                name = re.sub(r"[^A-Za-z0-9_-]+", "_", d["decks"][did]["name"]) + ".cooked.json"
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Disposition", f'attachment; filename="{name}"')
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                return self.wfile.write(data)
            if method == "POST" and parts[2:] == ["import"]:
                b = self.body()
                if isinstance(b.get("json"), str) and '"cooked_subject"' in b["json"][:200]:
                    sub = json.loads(b["json"]); n = 0
                    for mod in sub.get("modules", []):
                        n += engine.import_module(did, mod)[1]
                    return j(self, {"id": did, "count": n})
                src = base64.b64decode(b["source_data"]) if b.get("source_data") else None
                mid, n = engine.import_module(did, b["json"], b.get("source_name"), src)
                return j(self, {"id": mid, "count": n})
            if method == "POST" and parts[2:] == ["exam"]:
                engine.set_exam_date(did, (self.body().get("date") or "").strip())
                return j(self, engine.deck_view(did))
            if method == "POST" and parts[2:] == ["boost"]:
                return j(self, engine.start_boost(did))
            if method == "POST" and parts[2:] == ["order"]:
                engine.reorder(did, self.body()["order"])
                return j(self, {"ok": True})
            if method == "POST" and parts[2:] == ["rename"]:
                d["decks"][did]["name"] = self.body().get("name", "").strip() or d["decks"][did]["name"]
                engine.save()
                return j(self, {"ok": True})
        if parts[0] == "modules":
            mid = parts[1]
            m = d["modules"][mid]
            if method == "GET" and parts[2:] == ["notes"]:
                if engine.exam_active(mid):
                    raise engine.Blocked("Notes are locked during the Mastery Exam. No peeking!")
                if not engine.is_unlocked(m):
                    raise engine.Blocked("Locked. Master the previous module first.")
                return j(self, {"title": m["title"], "notes": m["notes"], "kind": m.get("kind"),
                                "in_scope": sorted(i for i in engine.scope_info(m)[0] if i),
                                "summary": engine.module_summary(m)})
            if method == "GET" and len(parts) >= 4 and parts[2] == "asset":
                name = parts[3]
                if name == "source":
                    return self.send_file(os.path.join(engine.module_dir(m), m["source"]))
                return self.send_file(os.path.join(engine.module_dir(m), "media", os.path.basename(name)))
            if method == "GET" and parts[2:] == ["scope"]:
                return j(self, engine.scope_view(mid))
            if method == "POST" and parts[2:] == ["scope"]:
                b = self.body()
                engine.set_scope(mid, b.get("depth"), b.get("topics"), b.get("detail"))
                return j(self, engine.scope_view(mid))
            if method == "POST" and parts[2:] == ["rescan"]:
                engine.rescan(mid)
                return j(self, {"ok": True})
            if method == "DELETE" and len(parts) == 2:
                engine.delete_module(mid)
                return j(self, {"ok": True})
            if method == "POST" and parts[2:] == ["start"]:
                return j(self, engine.start_session(mid, self.body().get("mode", "learn")))
        if method == "POST" and parts == ["review"]:
            return j(self, engine.start_session(self.body().get("module_id"), "review"))
        if parts[0] == "session":
            sid = parts[1]
            if method == "POST" and parts[2:] == ["answer"]:
                b = self.body()
                return j(self, engine.answer(sid, b["qid"], b.get("answer")))
            if method == "POST" and parts[2:] == ["next"]:
                if sid not in engine.SESSIONS:
                    raise engine.Blocked("Session expired.")
                return j(self, engine.next_question(sid))
            if method == "POST" and parts[2:] == ["quit"]:
                s = engine.SESSIONS.get(sid)
                if s and s["mode"] == "exam" and not s["done"]:
                    engine._finish_exam(s, abandoned=True)
                    engine.SESSIONS.pop(sid, None)
                    return j(self, {"ok": True, "failed_exam": True})
                return j(self, {"ok": True, "paused": True})
        return j(self, {"error": "unknown endpoint"}, 404)


class _Null:
    def __enter__(self): pass
    def __exit__(self, *a): pass


def free_port(pref=5173):
    for port in [pref] + list(range(5174, 5200)):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    return 0


def get_webview():
    """Native desktop window via pywebview (installs it automatically the first time)."""
    try:
        import webview
        return webview
    except ImportError:
        if FROZEN:
            return None
        print("First run: installing the desktop window component (pywebview)... one moment.")
        try:
            subprocess.check_call([sys.executable, "-m", "pip", "install", "--quiet", "pywebview"])
            import webview
            return webview
        except Exception as e:
            print(f"Could not install pywebview ({e}). Falling back to an app window.")
            return None


def fallback_window(url):
    """Edge/Chrome in app mode (own window, no tabs or address bar)."""
    prof = os.path.join(engine.DATA, "window-profile")
    flags = [f"--app={url}", f"--user-data-dir={prof}", "--window-size=1280,860", "--no-first-run",
             "--no-default-browser-check", "--disable-features=Translate"]
    cands = []
    if os.name == "nt":
        for base in (os.environ.get("ProgramFiles(x86)", ""), os.environ.get("ProgramFiles", ""), os.environ.get("LOCALAPPDATA", "")):
            cands += [os.path.join(base, "Microsoft", "Edge", "Application", "msedge.exe"),
                      os.path.join(base, "Google", "Chrome", "Application", "chrome.exe")]
    cands += [shutil.which(x) or "" for x in ("msedge", "microsoft-edge", "google-chrome", "chromium", "chrome")]
    for exe in cands:
        if exe and os.path.isfile(exe):
            return subprocess.Popen([exe] + flags)
    webbrowser.open(url)
    return None


APP_ID = "DavVoid.Cooked"

LAUNCHER_CS = r"""
using System; using System.Diagnostics; using System.IO; using System.Text;
using System.Runtime.InteropServices; using System.Runtime.InteropServices.ComTypes;
[assembly: System.Reflection.AssemblyTitle("Cooked")]
[assembly: System.Reflection.AssemblyProduct("Cooked")]

[ComImport, Guid("00021401-0000-0000-C000-000000000046")] class CShellLink {}
[ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
interface IShellLinkW {
    void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder f, int c, IntPtr fd, uint fl);
    void GetIDList(out IntPtr p); void SetIDList(IntPtr p);
    void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder s, int c);
    void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string s);
    void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder s, int c);
    void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string s);
    void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder s, int c);
    void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string s);
    void GetHotkey(out short h); void SetHotkey(short h);
    void GetShowCmd(out int i); void SetShowCmd(int i);
    void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder s, int c, out int i);
    void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string s, int i);
    void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string s, uint r);
    void Resolve(IntPtr hwnd, uint f);
    void SetPath([MarshalAs(UnmanagedType.LPWStr)] string s);
}
[StructLayout(LayoutKind.Sequential, Pack = 4)] struct PropKey { public Guid fmt; public uint pid; }
[StructLayout(LayoutKind.Explicit)] struct PropVar { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr p; [FieldOffset(16)] public long pad; }
[ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
interface IPropertyStore {
    void GetCount(out uint c); void GetAt(uint i, out PropKey k);
    void GetValue(ref PropKey k, out PropVar v); void SetValue(ref PropKey k, ref PropVar v); void Commit();
}

class Cooked {
    const string ROOT = @"__ROOT__";
    static void MakeShortcut(string lnk) {
        string exe = Process.GetCurrentProcess().MainModule.FileName;
        var link = (IShellLinkW)new CShellLink();
        link.SetPath(exe);
        link.SetWorkingDirectory(ROOT);
        link.SetDescription("Cooked - active recall");
        link.SetIconLocation(Path.Combine(ROOT, "static", "cooked.ico"), 0);
        var store = (IPropertyStore)link;
        var key = new PropKey { fmt = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = 5 };   // System.AppUserModel.ID
        var pv = new PropVar { vt = 31, p = Marshal.StringToCoTaskMemUni("__APPID__") };               // VT_LPWSTR
        store.SetValue(ref key, ref pv); store.Commit();
        ((IPersistFile)link).Save(lnk, true);
        Marshal.FreeCoTaskMem(pv.p);
    }
    [STAThread]
    static void Main(string[] args) {
        if (args.Length == 2 && args[0] == "--shortcut") { MakeShortcut(args[1]); return; }
        string dir = ROOT;                              // Cooked's folder (works even if this exe is moved)
        if (!File.Exists(Path.Combine(dir, "app.py"))) dir = AppDomain.CurrentDomain.BaseDirectory;
        if (!File.Exists(Path.Combine(dir, "app.py"))) {
            System.Windows.Forms.MessageBox.Show("Couldn't find the Cooked app folder (" + ROOT + "). Was it moved or deleted?", "Cooked");
            return;
        }
        string pyw = @"__PYW__";
        if (!File.Exists(pyw)) pyw = "pythonw.exe";
        var si = new ProcessStartInfo(pyw, "\"" + Path.Combine(dir, "app.py") + "\"");
        si.WorkingDirectory = dir;
        si.UseShellExecute = false;
        try { Process.Start(si); }
        catch (Exception e) {
            System.Windows.Forms.MessageBox.Show("Couldn't start Cooked. Is Python installed?\n\n" + e.Message, "Cooked");
        }
    }
}
"""


def build_exe():
    """Compile Cooked.exe (with the logo) using the C# compiler that ships with Windows."""
    exe = os.path.join(ROOT, "Cooked.exe")
    pyw = os.path.join(os.path.dirname(sys.executable), "pythonw.exe")
    if not os.path.isfile(pyw):
        pyw = sys.executable
    windir = os.environ.get("WINDIR", r"C:\Windows")
    csc = next((c for c in (os.path.join(windir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
                            os.path.join(windir, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe")) if os.path.isfile(c)), None)
    if not csc:
        return None
    src = os.path.join(engine.DATA, "launcher.cs")
    os.makedirs(engine.DATA, exist_ok=True)
    with open(src, "w", encoding="utf-8") as f:
        f.write(LAUNCHER_CS.replace("__PYW__", pyw).replace("__ROOT__", ROOT).replace("__APPID__", APP_ID))
    r = subprocess.run([csc, "/nologo", "/target:winexe", f"/out:{exe}", f"/win32icon:{os.path.join(STATIC, 'cooked.ico')}",
                        "/r:System.Windows.Forms.dll", src], capture_output=True, text=True, timeout=60, creationflags=0x08000000)
    if r.returncode != 0 or not os.path.isfile(exe):
        print("(Could not build Cooked.exe:", (r.stdout or r.stderr)[-300:], ")")
        return None
    return exe


def desktop_dir():
    try:
        import ctypes
        buf = ctypes.create_unicode_buffer(260)
        ctypes.windll.shell32.SHGetFolderPathW(None, 0x10, None, 0, buf)   # CSIDL_DESKTOPDIRECTORY (OneDrive-aware)
        if buf.value and os.path.isdir(buf.value):
            return buf.value
    except Exception:
        pass
    return os.path.join(os.path.expanduser("~"), "Desktop")


def start_menu_dir():
    return os.path.join(os.environ.get("APPDATA", os.path.expanduser("~")), "Microsoft", "Windows", "Start Menu", "Programs")


def make_shortcuts():
    """Windows: build Cooked.exe (with logo); Desktop + Start Menu shortcuts carry Cooked's app ID,
    so the taskbar shows the Cooked logo and pinning works."""
    flag = os.path.join(engine.DATA, ".shortcuts4")
    if os.name != "nt" or os.path.exists(flag):
        return
    log = []
    exe = None
    try:
        exe = build_exe()
    except Exception as e:
        log.append(f"build_exe: {e}")
    if exe:
        for d in (start_menu_dir(), desktop_dir()):
            lnk = os.path.join(d, "Cooked.lnk")
            try:
                r = subprocess.run([exe, "--shortcut", lnk], capture_output=True, text=True, timeout=30)
                log.append(f"{lnk}: rc={r.returncode} exists={os.path.isfile(lnk)} {r.stderr[-200:]}")
            except Exception as e:
                log.append(f"{lnk}: {e}")
        old = os.path.join(desktop_dir(), "Cooked.exe")      # replaced by the Cooked shortcut
        if os.path.isfile(os.path.join(desktop_dir(), "Cooked.lnk")) and os.path.isfile(old):
            try:
                os.remove(old)
            except OSError as e:
                log.append(f"old desktop exe: {e}")
    os.makedirs(engine.DATA, exist_ok=True)
    open(os.path.join(engine.DATA, "setup_log.txt"), "w", encoding="utf-8").write("\n".join(log))
    if exe and os.path.isfile(os.path.join(start_menu_dir(), "Cooked.lnk")):
        open(flag, "w").write("ok")


def set_app_id():
    """Give the window Cooked's own taskbar identity (logo + pinning) instead of Python's."""
    if os.name == "nt":
        try:
            import ctypes
            ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(APP_ID)
        except Exception:
            pass


def main():
    set_app_id()
    engine.db()
    if not FROZEN:
        make_shortcuts()
    engine.start_scanner()
    threading.Thread(target=sync.loop, daemon=True).start()
    threading.Thread(target=updater.loop, daemon=True).start()
    port = free_port()
    srv = ThreadingHTTPServer(("127.0.0.1", port), H)
    url = f"http://127.0.0.1:{port}/"
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    print("=" * 46)
    print("  COOKED  |  active recall, fully cooked")
    print("  Close the Cooked window to quit.")
    print("=" * 46)
    if "--no-window" in sys.argv:
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            pass
        return engine.save()
    webview = get_webview()
    if webview:
        try:
            webview.create_window("Cooked", url, width=1280, height=860, min_size=(960, 640), background_color="#110d0b")
            icon = os.path.join(STATIC, "cooked.ico" if os.name == "nt" else "logo.png")
            try:
                webview.start(icon=icon, private_mode=False, storage_path=os.path.join(engine.DATA, "webview"))
            except TypeError:
                webview.start()
            engine.save()
            updater.install(relaunch=False)      # downloaded update? swap it in now that the window is closed
            return
        except Exception as e:
            print(f"Native window failed ({e}); using app-window fallback.")
    proc = fallback_window(url)
    try:
        while True:
            time.sleep(2)
            if proc is not None and proc.poll() is not None and time.time() - LAST_PING[0] > 8:
                break
    except KeyboardInterrupt:
        pass
    engine.save()
    updater.install(relaunch=False)


if __name__ == "__main__":
    main()
