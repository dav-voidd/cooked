"""Use your Claude Pro/Max plan through the official Claude Code CLI installed on this PC."""
import json, os, shutil, subprocess

import gemini


class ClaudeError(Exception):
    pass


def find_claude():
    home = os.path.expanduser("~")
    cands = [shutil.which("claude"), shutil.which("claude.exe"), shutil.which("claude.cmd"),
             os.path.join(home, ".local", "bin", "claude.exe"), os.path.join(home, ".local", "bin", "claude"),
             os.path.join(os.environ.get("APPDATA", ""), "npm", "claude.cmd"),
             os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs", "claude", "claude.exe")]
    for c in cands:
        if c and os.path.isfile(c):
            return c
    return None


MODEL = {"name": "sonnet"}   # set from Settings: haiku (fastest) / sonnet (balanced) / opus (best, slowest)


def run(prompt, cwd=None, tools="Read,Glob,LS", timeout=1500, max_turns=40):
    """Run `claude -p` headless (prompt via stdin) and return the final text."""
    exe = find_claude()
    if not exe:
        raise ClaudeError("Claude Code isn't installed. Settings → Claude Pro → follow the 2 setup steps.")
    args = [exe, "-p", "--output-format", "json", "--max-turns", str(max_turns)]
    if MODEL["name"]:
        args += ["--model", MODEL["name"]]
    if tools:
        args += ["--allowedTools", tools]
    env = dict(os.environ)
    env.pop("ANTHROPIC_API_KEY", None)          # make sure it uses your Pro login, not paid API credits
    env["MAX_THINKING_TOKENS"] = "0"            # skip extended thinking: much faster for reading modules
    flags = 0x08000000 if os.name == "nt" else 0  # CREATE_NO_WINDOW
    try:
        p = subprocess.run(args, input=prompt, capture_output=True, text=True, encoding="utf-8", errors="ignore",
                           cwd=cwd, timeout=timeout, env=env, creationflags=flags)
    except subprocess.TimeoutExpired:
        raise ClaudeError("Claude took too long. Try again or split the module.")
    out = (p.stdout or "").strip()
    try:
        data = json.loads(out)
    except json.JSONDecodeError:
        msg = " ".join(((p.stderr or "") + " " + out).split())[-300:] or "no output"
        low = msg.lower()
        if "log in" in low or "login" in low or "not authenticated" in low or "/login" in low:
            raise ClaudeError(f"Claude Code isn't signed in (Settings → Claude Pro → Re-login). Claude said: {msg}")
        raise ClaudeError(f"Claude Code error (exit {p.returncode}): {msg}")
    if data.get("is_error"):
        res = str(data.get("result", ""))
        low = res.lower()
        if "limit" in low:
            raise ClaudeError("Claude Pro usage limit reached. It resets in a few hours (or switch to Gemini in Settings).")
        if "log in" in low or "login" in low or "not authenticated" in low or "invalid api key" in low:
            raise ClaudeError(f"Claude Code isn't signed in (Settings → Claude Pro → Re-login). Claude said: {res[:200]}")
        raise ClaudeError(f"Claude: {res[:300] or data.get('subtype')}")
    return str(data.get("result", ""))


def run_json(prompt, cwd=None, tools="Read,Glob,LS", timeout=1500, max_turns=40):
    text = run(prompt + "\n\nReply with ONLY the JSON (no markdown fences, no commentary).", cwd, tools, timeout, max_turns)
    try:
        return gemini.parse_json(text)
    except Exception:
        raise ClaudeError("Claude didn't return valid JSON. Try Rescan.")


def status():
    exe = find_claude()
    return {"installed": bool(exe), "path": exe or ""}


def open_setup():
    """Open a PowerShell window that installs Claude Code (if needed) and starts the Pro login."""
    if os.name != "nt":
        raise ClaudeError("Automatic setup is for Windows. Install Claude Code and run `claude` once to log in.")
    exe = find_claude()
    lines = ["$Host.UI.RawUI.WindowTitle = 'Connect Claude Pro to Cooked'",
             "Write-Host 'Connecting your Claude Pro plan to Cooked...' -ForegroundColor Yellow"]
    if not exe:
        lines += ["Write-Host 'Step 1/2: installing Claude Code (official installer from claude.ai)...' -ForegroundColor Cyan",
                  "irm https://claude.ai/install.ps1 | iex",
                  "$env:Path = \"$env:USERPROFILE\\.local\\bin;$env:Path\""]
    lines += ["Write-Host ''",
              "Write-Host 'Step 2/2: log in. Choose \"Claude account with subscription\" and sign in with your Pro account.' -ForegroundColor Cyan",
              "Write-Host 'After you see the Claude prompt, type /exit and close this window. Then press Test in Cooked.' -ForegroundColor Cyan",
              "Write-Host ''",
              "$env:Path = \"$env:USERPROFILE\\.local\\bin;$env:Path\"",
              (f"& '{exe}'" if exe else "& \"$env:USERPROFILE\\.local\\bin\\claude.exe\"")]
    import base64
    script = "; ".join(lines)
    enc = base64.b64encode(script.encode("utf-16-le")).decode()
    subprocess.Popen(["powershell", "-NoExit", "-ExecutionPolicy", "Bypass", "-EncodedCommand", enc],
                     creationflags=0x00000010)  # CREATE_NEW_CONSOLE


def test():
    r = run_json('Return {"ok": true}', tools="", timeout=120, max_turns=1)
    return bool(r.get("ok"))
