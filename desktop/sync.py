"""Cooked cloud sync: Login with Google (Firebase Auth) + Firestore, talked to over plain REST (stdlib only).

Layout in Firestore (rules allow each user to touch only users/{their uid}/...):
  users/{uid}/state/{profile|settings}   users/{uid}/decks/{did}   users/{uid}/modules/{mid}   users/{uid}/media/{mid}__{name}
Every doc = {data: JSON string, hash: str, deleted: bool, at: ms}.

Change detection is per item and per device: we remember the remote hash we last saw (r) and our own local hash
right after that sync (l). Local changed = hash now != l. Remote changed = remote hash != r. Both changed = merge.
"""
import base64, copy, hashlib, json, os, secrets, threading, time, urllib.error, urllib.parse, urllib.request

import engine

FIREBASE = {"apiKey": "__FIREBASE_API_KEY__", "projectId": "__FIREBASE_PROJECT_ID__"}
LOGIN_PAGE = "https://dav-voidd.github.io/cooked/login.html"
FS = "https://firestore.googleapis.com/v1/projects/{p}/databases/(default)/documents"
SETTINGS_KEYS = ("api_key", "strict", "ai_judge")
LOCK = threading.Lock()          # one sync at a time
STATUS = {"busy": False, "error": "", "at": 0, "pulled": 0, "pushed": 0}
_TOKEN = {"id": None, "exp": 0}
_STATE = {"nonce": None}


def configured():
    return not FIREBASE["apiKey"].startswith("__")


def acct():
    return engine.db().setdefault("_sync", {})


def signed_in():
    return bool(acct().get("rt"))


def view():
    a = acct()
    return {"configured": configured(), "signed_in": signed_in(), "email": a.get("email", ""),
            "busy": STATUS["busy"], "error": STATUS["error"], "at": a.get("at", 0)}


# ---------------------------------------------------------------- auth
def login_url(port):
    _STATE["nonce"] = secrets.token_urlsafe(16)
    to = f"http://127.0.0.1:{port}/auth"
    return LOGIN_PAGE + "?" + urllib.parse.urlencode({"to": to, "state": _STATE["nonce"]})


def finish_login(q):
    if not _STATE["nonce"] or q.get("state") != _STATE["nonce"]:
        raise PermissionError("This sign-in link is not from this app. Start again from Settings.")
    _STATE["nonce"] = None
    a = acct()
    if a.get("uid") and a["uid"] != q.get("uid"):
        a["items"] = {}           # different Google account: forget what we synced with the old one
    a.update(rt=q["rt"], uid=q["uid"], email=q.get("email", ""))
    _TOKEN.update(id=None, exp=0)
    engine.save()
    threading.Thread(target=run, daemon=True).start()


def sign_out():
    a = acct()
    for k in ("rt", "uid", "email", "items", "media", "at"):
        a.pop(k, None)
    _TOKEN.update(id=None, exp=0)
    engine.save()


def _http(method, url, body=None, token=None, form=False, timeout=30):
    data, headers = None, {}
    if body is not None:
        if form:
            data = urllib.parse.urlencode(body).encode()
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        else:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        txt = e.read().decode(errors="replace")
        try:
            msg = json.loads(txt).get("error", {})
            msg = msg.get("message", txt) if isinstance(msg, dict) else str(msg)
        except ValueError:
            msg = txt
        err = RuntimeError(f"{e.code}: {msg[:200]}")
        err.code = e.code
        raise err


def token():
    if _TOKEN["id"] and time.time() < _TOKEN["exp"] - 120:
        return _TOKEN["id"]
    try:
        r = _http("POST", "https://securetoken.googleapis.com/v1/token?key=" + FIREBASE["apiKey"],
                  {"grant_type": "refresh_token", "refresh_token": acct()["rt"]}, form=True)
    except RuntimeError as e:
        if getattr(e, "code", 0) in (400, 401, 403):
            sign_out()
            raise RuntimeError("Your Google sign-in expired. Sign in again in Settings.")
        raise
    acct()["rt"] = r.get("refresh_token", acct()["rt"])
    _TOKEN.update(id=r["id_token"], exp=time.time() + int(r.get("expires_in", 3600)))
    return _TOKEN["id"]


# ---------------------------------------------------------------- firestore
def _base():
    return FS.format(p=FIREBASE["projectId"]) + f"/users/{acct()['uid']}"


def _list(coll):
    out, page = {}, None
    while True:
        url = f"{_base()}/{coll}?pageSize=300&mask.fieldPaths=hash&mask.fieldPaths=deleted"
        if page:
            url += "&pageToken=" + urllib.parse.quote(page)
        r = _http("GET", url, token=token())
        for d in r.get("documents", []):
            f = d.get("fields", {})
            out[d["name"].rsplit("/", 1)[1]] = {"hash": f.get("hash", {}).get("stringValue", ""),
                                               "deleted": f.get("deleted", {}).get("booleanValue", False)}
        page = r.get("nextPageToken")
        if not page:
            return out


def _get(coll, key):
    f = _http("GET", f"{_base()}/{coll}/{urllib.parse.quote(key)}", token=token()).get("fields", {})
    return json.loads(f["data"]["stringValue"]) if "data" in f else None


def _put(coll, key, data, h, deleted=False):
    fields = {"hash": {"stringValue": h}, "deleted": {"booleanValue": deleted}, "at": {"integerValue": str(int(time.time() * 1000))}}
    if not deleted:
        s = json.dumps(data, ensure_ascii=False, default=list)
        if len(s.encode()) > 950_000:
            raise RuntimeError(f"'{data.get('title') or data.get('name') or key}' is too big to sync (over 1 MB).")
        fields["data"] = {"stringValue": s}
    _http("PATCH", f"{_base()}/{coll}/{urllib.parse.quote(key)}", {"fields": fields}, token=token())


def _hash(o):
    return hashlib.sha1(json.dumps(o, sort_keys=True, ensure_ascii=False, default=list).encode()).hexdigest()


# ---------------------------------------------------------------- what we sync
def _clean_module(m):
    return {k: v for k, v in m.items() if not k.startswith("_")}


def local_items(db):
    items = {"state/profile": db["profile"], "state/settings": {k: db["settings"].get(k) for k in SETTINGS_KEYS}}
    for did, d in db["decks"].items():
        items["decks/" + did] = d
    for mid, m in db["modules"].items():
        if m.get("status") == "ready":            # half-scanned modules stay on the device that is scanning them
            items["modules/" + mid] = _clean_module(m)
    return items


def _ts(p):
    return max(p.get("lr") or 0, p.get("last") or 0)


def merge(kind, a, b):
    """a = local, b = remote. Keep everything either device learned."""
    if kind == "profile":
        out = dict(a)
        for k in ("xp", "best_combo", "best_day_streak", "answered", "correct", "reviews_correct"):
            out[k] = max(a.get(k) or 0, b.get(k) or 0)
        if (b.get("last_day") or "") > (a.get("last_day") or ""):
            out["last_day"], out["day_streak"] = b.get("last_day"), b.get("day_streak", 0)
        out["badges"] = {**(b.get("badges") or {}), **(a.get("badges") or {})}
        h = dict(a.get("history") or {})
        for d, n in (b.get("history") or {}).items():
            h[d] = max(h.get(d, 0), n)
        out["history"] = h
        return out
    if kind == "decks":
        out = dict(a)
        out["order"] = list(a.get("order", [])) + [x for x in b.get("order", []) if x not in a.get("order", [])]
        out["exam_date"] = a.get("exam_date") or b.get("exam_date")
        return out
    if kind == "modules":
        out = copy.deepcopy(a)
        if {q["id"] for q in a.get("questions", [])} != {q["id"] for q in b.get("questions", [])}:
            return out if len(a.get("questions", [])) >= len(b.get("questions", [])) else copy.deepcopy(b)
        pq = out.setdefault("progress_q", {})
        for qid, p in (b.get("progress_q") or {}).items():
            if qid not in pq or _ts(p) > _ts(pq[qid]):
                pq[qid] = p
        out["mastered"] = bool(a.get("mastered") or b.get("mastered"))
        out["mastered_at"] = min([t for t in (a.get("mastered_at"), b.get("mastered_at")) if t] or [None])
        seen, ex = set(), []
        for e in sorted((a.get("exams") or []) + (b.get("exams") or []), key=lambda e: e.get("at", 0)):
            if e.get("at") not in seen:
                seen.add(e.get("at"))
                ex.append(e)
        out["exams"] = ex
        return out
    return {k: a.get(k) if a.get(k) not in (None, "") else b.get(k) for k in set(a) | set(b)}   # settings: this device wins unless empty


def _apply(db, key, data):
    coll, k = key.split("/", 1)
    if coll == "state":
        if k == "profile":
            db["profile"] = data
        else:
            db["settings"].update({x: data[x] for x in SETTINGS_KEYS if x in data and data[x] not in (None, "")})
    elif coll == "decks":
        db["decks"][k] = data
    else:
        old = db["modules"].get(k) or {}
        keep = {x: v for x, v in old.items() if x.startswith("_")}
        src = os.path.join(engine.DATA, "decks", data["deck_id"], k, data.get("source") or "-")
        if not old and not os.path.exists(src):
            keep["_nosrc"] = True     # its file lives on the other device: no rescans here
        db["modules"][k] = {**data, **keep}


def _remove(db, key):
    coll, k = key.split("/", 1)
    if coll == "decks" and k in db["decks"]:
        for mid in list(db["decks"][k].get("order", [])):
            db["modules"].pop(mid, None)
        db["decks"].pop(k)
    elif coll == "modules" and k in db["modules"]:
        m = db["modules"].pop(k)
        d = db["decks"].get(m["deck_id"])
        if d and k in d["order"]:
            d["order"].remove(k)


def _fixup(db):
    for did, d in list(db["decks"].items()):
        d["order"] = [m for m in d.get("order", []) if m in db["modules"]]
        d["order"] += [mid for mid, m in db["modules"].items() if m["deck_id"] == did and mid not in d["order"]]
    for mid, m in list(db["modules"].items()):
        if m["deck_id"] not in db["decks"]:
            db["modules"].pop(mid)


# ---------------------------------------------------------------- media (diagram crops)
def _media_path(m, name):
    return os.path.join(engine.module_dir(m), "media", os.path.basename(name))


def _media(db, pushed_mods, pulled_mods):
    a = acct()
    done = set(a.setdefault("media", []))
    for mid in pushed_mods:
        m = db["modules"].get(mid)
        for v in (m or {}).get("visuals", []):
            name = v["ref"].split(":", 1)[1]
            key = f"{mid}__{name}"
            p = _media_path(m, name)
            if key in done or not os.path.exists(p) or os.path.getsize(p) > 700_000:
                continue
            _put("media", key, {"b64": base64.b64encode(open(p, "rb").read()).decode()}, "1")
            done.add(key)
    for mid in pulled_mods:
        m = db["modules"].get(mid)
        for v in (m or {}).get("visuals", []):
            name = v["ref"].split(":", 1)[1]
            p = _media_path(m, name)
            if os.path.exists(p):
                continue
            try:
                d = _get("media", f"{mid}__{name}")
            except RuntimeError:
                continue
            if d:
                os.makedirs(os.path.dirname(p), exist_ok=True)
                open(p, "wb").write(base64.b64decode(d["b64"]))
                done.add(f"{mid}__{name}")
    a["media"] = sorted(done)


# ---------------------------------------------------------------- the sync pass
def run():
    if not (configured() and signed_in()) or not LOCK.acquire(blocking=False):
        return view()
    STATUS.update(busy=True, error="")
    try:
        _run()
        acct()["at"] = time.time()
    except Exception as e:
        STATUS["error"] = str(e)[:200] if not isinstance(e, urllib.error.URLError) else "Offline. Will sync when you're back online."
    finally:
        STATUS["busy"] = False
        LOCK.release()
        with engine.LOCK:
            engine.save()
    return view()


def _run():
    remote = {}
    for coll in ("state", "decks", "modules"):
        for k, v in _list(coll).items():
            remote[f"{coll}/{k}"] = v
    with engine.LOCK:
        db = engine.db()
        snap = copy.deepcopy(local_items(db))
    known = acct().setdefault("items", {})
    pushes, pulls, deletes = [], [], []
    for key in sorted(set(snap) | set(remote) | set(known)):
        L = _hash(snap[key]) if key in snap else None
        R = remote.get(key)
        rh = (R or {}).get("hash")
        k = known.get(key, {})
        lchg, rchg = L != k.get("l"), rh != k.get("r")
        if R and R["deleted"]:
            if L and not k:                    # never synced before: ours is new, keep it
                pushes.append(key)
            elif L:
                deletes.append(key)
            known[key] = {"r": rh, "l": None}
        elif L is None:
            if R and k and not rchg:           # deleted here since last sync
                _put(*key.split("/", 1), None, "x" + secrets.token_hex(4), deleted=True)
                known.pop(key, None)
            elif R:
                pulls.append((key, None))
            else:
                known.pop(key, None)
        elif not R:
            pushes.append(key)
        elif lchg and rchg:
            pulls.append((key, "merge"))
        elif rchg:
            pulls.append((key, None))
        elif lchg:
            pushes.append(key)
    # fetch remote copies first (network), then apply under the lock
    fetched = {key: _get(*key.split("/", 1)) for key, _ in pulls}
    pushed_mods, pulled_mods, merged = [], [], []
    with engine.LOCK:
        db = engine.db()
        for key in deletes:
            _remove(db, key)
        for key, how in sorted(pulls, key=lambda x: (not x[0].startswith("decks"), x[0])):
            data = fetched.get(key)
            if data is None:
                continue
            if how == "merge":
                data = merge(key.split("/")[0] if not key.startswith("state") else key.split("/")[1], snap[key], data)
                merged.append(key)
            _apply(db, key, data)
            if key.startswith("modules/"):
                pulled_mods.append(key.split("/", 1)[1])
        _fixup(db)
        after = copy.deepcopy(local_items(db))
    for key, _ in pulls:
        if key in after:
            known[key] = {"r": remote[key]["hash"], "l": _hash(after[key])}
    for key in pushes + merged:
        if key not in after:
            continue
        h = _hash(after[key])
        _put(*key.split("/", 1), after[key], h)
        known[key] = {"r": h, "l": h}
        if key.startswith("modules/"):
            pushed_mods.append(key.split("/", 1)[1])
    _media(engine.db(), pushed_mods, pulled_mods)
    STATUS.update(pulled=len(pulls), pushed=len(pushes) + len(merged))


def loop():
    while True:
        time.sleep(5)
        if configured() and signed_in():
            run()
            time.sleep(55)
