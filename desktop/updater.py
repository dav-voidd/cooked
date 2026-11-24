"""Cooked.exe self-update: checks GitHub Releases, downloads the new Cooked.exe in the background,
and swaps it in when the app closes (or right away if you press Restart)."""
import json, os, subprocess, sys, threading, time, urllib.request

REPO = "dav-voidd/cooked"
FROZEN = getattr(sys, "frozen", False)
HERE = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
DIR = os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "Cooked", "update")
NEW = os.path.join(DIR, "Cooked-new.exe")
STATE = {"latest": 0, "ready": False, "downloading": False, "error": "", "checked": 0}


def build():
    try:
        return int(json.load(open(os.path.join(HERE, "static", "version.json")))["build"])
    except Exception:
        return 0


def view():
    return {"frozen": FROZEN, "build": build(), "latest": STATE["latest"], "ready": STATE["ready"],
            "downloading": STATE["downloading"], "error": STATE["error"]}


def _get(url, timeout=20):
    req = urllib.request.Request(url, headers={"User-Agent": "Cooked-updater", "Accept": "application/vnd.github+json"})
    return urllib.request.urlopen(req, timeout=timeout)


def check():
    """Look for a newer release; download its Cooked.exe if there is one."""
    if not FROZEN or STATE["downloading"]:
        return view()
    STATE["checked"] = time.time()
    try:
        rel = json.load(_get(f"https://api.github.com/repos/{REPO}/releases/latest"))
        latest = int("".join(c for c in rel.get("tag_name", "") if c.isdigit()) or 0)
        STATE["latest"] = latest
        if latest <= build() or STATE["ready"]:
            return view()
        asset = next((a for a in rel.get("assets", []) if a["name"] == "Cooked.exe"), None)
        if not asset:
            return view()
        STATE.update(downloading=True, error="")
        os.makedirs(DIR, exist_ok=True)
        tmp = NEW + ".part"
        with _get(asset["browser_download_url"], timeout=60) as r, open(tmp, "wb") as f:
            while True:
                chunk = r.read(1 << 16)
                if not chunk:
                    break
                f.write(chunk)
        if os.path.getsize(tmp) != asset.get("size", os.path.getsize(tmp)):
            raise RuntimeError("download was cut off")
        os.replace(tmp, NEW)
        STATE["ready"] = True
    except Exception as e:
        STATE["error"] = str(e)[:160]
    finally:
        STATE["downloading"] = False
    return view()


def install(relaunch):
    """Swap the new exe in after this process exits (a tiny batch file waits for us to close)."""
    if not (FROZEN and STATE["ready"] and os.path.exists(NEW)):
        return False
    exe, pid = sys.executable, os.getpid()
    bat = os.path.join(DIR, "apply-update.bat")
    with open(bat, "w") as f:
        f.write("@echo off\r\n"
                ":wait\r\n"
                f'tasklist /FI "PID eq {pid}" 2>nul | find "{pid}" >nul && (timeout /t 1 /nobreak >nul & goto wait)\r\n'
                f'copy /y "{NEW}" "{exe}" >nul || (timeout /t 2 /nobreak >nul & copy /y "{NEW}" "{exe}" >nul)\r\n'
                f'del "{NEW}" >nul 2>&1\r\n'
                + (f'start "" "{exe}"\r\n' if relaunch else "")
                + 'del "%~f0"\r\n')
    flags = 0x00000008 | 0x00000200 | 0x08000000      # detached, new group, no window
    subprocess.Popen(["cmd", "/c", bat], creationflags=flags, close_fds=True)
    return True


def loop():
    if not FROZEN:
        return
    time.sleep(8)
    while True:
        check()
        time.sleep(6 * 3600)
