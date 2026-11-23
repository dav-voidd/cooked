"""Minimal Gemini REST client (stdlib only)."""
import base64, json, re, time, urllib.request, urllib.error

BASE = "https://generativelanguage.googleapis.com"
DEFAULT_MODELS = ["gemini-flash-latest", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-flash-lite-latest", "gemini-3.5-flash-lite"]
INLINE_LIMIT = 18 * 1024 * 1024


class GeminiError(Exception):
    pass


def _req(url, key, data=None, headers=None, method=None, timeout=300, raw=False):
    h = {"x-goog-api-key": key}
    if headers:
        h.update(headers)
    body = data
    if data is not None and not isinstance(data, (bytes, bytearray)):
        body = json.dumps(data).encode()
        h.setdefault("Content-Type", "application/json")
    r = urllib.request.Request(url, data=body, headers=h, method=method)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            content = resp.read()
            return (resp, content) if raw else json.loads(content or b"{}")
    except urllib.error.HTTPError as e:
        txt = e.read().decode("utf-8", "ignore")
        try:
            err = json.loads(txt).get("error", {})
        except Exception:
            err = {"message": txt[:500]}
        ex = GeminiError(f"Gemini HTTP {e.code}: {err.get('message', '')[:400]}")
        ex.code = e.code
        ex.details = err.get("details", [])
        raise ex
    except urllib.error.URLError as e:
        ex = GeminiError(f"Network error: {e.reason}. Check your internet connection.")
        ex.code = 0
        ex.details = []
        raise ex


def _version_key(name):
    nums = re.findall(r"(\d+(?:\.\d+)?)", name)
    v = float(nums[0]) if nums else 0
    penalty = (("lite" in name) * 1) + (("preview" in name or "exp" in name) * 2)
    return (-penalty, v)


def list_models(key):
    out, token = [], None
    while True:
        url = f"{BASE}/v1beta/models?pageSize=200" + (f"&pageToken={token}" if token else "")
        data = _req(url, key, timeout=30)
        for m in data.get("models", []):
            if "generateContent" in m.get("supportedGenerationMethods", []):
                out.append(m["name"].replace("models/", ""))
        token = data.get("nextPageToken")
        if not token:
            break
    return out


_NO_THINK = set()
_CACHE = {"names": None, "t": 0, "good": None, "bad": {}}


def pick_candidates(key, preferred):
    """Return an ordered list of models to try (last working model first, quota-dead ones last).
    preferred: a model name, "auto" (best Flash) or "fast" (Flash-Lite first: fastest)."""
    if preferred and preferred not in ("auto", "fast"):
        return [preferred]
    try:
        if not _CACHE["names"] or time.time() - _CACHE["t"] > 3600:
            _CACHE["names"], _CACHE["t"] = list_models(key), time.time()
        names = _CACHE["names"]
    except GeminiError:
        names = DEFAULT_MODELS
    bad = ("image", "tts", "live", "audio", "embedding", "vision", "learnlm", "gemma", "robotics", "computer", "native")
    flash = [n for n in names if "flash" in n and not any(b in n for b in bad)]
    flash.sort(key=_version_key, reverse=True)
    out = flash[:6] or list(DEFAULT_MODELS)
    for d in DEFAULT_MODELS:
        if d in names and d not in out:
            out.append(d)
    for d in ("gemini-flash-latest", "gemini-flash-lite-latest"):      # stable aliases as a safety net
        if d in names and d not in out:
            out.append(d)
    if preferred == "fast":
        lite = sorted([n for n in names if "flash-lite" in n and not any(b in n for b in bad)], key=_version_key, reverse=True)
        out = lite[:3] + [m for m in out if m not in lite]
        now = time.time()
        out.sort(key=lambda m: _CACHE["bad"].get(m, 0) > now)
        return out
    now = time.time()
    out.sort(key=lambda m: (_CACHE["bad"].get(m, 0) > now, m != _CACHE["good"]))
    return out


def upload_file(key, data, mime, name="upload"):
    start = _req(f"{BASE}/upload/v1beta/files", key, data={"file": {"display_name": name}},
                 headers={"X-Goog-Upload-Protocol": "resumable", "X-Goog-Upload-Command": "start",
                          "X-Goog-Upload-Header-Content-Length": str(len(data)),
                          "X-Goog-Upload-Header-Content-Type": mime}, raw=True, timeout=60)
    upload_url = start[0].headers.get("x-goog-upload-url")
    if not upload_url:
        raise GeminiError("File upload failed (no upload URL)")
    res = _req(upload_url, key, data=bytes(data), headers={
        "Content-Length": str(len(data)), "X-Goog-Upload-Offset": "0",
        "X-Goog-Upload-Command": "upload, finalize"}, timeout=600)
    f = res["file"]
    for _ in range(60):
        if f.get("state") in (None, "ACTIVE"):
            return f["uri"]
        if f.get("state") == "FAILED":
            raise GeminiError("Gemini could not process the uploaded file")
        time.sleep(3)
        f = _req(f"{BASE}/v1beta/{f['name']}", key, timeout=30)
    raise GeminiError("Timed out waiting for file processing")


def blob_part(key, data, mime, name="file"):
    if len(data) <= 1024 * 1024:
        return {"inline_data": {"mime_type": mime, "data": base64.b64encode(data).decode()}}
    try:
        return {"file_data": {"mime_type": mime, "file_uri": upload_file(key, data, mime, name)}}
    except GeminiError:
        if len(data) <= INLINE_LIMIT:
            return {"inline_data": {"mime_type": mime, "data": base64.b64encode(data).decode()}}
        raise


def _retry_delay(ex, attempt):
    for d in getattr(ex, "details", []) or []:
        rd = d.get("retryDelay")
        if rd:
            try:
                return min(float(rd.rstrip("s")) + 1, 65)
            except ValueError:
                pass
    return min(5 * (2 ** attempt), 60)


def parse_json(text):
    t = text.strip()
    t = re.sub(r"^```(?:json)?\s*|\s*```$", "", t)
    try:
        return json.loads(t)
    except json.JSONDecodeError:
        m = re.search(r"[\{\[].*[\}\]]", t, re.S)
        if m:
            return json.loads(m.group(0))
        raise


def _thinking(model):
    """Keep 'thinking' minimal: it's the slowest part and not needed for reading modules."""
    m = model.lower()
    if "lite" in m or "2.0" in m or "1.5" in m:
        return None
    if "2.5" in m:
        return {"thinkingBudget": 0} if "flash" in m else {"thinkingBudget": 128}
    return {"thinkingLevel": "minimal"} if "flash" in m else {"thinkingLevel": "low"}


def generate_json(key, model_pref, parts, schema=None, system=None, temperature=0.4, log=None, timeout=300, quick=False):
    """Call Gemini and return parsed JSON. Moves to the next model fast on quota/404 errors."""
    body = {"contents": [{"role": "user", "parts": parts}],
            "generationConfig": {"temperature": temperature, "responseMimeType": "application/json"}}
    if schema:
        body["generationConfig"]["responseSchema"] = schema
    if system:
        body["systemInstruction"] = {"parts": [{"text": system}]}
    last = None
    tried = []
    for model in pick_candidates(key, model_pref):
        tried.append(model)
        waited = 0
        think = _thinking(model) if model not in _NO_THINK else None
        for attempt in range(1 if quick else 3):
            gc = body["generationConfig"]
            gc.pop("thinkingConfig", None)
            if think:
                gc["thinkingConfig"] = think
            try:
                if log:
                    log(f"Asking {model}...")
                print(f"[gemini] {model} attempt {attempt + 1}", flush=True)
                res = _req(f"{BASE}/v1beta/models/{model}:generateContent", key, data=body, timeout=timeout)
                cands = res.get("candidates") or []
                if not cands:
                    raise GeminiError("Gemini returned no answer (blocked?): " + json.dumps(res.get("promptFeedback", {}))[:200])
                text = "".join(p.get("text", "") for p in cands[0].get("content", {}).get("parts", []) if not p.get("thought"))
                try:
                    out = parse_json(text)
                    _CACHE["good"] = model
                    return out
                except Exception:
                    last = GeminiError("Gemini returned invalid JSON" + (" (output too long - cut off)" if cands[0].get("finishReason") == "MAX_TOKENS" else ""))
                    last.code = -1
                    continue
            except GeminiError as e:
                last = e
                code = getattr(e, "code", 0)
                msg = (str(e) + json.dumps(getattr(e, "details", []))).lower()
                print(f"[gemini] {model}: {str(e)[:200]}", flush=True)
                if code in (401, 403) or (code == 400 and "api key" in msg):
                    raise GeminiError("Invalid Gemini API key. Open Settings and paste a valid key.")
                if code == 400 and think and "think" in msg:
                    _NO_THINK.add(model)               # model doesn't accept this setting: retry without it
                    think = None
                    continue
                if code in (400, 404):
                    break                                   # model not usable -> next model
                if code == 429:
                    dead = "limit: 0" in msg or "perday" in msg or "per day" in msg or "free_tier" in msg and "limit" in msg
                    if dead or waited:
                        _CACHE["bad"][model] = time.time() + (3600 if dead else 120)
                        break                               # quota gone on this model -> next model now
                    delay = min(_retry_delay(e, attempt), 20)
                    if log:
                        log(f"Busy, retrying in {int(delay)}s...")
                    time.sleep(delay)
                    waited = 1
                    continue
                if code in (0, 500, 502, 503, 504):
                    if quick:
                        break
                    time.sleep(min(_retry_delay(e, attempt), 15))
                    continue
                raise
    if last and getattr(last, "code", 0) == 429:
        raise GeminiError(f"Free-tier quota reached on all models ({', '.join(tried)}). Wait a bit (limits reset daily at 3 PM PH time) or try again later.")
    raise last or GeminiError("All Gemini models failed")
