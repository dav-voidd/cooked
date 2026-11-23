"""Cooked core: storage, AI scanning, grading, mastery gating, SRS and rewards."""
import difflib, json, os, queue, random, re, shutil, threading, time, traceback, unicodedata, uuid
from datetime import date, datetime, timedelta

import gemini, claude_cli
from extract import extract, ExtractError

import sys
ROOT = os.path.dirname(os.path.abspath(__file__))
if getattr(sys, "frozen", False):   # Cooked.exe build: keep study data in %LOCALAPPDATA%\Cooked
    DATA = os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "Cooked", "data")
else:
    DATA = os.path.join(ROOT, "data")
DB_PATH = os.path.join(DATA, "db.json")
LOCK = threading.RLock()

PASS_PCT = 95                          # Mastery Exam: 95% and up passes, 94% and below fails

STRICT = {"chill": (2, 1), "normal": (3, 1), "hardcore": (3, 99)}   # (correct-in-a-row needed, levels lost when wrong)


def need():
    return STRICT.get(db()["settings"].get("strict", "normal"), STRICT["normal"])[0]


def penalty():
    return STRICT.get(db()["settings"].get("strict", "normal"), STRICT["normal"])[1]
REVIEW_INTERVALS = [600, 86400, 3 * 86400, 7 * 86400, 16 * 86400, 35 * 86400, 90 * 86400]
XP_BASE = {"mcq": 10, "true_false": 5, "identification": 15, "fill_blank": 12, "enumeration": 20, "essay": 30}
TYPE_LABEL = {"mcq": "Multiple Choice", "true_false": "True or False", "identification": "Identification",
              "fill_blank": "Fill in the Blank", "enumeration": "Enumeration", "essay": "Essay"}
RANKS = ["Raw", "Rare", "Medium Rare", "Medium", "Medium Well", "Well Done", "Seared", "Flame-Grilled",
         "Fully Cooked", "Michelin Star", "Master Chef", "Legendary Chef"]
BADGES = {
    "first_bite": ("First Bite", "Answer your first question correctly", "🍳"),
    "on_fire": ("On Fire", "Reach a 10-answer combo", "🔥"),
    "inferno": ("Inferno", "Reach a 25-answer combo", "🌋"),
    "fully_cooked": ("Fully Cooked", "Reach a 50-answer combo", "👨‍🍳"),
    "well_done": ("Well Done", "Pass your first Mastery Exam (95%+)", "🥩"),
    "chefs_kiss": ("Chef's Kiss", "Pass a Mastery Exam on the first try", "💋"),
    "simmer3": ("3-Day Simmer", "Study 3 days in a row", "🍲"),
    "roast7": ("Week-Long Roast", "Study 7 days in a row", "🍗"),
    "slow30": ("Slow-Cooked", "Study 30 days in a row", "🏆"),
    "century": ("Century", "Answer 100 questions", "💯"),
    "wordsmith": ("Wordsmith", "Score 95+ on an essay", "✍️"),
    "never_forget": ("Never Forget", "Get 10 spaced reviews right", "🧠"),
    "night_owl": ("Night Owl", "Study after 11 PM", "🦉"),
    "xp5k": ("Hot Kitchen", "Earn 5,000 XP", "⭐"),
    "triple": ("Triple Course", "Master 3 modules", "🍽️"),
}

# ---------------------------------------------------------------- storage

def _empty():
    return {"profile": {"xp": 0, "combo": 0, "best_combo": 0, "day_streak": 0, "best_day_streak": 0,
                        "last_day": None, "answered": 0, "correct": 0, "reviews_correct": 0,
                        "badges": {}, "history": {}},
            "settings": {"api_key": "", "model": "auto", "ai_judge": True, "strict": "normal", "provider": "gemini", "claude_model": "sonnet", "gemini_speed": "balanced"},
            "decks": {}, "modules": {}}


def load():
    with LOCK:
        if not os.path.exists(DB_PATH):
            return _empty()
        with open(DB_PATH, encoding="utf-8") as f:
            db = json.load(f)
        base = _empty()
        for k, v in base.items():
            db.setdefault(k, v)
        for k, v in base["profile"].items():
            db["profile"].setdefault(k, v)
        for k, v in base["settings"].items():
            db["settings"].setdefault(k, v)
        return db


DB = None


def db():
    global DB
    if DB is None:
        DB = load()
    return DB


def save():
    with LOCK:
        os.makedirs(DATA, exist_ok=True)
        tmp = DB_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(DB, f, ensure_ascii=False, default=lambda o: list(o) if isinstance(o, (set, tuple)) else str(o))
        os.replace(tmp, DB_PATH)


def api_key():
    return os.environ.get("GEMINI_API_KEY") or db()["settings"].get("api_key", "")


def module_dir(m):
    return os.path.join(DATA, "decks", m["deck_id"], m["id"])

# ---------------------------------------------------------------- AI prompts

SYSTEM = ("You are an expert university exam setter and tutor. You read course modules completely, including every "
          "diagram, figure, table, chart, formula and slide, and you never invent facts that are not supported by the module. "
          "Write in the same language as the module.")

NOTES_SCHEMA = {"type": "OBJECT", "required": ["title", "summary", "concepts"], "properties": {
    "title": {"type": "STRING"}, "summary": {"type": "STRING"},
    "concepts": {"type": "ARRAY", "items": {"type": "OBJECT", "required": ["id", "title", "explanation", "importance"], "properties": {
        "id": {"type": "STRING"}, "title": {"type": "STRING"}, "explanation": {"type": "STRING"},
        "importance": {"type": "STRING", "enum": ["critical", "high", "medium"]},
        "must_memorize": {"type": "ARRAY", "items": {"type": "STRING"}},
        "visual_ref": {"type": "STRING"}, "visual_box": {"type": "ARRAY", "items": {"type": "NUMBER"}},
        "visual_description": {"type": "STRING"}}}}}}

Q_SCHEMA = {"type": "OBJECT", "required": ["questions"], "properties": {"questions": {"type": "ARRAY", "items": {
    "type": "OBJECT", "required": ["type", "concept_id", "prompt", "explanation"], "properties": {
        "type": {"type": "STRING", "enum": list(XP_BASE)},
        "concept_id": {"type": "STRING"}, "prompt": {"type": "STRING"},
        "choices": {"type": "ARRAY", "items": {"type": "STRING"}}, "correct_index": {"type": "INTEGER"},
        "answer": {"type": "STRING"}, "accepted": {"type": "ARRAY", "items": {"type": "STRING"}},
        "items": {"type": "ARRAY", "items": {"type": "OBJECT", "required": ["text"], "properties": {
            "text": {"type": "STRING"}, "accepted": {"type": "ARRAY", "items": {"type": "STRING"}}}}},
        "ordered": {"type": "BOOLEAN"}, "rubric": {"type": "ARRAY", "items": {"type": "STRING"}},
        "explanation": {"type": "STRING"}, "visual_ref": {"type": "STRING"}, "visual_box": {"type": "ARRAY", "items": {"type": "NUMBER"}},
        "difficulty": {"type": "INTEGER"}}}}}}


def _visual_rules(kind, visuals):
    if kind == "pdf":
        return ('VISUALS: This is a PDF. ONLY when a question truly needs a picture to be answered (a diagram, network '
                'topology, flowchart, chart/graph, labeled figure, table, circuit, architecture/layer model), set visual_ref to '
                '"page:N" (1-based PDF page) AND visual_box to [left, top, right, bottom] as fractions 0-1 of that page, tightly '
                'around just the diagram (not the slide title or bullet text). NEVER attach a visual to text-only slides, '
                'title slides, photos, logos, icons or decorative pictures. Most questions should have NO visual.')
    if visuals:
        refs = ", ".join(v["ref"] for v in visuals)
        return ('VISUALS: Images are embedded with markers like [VISUAL ref="img:..."]. ONLY when a question truly needs a '
                'picture (diagram, network topology, flowchart, chart, labeled figure, table, architecture model), set visual_ref '
                f'to its exact ref. Valid refs: {refs}. NEVER use photos, logos, icons, stock or decorative images. '
                'Most questions should have NO visual.')
    return "VISUALS: there are no images; leave visual_ref empty."


NOTES_PROMPT = """Scan this ENTIRE module, every page/slide, every diagram, figure, table and chart.
Extract EVERYTHING that is very important to understand and that could appear in an exam: definitions, terms, classifications,
lists/steps (with exact count and order), formulas, rules, properties, differences/comparisons, examples, dates, people,
causes/effects, and what each important diagram shows (its parts, labels, flow and meaning).
Be exhaustive: missing an exam-relevant fact is a failure. Skip only trivia like page headers, logos, instructor names and housekeeping.
Each concept: a short title, a complete but clear explanation (as a reviewer the student will study), importance
(critical = very likely in exam), and must_memorize = exact terms/items/values to memorize word-for-word.
Give concepts ids c1, c2, ... in the module's order. {visuals}"""

Q_PROMPT = """Using the module content and this list of key concepts, create an exam question bank for ACTIVE RECALL.
RULES:
- Cover 100% of the concepts listed below. Critical concepts need at least 3 questions, high at least 2, medium at least 1,
  each testing from a different angle (definition -> term, term -> definition, application, comparison, diagram reading).
- Mix ALL types: mcq, true_false, identification, fill_blank, enumeration, essay. Use enumeration for every list/steps/types/
  components in the module. Use at least one essay per 6 concepts for "explain/compare/discuss" understanding.
- Only diagram-type content (topologies, flowcharts, models, charts, labeled figures, tables) gets a visual question; ask about
  what it shows (labels, parts, flow). Never write "refer to the image" without setting visual_ref. No visuals for plain text.
- mcq: exactly 4 plausible choices, correct_index 0-3, no "all of the above" tricks. Distractors must be real terms from the topic.
- true_false: choices ["True","False"], correct_index 0 for True, 1 for False. Make about half of them False with a subtle error.
- identification: prompt is a description, answer is the exact term. accepted = answer plus acceptable variants (acronym, full form,
  common spelling). fill_blank: prompt contains "____" for ONE missing key term; answer + accepted same as identification.
- enumeration: items = every required item (each with accepted variants); prompt must say how many, e.g. "Enumerate the 4 ...".
  ordered=true only if the module says order matters (steps, sequence).
- essay: rubric = 3-6 key points a full-mark answer must contain.
- explanation: teach WHY the answer is right in 1-3 sentences so the student learns from mistakes.
- difficulty 1-3. concept_id must match a concept id below. No duplicate questions. Questions must be answerable from the module only.
{visuals}
KEY CONCEPTS (create questions for these concept ids: {ids}):
{concepts}"""


def _box(b):
    try:
        b = [max(0.0, min(1.0, float(x))) for x in b]
        if len(b) == 4 and b[2] - b[0] > 0.08 and b[3] - b[1] > 0.08:
            return [round(x, 3) for x in b]
    except (TypeError, ValueError):
        pass
    return None


def _validate_questions(raw, visuals, kind):
    refs = {v["ref"] for v in visuals}
    out, seen = [], set()
    for q in raw:
        t = q.get("type")
        p = (q.get("prompt") or "").strip()
        key = re.sub(r"\W+", "", p.lower())
        if not p or key in seen or t not in XP_BASE:
            continue
        vr = (q.get("visual_ref") or "").strip()
        if vr and not ((kind == "pdf" and re.fullmatch(r"page:\d+", vr)) or vr in refs):
            vr = ""
        clean = {"id": uuid.uuid4().hex[:10], "type": t, "prompt": p, "concept_id": q.get("concept_id", ""),
                 "explanation": q.get("explanation", ""), "visual_ref": vr, "difficulty": q.get("difficulty") or 2,
                 "visual_box": _box(q.get("visual_box")) if vr.startswith("page:") else None}
        if t == "mcq":
            ch = [c for c in (q.get("choices") or []) if str(c).strip()]
            ci = q.get("correct_index")
            if len(ch) < 3 or not isinstance(ci, int) or not 0 <= ci < len(ch):
                continue
            clean.update(choices=ch, correct_index=ci)
        elif t == "true_false":
            ci = q.get("correct_index")
            if ci not in (0, 1):
                a = str(q.get("answer", "")).strip().lower()
                if a not in ("true", "false"):
                    continue
                ci = 0 if a == "true" else 1
            clean.update(choices=["True", "False"], correct_index=ci)
        elif t in ("identification", "fill_blank"):
            a = (q.get("answer") or "").strip()
            if not a:
                continue
            acc = [a] + [x for x in (q.get("accepted") or []) if x and x.strip()]
            clean.update(answer=a, accepted=list(dict.fromkeys(acc)))
        elif t == "enumeration":
            items = [{"text": i["text"].strip(), "accepted": list(dict.fromkeys([i["text"].strip()] + [x for x in (i.get("accepted") or []) if x]))}
                     for i in (q.get("items") or []) if i.get("text", "").strip()]
            if len(items) < 2:
                continue
            clean.update(items=items, ordered=bool(q.get("ordered")))
        elif t == "essay":
            rub = [r for r in (q.get("rubric") or []) if r.strip()]
            if len(rub) < 2:
                continue
            clean.update(rubric=rub)
        seen.add(key)
        out.append(clean)
    return out


CLAUDE_SCAN = """You are scanning a university course module for a student's active-recall exam app.
Files in this folder: {files}
{how}
STEP 1 - NOTES. """ + "{notes}" + """
STEP 2 - QUESTIONS. """ + "{questions}" + """

OUTPUT: do NOT put the JSON in your reply. Use the Write tool to save files in the current folder:
  1) cooked_notes.json  -> {{"title", "summary", "concepts": [...]}}
  2) cooked_q1.json, cooked_q2.json, ... -> {{"questions": [...]}} with AT MOST 20 questions per file
     (write each file as soon as it's ready; cover every concept across the files).
When all files are written, reply with just: DONE
The combined data must follow exactly this shape:
{{"title": str, "summary": str,
 "concepts": [{{"id":"c1","title":str,"explanation":str,"importance":"critical|high|medium","must_memorize":[str],"visual_ref":str,"visual_box":[num,num,num,num],"visual_description":str}}],
 "questions": [{{"type":"mcq|true_false|identification|fill_blank|enumeration|essay","concept_id":"c1","prompt":str,
   "choices":[str],"correct_index":int,"answer":str,"accepted":[str],"items":[{{"text":str,"accepted":[str]}}],"ordered":bool,
   "rubric":[str],"explanation":str,"visual_ref":str,"visual_box":[num,num,num,num],"difficulty":1}}]}}
Only include the fields each question type needs."""


def scan_module_claude(m, mdir):
    def log(msg):
        m["progress"] = msg
    log("Reading file...")
    parts, visuals, kind, blob = extract(os.path.join(mdir, m["source"]), os.path.join(mdir, "media"))
    m["kind"], m["visuals"] = kind, visuals
    if kind == "pdf":
        files = m["source"]
        how = f"Read the whole PDF '{m['source']}' (every page, look at every diagram/figure/table)."
    else:
        with open(os.path.join(mdir, "content.txt"), "w", encoding="utf-8") as f:
            f.write("\n".join(p["text"] for p in parts if "text" in p))
        files = "content.txt" + (", and images in media/" if visuals else "")
        how = ("Read content.txt fully. " + ("It contains markers like [VISUAL ref=\"img:NAME\"]: open each image file "
               "media/NAME with the Read tool to see the diagram, and judge whether it's exam-relevant." if visuals else ""))
    m["stage_pct"] = 5
    log("Claude (your Pro plan) is reading every page & writing questions...")
    vis = _visual_rules(kind, visuals)
    prompt = CLAUDE_SCAN.format(files=files, how=how, notes=NOTES_PROMPT.format(visuals=vis),
                                questions=Q_PROMPT.format(visuals=vis, ids="all concept ids from step 1",
                                                          concepts="(the concepts you wrote in step 1)"))
    import glob
    for f in glob.glob(os.path.join(mdir, "cooked_*.json")):
        os.remove(f)
    text = claude_cli.run(prompt, cwd=mdir, tools="Read,Glob,Grep,Write")
    data = {}
    try:
        with open(os.path.join(mdir, "cooked_notes.json"), encoding="utf-8") as f:
            data = gemini.parse_json(f.read())
    except Exception:
        pass
    qfiles = sorted(glob.glob(os.path.join(mdir, "cooked_q*.json")), key=lambda x: int(re.findall(r"\d+", os.path.basename(x))[0] or 0))
    allq = []
    for qf in qfiles:
        try:
            with open(qf, encoding="utf-8") as f:
                allq += gemini.parse_json(f.read()).get("questions") or []
        except Exception:
            continue          # one broken part shouldn't kill the whole scan
    if not data.get("concepts"):
        try:                  # fallback: JSON put directly in the reply
            data = gemini.parse_json(text)
        except Exception:
            raise claude_cli.ClaudeError("Claude didn't save the question files. Press Retry.")
    if allq:
        data["questions"] = allq
    concepts = [c for c in (data.get("concepts") or []) if isinstance(c, dict) and c.get("title")]
    refs = {v["ref"] for v in visuals}
    for i, c in enumerate(concepts, 1):
        c.setdefault("id", f"c{i}"); c.setdefault("importance", "high"); c.setdefault("explanation", "")
        vr = (c.get("visual_ref") or "").strip()
        if vr and not ((kind == "pdf" and re.fullmatch(r"page:\d+", vr)) or vr in refs):
            c["visual_ref"] = ""
        c["visual_box"] = _box(c.get("visual_box")) if (c.get("visual_ref") or "").startswith("page:") else None
    questions = _validate_questions(data.get("questions") or [], visuals, kind)
    if not concepts or len(questions) < 3:
        raise claude_cli.ClaudeError("Claude produced too few valid questions. Try Rescan.")
    title = data.get("title") or m["filename"]
    m["notes"] = {"title": title, "summary": data.get("summary", ""), "concepts": concepts}
    m["title"] = title
    m["questions"] = questions
    m["progress_q"] = {q["id"]: _new_prog() for q in questions}
    m["status"] = "ready"
    m["progress"] = f"{len(questions)} questions from {len(concepts)} key concepts (Claude)"


def ai_json(prompt, schema, fast=False):
    """Small AI calls (essay grading / answer checking): Gemini if a key exists (faster), else Claude Pro.
    fast=True: answer checks with a short time limit (falls back to the normal check if slow)."""
    st = db()["settings"]
    if api_key():
        try:
            return gemini.generate_json(api_key(), st.get("model", "auto"), [{"text": prompt}], schema, temperature=0,
                                        timeout=12 if fast else 60, quick=fast)
        except gemini.GeminiError:
            if st.get("provider") != "claude":
                raise
    if st.get("provider") == "claude":
        claude_cli.MODEL["name"] = "haiku"      # quick checks: fastest model
        try:
            return claude_cli.run_json(prompt, tools="", timeout=25 if fast else 180, max_turns=2)
        finally:
            claude_cli.MODEL["name"] = st.get("claude_model", "sonnet")
    raise gemini.GeminiError("No AI available: add a Gemini key or choose Claude Pro in Settings.")


ONE_PASS_SCHEMA = {"type": "OBJECT", "required": ["title", "summary", "concepts", "questions"], "properties": {
    **NOTES_SCHEMA["properties"], "questions": Q_SCHEMA["properties"]["questions"]}}

ONE_PASS_RULES = """
THEN, in the same JSON, write the question bank ("questions") for ACTIVE RECALL:
- For EVERY concept: 2 core questions about its key term/idea (one identification or fill_blank for the exact term,
  one mcq or true_false from a different angle).
- Every list/types/steps/components in the module: one enumeration (say how many). ordered=true only if order matters.
- Every exam-relevant diagram: one question about what it shows, with visual_ref set.
- Critical "explain/compare/discuss" concepts: one essay with a 3-5 point rubric.
- mcq: exactly 4 plausible choices, correct_index 0-3. true_false: correct_index 0=True 1=False, about half False.
- identification/fill_blank: answer + accepted variants (acronym/full form). fill_blank prompt contains "____".
- explanation: ONE short sentence. concept_id must match. No duplicates. Only facts from the module.
"""

GEMINI_GATE = threading.Semaphore(1)    # one Gemini scan at a time: avoids free-tier rate-limit waits


def scan_module(mid):
    d = db()
    m = d["modules"][mid]
    if d["settings"].get("provider") == "claude":
        claude_cli.MODEL["name"] = d["settings"].get("claude_model", "sonnet")
        return scan_module_claude(m, module_dir(m))
    with GEMINI_GATE:
        return _scan_gemini(m)


def _finish_scan(m, concepts, questions, kind, visuals):
    for c in concepts:
        vr = (c.get("visual_ref") or "").strip()
        if vr and not ((kind == "pdf" and re.fullmatch(r"page:\d+", vr)) or vr in {v["ref"] for v in visuals}):
            c["visual_ref"] = ""
        c["visual_box"] = _box(c.get("visual_box")) if (c.get("visual_ref") or "").startswith("page:") else None
    m["questions"] = questions
    m["progress_q"] = {q["id"]: _new_prog() for q in questions}
    m["status"] = "ready"
    m["progress"] = f"{len(questions)} questions from {len(concepts)} key concepts"


def _scan_gemini(m):
    d = db()
    key = api_key()
    if not key:
        raise gemini.GeminiError("No Gemini API key yet. Open Settings (gear icon) and paste your free key.")

    def log(msg):
        m["progress"] = msg

    mdir = module_dir(m)
    log("Reading file...")
    parts, visuals, kind, blob = extract(os.path.join(mdir, m["source"]), os.path.join(mdir, "media"))
    if blob:
        log("Uploading PDF to Gemini...")
        parts = [gemini.blob_part(key, blob[0], blob[1], m["filename"])]
    m["kind"], m["visuals"] = kind, visuals
    model = d["settings"].get("model", "auto")
    if model == "auto" and d["settings"].get("gemini_speed") == "fast":
        model = "fast"

    # ONE PASS: notes + question bank in a single request (about half the time of two passes)
    m["stage_pct"] = 8
    log("Gemini is reading every page & writing questions...")
    try:
        res = gemini.generate_json(key, model, parts + [{"text": NOTES_PROMPT.format(visuals=_visual_rules(kind, visuals)) + ONE_PASS_RULES}],
                                   ONE_PASS_SCHEMA, SYSTEM, 0.3, log)
        concepts = res.get("concepts") or []
        questions = _validate_questions(res.get("questions") or [], visuals, kind)
        if concepts and len(questions) >= max(5, len(concepts)):
            m["notes"] = {"title": res.get("title") or m["filename"], "summary": res.get("summary", ""), "concepts": concepts}
            m["title"] = m["notes"]["title"]
            _finish_scan(m, concepts, questions, kind, visuals)
            return
        log("Filling in the gaps...")
    except gemini.GeminiError as e:
        if "API key" in str(e) or "quota" in str(e).lower():
            raise
        log("Big module: switching to two-step scan...")

    m["stage_pct"] = 10
    log("Scanning every page for exam-critical content...")
    notes = gemini.generate_json(key, model, parts + [{"text": NOTES_PROMPT.format(visuals=_visual_rules(kind, visuals))}],
                                 NOTES_SCHEMA, SYSTEM, 0.2, log)
    concepts = notes.get("concepts") or []
    if not concepts:
        raise gemini.GeminiError("Gemini found no content in this file.")
    for c in concepts:
        vr = (c.get("visual_ref") or "").strip()
        if vr and not ((kind == "pdf" and re.fullmatch(r"page:\d+", vr)) or vr in {v["ref"] for v in visuals}):
            c["visual_ref"] = ""
        c["visual_box"] = _box(c.get("visual_box")) if (c.get("visual_ref") or "").startswith("page:") else None
    m["notes"] = {"title": notes.get("title") or m["filename"], "summary": notes.get("summary", ""), "concepts": concepts}
    m["title"] = m["notes"]["title"]

    # write questions for several concept groups at the same time
    chunks = [concepts[i:i + 10] for i in range(0, len(concepts), 10)]
    done = [0]
    m["stage_pct"] = 45
    log(f"Writing questions (0/{len(chunks)} parts)...")

    def gen(ch):
        prompt = Q_PROMPT.format(visuals=_visual_rules(kind, visuals), ids=", ".join(c["id"] for c in ch),
                                 concepts=json.dumps(ch, ensure_ascii=False))
        res = gemini.generate_json(key, model, parts + [{"text": prompt}], Q_SCHEMA, SYSTEM, 0.5)
        done[0] += 1
        m["stage_pct"] = 45 + int(50 * done[0] / len(chunks))
        log(f"Writing questions ({done[0]}/{len(chunks)} parts)...")
        return res.get("questions") or []

    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=min(2, len(chunks))) as ex:
        results = list(ex.map(gen, chunks))
    questions = _validate_questions([q for r in results for q in r], visuals, kind)
    if len(questions) < 3:
        raise gemini.GeminiError("Gemini produced too few valid questions. Try Rescan.")
    m["questions"] = questions
    m["progress_q"] = {q["id"]: _new_prog() for q in questions}
    m["status"] = "ready"
    m["progress"] = f"{len(questions)} questions from {len(concepts)} key concepts"


def _new_prog():
    return {"streak": 0, "correct": 0, "wrong": 0, "box": -1, "due": None, "last": None}

# ---------------------------------------------------------------- scan time estimates

def _count_pages(path):
    try:
        ext = os.path.splitext(path)[1].lower()
        data = open(path, "rb").read()
        if ext == ".pdf":
            n = len(re.findall(rb"/Type\s*/Page[^s]", data))
            return n or max(1, len(data) // 80000)
        if ext in (".pptx", ".ppsx"):
            import zipfile, io
            return max(1, sum(1 for x in zipfile.ZipFile(io.BytesIO(data)).namelist() if re.match(r"ppt/slides/slide\d+\.xml$", x)))
        if ext == ".docx":
            return max(1, len(data) // 40000)
        return 1
    except Exception:
        return 10


def _estimate(m):
    """Expected scan seconds, learned from your previous scans (falls back to defaults)."""
    st = db()["settings"]
    prov = st.get("provider", "gemini")
    model = st.get("claude_model", "sonnet") if prov == "claude" else "gemini"
    hist = [h for h in st.get("scan_hist", []) if h.get("model") == model and h.get("pages")]
    if len(hist) >= 1:
        per_page = sum(h["sec"] / h["pages"] for h in hist) / len(hist)
        base = 15
    else:
        per_page = {"haiku": 3, "sonnet": 6, "opus": 11, "gemini": 3}.get(model, 6)
        base = 45 if prov == "claude" else 25
    return int(base + per_page * m.get("pages", 10)), model


def _record_time(m, model):
    st = db()["settings"]
    h = st.setdefault("scan_hist", [])
    h.append({"sec": time.time() - m["scan_started"], "pages": m.get("pages", 10), "model": model})
    del h[:-12]

# ---------------------------------------------------------------- background scanner

SCAN_Q = queue.Queue()


def _scanner():
    while True:
        mid = SCAN_Q.get()
        d = db()
        m = d["modules"].get(mid)
        if not m:
            continue
        m["status"], m["error"] = "scanning", ""
        m["pages"] = _count_pages(os.path.join(module_dir(m), m["source"]))
        m["scan_started"] = time.time()
        m["stage_pct"] = 2
        m["eta"], model = _estimate(m)
        try:
            scan_module(mid)
            if m["status"] == "ready":
                _record_time(m, model)
        except (gemini.GeminiError, ExtractError, claude_cli.ClaudeError) as e:
            m["status"], m["error"] = "error", str(e)
        except Exception as e:
            traceback.print_exc()
            m["status"], m["error"] = "error", f"Unexpected error: {e}"
        with LOCK:
            save()


def bootstrap_memory():
    """Give questions studied before the memory model existed a starting estimate from their history."""
    for m in db()["modules"].values():
        for p in m.get("progress_q", {}).values():
            if not p.get("S") and p.get("last"):
                net = max(0, p.get("correct", 0) - p.get("wrong", 0))
                p["S"] = min(20.0, 0.6 * 1.6 ** max(0, net - 1)) if p.get("correct") else 0.15
                p["lr"] = p["last"]


def start_scanner():
    bootstrap_memory()
    regrade_past_exams()
    restore_sessions()
    for _ in range(2):
        threading.Thread(target=_scanner, daemon=True).start()
    for m in sorted(db()["modules"].values(), key=lambda x: x.get("created", 0)):
        if m["status"] in ("queued", "scanning"):
            m["status"] = "queued"
            SCAN_Q.put(m["id"])

# ---------------------------------------------------------------- memory model (FSRS-style forgetting curve)
# R(t) = (1 + 19/81 * t/S) ^ -0.5   with S = stability in days (the gap at which recall drops to 90%).
DAY = 86400.0


def retr(p, at=None):
    S, lr = p.get("S"), p.get("lr")
    if not S or not lr:
        return 0.0
    t = max(0.0, ((at or time.time()) - lr) / DAY)
    return (1 + 19 / 81 * t / S) ** -0.5


def update_memory(p, ok):
    """Every answer is a retrieval. Recalling when it was harder (lower R) grows stability more (desirable difficulty)."""
    R = retr(p)
    S = p.get("S")
    if ok:
        p["S"] = 0.6 if not S else min(365.0, S * (1.4 + 2.2 * (1 - R)))
    else:
        p["S"] = 0.15 if not S else max(0.15, S * 0.35)
    p["lr"] = time.time()


def exam_ts(did):
    d = (db()["decks"].get(did) or {}).get("exam_date")
    if not d:
        return None
    try:
        return datetime.strptime(d, "%Y-%m-%d").replace(hour=8).timestamp()
    except ValueError:
        return None


def schedule(p, did):
    """Next review when recall would drop to 90%, but never farther than ~30% of the time left before the exam
    (spacing gap sweet spot, Cepeda et al. 2008)."""
    now = time.time()
    gap = max(0.25, p.get("S") or 1.0) * DAY
    ex = exam_ts(did)
    if ex and ex > now:
        gap = min(gap, max(4 * 3600, 0.3 * (ex - now)))
    p["due"] = now + gap


def forecast(did):
    """Predicted recall on exam day across all in-scope questions of unlocked modules."""
    ex = exam_ts(did)
    at = ex if ex and ex > time.time() else time.time()
    rs, weak = [], 0
    for mid in db()["decks"][did]["order"]:
        m = db()["modules"][mid]
        if m["status"] != "ready":
            continue
        for q in active_qs(m):
            r = retr(m["progress_q"][q["id"]], at)
            rs.append(r)
            weak += r < 0.8
    days = (ex - time.time()) / DAY if ex else None
    return {"exam_date": db()["decks"][did].get("exam_date"), "days_left": round(days, 1) if days is not None else None,
            "recall": round(100 * sum(rs) / len(rs)) if rs else 0, "weak": weak, "total": len(rs)}


def set_exam_date(did, date_str):
    if date_str:
        datetime.strptime(date_str, "%Y-%m-%d")
    db()["decks"][did]["exam_date"] = date_str or None
    for mid in db()["decks"][did]["order"]:              # pull reviews in so they land before the exam
        m = db()["modules"][mid]
        if m["mastered"]:
            for q in active_qs(m):
                pq = m["progress_q"][q["id"]]
                if pq.get("lr"):
                    schedule(pq, did)
    save()


def start_boost(did):
    """Exam Boost: the 15 in-scope questions you're most likely to forget by exam day. Successive relearning:
    each one comes back until you get it right once."""
    old = next((s for s in SESSIONS.values() if not s.get("done") and s["mode"] == "boost" and s.get("deck_id") == did and s["queue"]), None)
    if old:
        r = next_question(old["id"]); r["resumed"] = True
        return r
    ex = exam_ts(did)
    at = ex if ex and ex > time.time() else time.time()
    pool = []
    for mid in db()["decks"][did]["order"]:
        m = db()["modules"][mid]
        if m["status"] != "ready" or not is_unlocked(m):
            continue
        for q in active_qs(m):
            pq = m["progress_q"][q["id"]]
            if pq.get("lr") or pq["streak"] > 0 or m["mastered"]:   # only things you've started learning
                pool.append((retr(pq, at), random.random(), mid, q["id"]))
    if not pool:
        raise Blocked("Nothing to boost yet. Start learning a module first.")
    pool.sort()
    q = [(mid, qid) for _, _, mid, qid in pool[:15]]
    random.shuffle(q)
    sid = uuid.uuid4().hex[:10]
    SESSIONS[sid] = {"id": sid, "mode": "boost", "module_id": None, "deck_id": did, "queue": q, "total": len(q), "cur": None,
                     "done": False, "right": 0, "wrong": 0, "wrong_ids": [], "xp": 0, "since": {}, "step": 0, "answered_ids": set()}
    persist_sessions(); save()
    return next_question(sid)

# ---------------------------------------------------------------- decks & modules

def create_deck(name):
    did = uuid.uuid4().hex[:8]
    db()["decks"][did] = {"id": did, "name": name.strip() or "My Subject", "created": time.time(), "order": []}
    save()
    return did


def add_module(did, filename, data):
    d = db()
    deck = d["decks"][did]
    mid = uuid.uuid4().hex[:8]
    ext = os.path.splitext(filename)[1].lower()
    m = {"id": mid, "deck_id": did, "filename": filename, "title": os.path.splitext(filename)[0], "source": "source" + ext,
         "status": "queued", "error": "", "progress": "Waiting in line...", "created": time.time(),
         "notes": None, "questions": [], "progress_q": {}, "mastered": False, "mastered_at": None, "exams": []}
    os.makedirs(module_dir(m), exist_ok=True)
    with open(os.path.join(module_dir(m), m["source"]), "wb") as f:
        f.write(data)
    d["modules"][mid] = m
    deck["order"].append(mid)
    save()
    SCAN_Q.put(mid)
    return mid


def import_module(did, data, source_name=None, source_bytes=None):
    """Add a module from a ready-made question bank (e.g. written by Claude in chat)."""
    if isinstance(data, str):
        data = gemini.parse_json(data)
    if not isinstance(data, dict) or not data.get("questions"):
        raise ValueError("That file has no 'questions'. Use the .cooked.json file Claude made for you.")
    d = db()
    deck = d["decks"][did]
    mid = uuid.uuid4().hex[:8]
    kind = "pdf" if source_name and source_name.lower().endswith(".pdf") else "text"
    title = (data.get("title") or "Imported module").strip()
    m = {"id": mid, "deck_id": did, "filename": source_name or (title + ".cooked.json"), "title": title,
         "source": ("source.pdf" if kind == "pdf" else "source.json"), "status": "ready", "error": "",
         "progress": "", "created": time.time(), "kind": kind, "visuals": [], "imported": True,
         "notes": None, "questions": [], "progress_q": {}, "mastered": False, "mastered_at": None, "exams": []}
    concepts = [c for c in (data.get("concepts") or []) if isinstance(c, dict) and c.get("title")]
    for i, c in enumerate(concepts, 1):
        c.setdefault("id", f"c{i}")
        c.setdefault("importance", "high")
        c.setdefault("explanation", "")
        vr = (c.get("visual_ref") or "").strip()
        if not (kind == "pdf" and re.fullmatch(r"page:\d+", vr)):
            c["visual_ref"] = ""
        c["visual_box"] = _box(c.get("visual_box")) if (c.get("visual_ref") or "").startswith("page:") else None
    qs = _validate_questions(data["questions"], [], kind)
    if len(qs) < 3:
        raise ValueError(f"Only {len(qs)} valid questions found in that file.")
    m["notes"] = {"title": title, "summary": data.get("summary", ""), "concepts": concepts}
    m["questions"] = qs
    m["progress_q"] = {q["id"]: _new_prog() for q in qs}
    m["progress"] = f"{len(qs)} questions from {len(concepts)} key concepts (imported)"
    os.makedirs(module_dir(m), exist_ok=True)
    with open(os.path.join(module_dir(m), m["source"]), "wb") as f:
        f.write(source_bytes if kind == "pdf" else json.dumps(data, ensure_ascii=False).encode())
    d["modules"][mid] = m
    deck["order"].append(mid)
    save()
    return mid, len(qs)


def set_scope(mid, depth=None, topics=None, detail=None):
    m = db()["modules"][mid]
    if m["mastered"]:
        raise PermissionError("Already mastered. Its scope is locked in.")
    if detail in ("key", "full"):
        m["detail"] = detail
        if depth is None and topics is None:
            save(); return
    if topics is not None:
        allids = {c.get("id") for c in (m["notes"] or {}).get("concepts", [])}
        topics = [t for t in topics if t in allids]
        if not topics:
            raise ValueError("Pick at least one topic.")
        m["scope"] = None if set(topics) == allids else topics
        if m["scope"] is None:
            m["depth"] = "all"
    elif depth in DEPTHS:
        m["depth"], m["scope"] = depth, None
    save()


def scope_view(mid):
    m = db()["modules"][mid]
    ids, every = scope_info(m)
    cnt = {}
    for q in m["questions"]:
        cnt[q.get("concept_id")] = cnt.get(q.get("concept_id"), 0) + 1
    return {"depth": m.get("depth", "critical") if m.get("scope") is None else "custom", "mastered": m["mastered"],
            "detail": m.get("detail", "key"),
            "concepts": [{"id": c.get("id"), "title": c.get("title"), "importance": c.get("importance", "high"),
                          "count": cnt.get(c.get("id"), 0), "on": every or c.get("id") in ids}
                         for c in (m["notes"] or {}).get("concepts", [])],
            "active": len(active_qs(m)), "total": len(m["questions"])}


def export_deck(did):
    d = db()["decks"][did]
    mods = []
    for mid in d["order"]:
        m = db()["modules"][mid]
        if m["status"] != "ready":
            continue
        mods.append({"title": m["title"], "summary": (m["notes"] or {}).get("summary", ""), "concepts": (m["notes"] or {}).get("concepts", []),
                     "questions": [{k: v for k, v in q.items() if k != "id"} for q in m["questions"]]})
    return {"cooked_subject": 1, "name": d["name"], "modules": mods}


def rescan(mid):
    m = db()["modules"][mid]
    if m["mastered"]:
        raise PermissionError("This module is already mastered.")
    if m.get("imported"):
        raise PermissionError("Imported modules can't be rescanned. Import a new file instead.")
    media = os.path.join(module_dir(m), "media")
    shutil.rmtree(media, ignore_errors=True)
    m.update(status="queued", error="", progress="Waiting in line...", questions=[], progress_q={}, notes=None)
    save()
    SCAN_Q.put(mid)


def delete_module(mid):
    d = db()
    m = d["modules"].pop(mid)
    d["decks"][m["deck_id"]]["order"].remove(mid)
    shutil.rmtree(module_dir(m), ignore_errors=True)
    save()


def delete_deck(did):
    d = db()
    for mid in list(d["decks"][did]["order"]):
        d["modules"].pop(mid, None)
    d["decks"].pop(did)
    shutil.rmtree(os.path.join(DATA, "decks", did), ignore_errors=True)
    save()


def reorder(did, order):
    d = db()
    deck = d["decks"][did]
    if sorted(order) != sorted(deck["order"]):
        raise ValueError("bad order")
    # cannot move anything in front of / among mastered modules
    mastered_prefix = [mid for mid in deck["order"] if d["modules"][mid]["mastered"]]
    if order[:len(mastered_prefix)] != mastered_prefix:
        raise PermissionError("Mastered modules stay in place. You can only reorder the locked ones.")
    deck["order"] = order
    save()


def is_unlocked(m):
    order = db()["decks"][m["deck_id"]]["order"]
    i = order.index(m["id"])
    return all(db()["modules"][x]["mastered"] for x in order[:i])


DEPTHS = {"critical": {"critical"}, "important": {"critical", "high"}, "all": {"critical", "high", "medium"}}
MIN_SCOPE_Q = 10


def scope_info(m):
    """Which concepts/questions count for this module (exam scope). Default: most important only."""
    concepts = (m.get("notes") or {}).get("concepts") or []
    imp = {c.get("id"): (c.get("importance") or "high") for c in concepts}
    depth = m.get("depth", "critical")
    picked = m.get("scope")            # explicit topic list (None = use depth)
    if picked is not None:
        ids = set(picked)
    else:
        ids = {cid for cid, i in imp.items() if i in DEPTHS.get(depth, DEPTHS["all"])}
        # too few questions? widen automatically so there's enough to practice
        for wider in ("important", "all"):
            if len(_scoped(m, ids, len(ids) >= len(imp))) >= MIN_SCOPE_Q:
                break
            ids = {cid for cid, i in imp.items() if i in DEPTHS[wider]}
    every = len(ids) >= len(imp)
    return ids, every


KEY_RANK = {"identification": 0, "fill_blank": 1, "mcq": 2, "true_false": 3}


def _key_pick(qs, per=2):
    """Key points: per topic keep only 1-2 core 'what is it / which term' questions (no essays, no long lists)."""
    by = {}
    for q in qs:
        r = KEY_RANK.get(q["type"])
        if q["type"] == "enumeration" and len(q.get("items", [])) <= 3:
            r = 4
        if r is None:
            continue
        by.setdefault(q.get("concept_id"), []).append((r, q.get("difficulty") or 2, len(q["prompt"]), q))
    out = []
    for cid, lst in by.items():
        lst.sort(key=lambda x: x[:3])
        out += [x[3] for x in lst[:per]]
    return out


def _scoped(m, ids, every):
    qs = [q for q in m["questions"] if q.get("concept_id") in ids or (every and q.get("concept_id") not in ids)]
    if m.get("detail", "key") == "key":
        qs = _key_pick(qs)
    return qs


def active_qs(m):
    ids, every = scope_info(m)
    return _scoped(m, ids, every) or m["questions"]


def learn_ratio(m):
    qs = active_qs(m)
    if not qs:
        return 0
    return sum(min(m["progress_q"][q["id"]]["streak"], need()) for q in qs) / (need() * len(qs))


def due_reviews(did=None):
    now = time.time()
    out = []
    for m in db()["modules"].values():
        if m["mastered"] and (did is None or m["deck_id"] == did):
            for q in active_qs(m):
                p = m["progress_q"][q["id"]]
                if p["due"] and p["due"] <= now:
                    out.append((m["id"], q["id"]))
    return out


def module_summary(m):
    aq = active_qs(m)
    learned = sum(1 for q in aq if m["progress_q"][q["id"]]["streak"] >= need())
    ids, every = scope_info(m)
    nconc = len((m["notes"] or {}).get("concepts", []))
    types = {}
    for q in aq:
        types[q["type"]] = types.get(q["type"], 0) + 1
    return {"id": m["id"], "title": m["title"], "filename": m["filename"], "status": m["status"], "error": m["error"],
            "progress": m["progress"], "unlocked": is_unlocked(m), "mastered": m["mastered"], "count": len(aq), "total": len(m["questions"]),
            "depth": m.get("depth", "critical") if m.get("scope") is None else "custom", "detail": m.get("detail", "key"), "scope_topics": len(ids) if not every else nconc,
            "learned": learned, "mastery": 100 if m["mastered"] else round(learn_ratio(m) * 99),
            "exam_ready": bool(aq) and learned == len(aq) and not m["mastered"],
            "exams": m["exams"][-5:], "types": types, "concepts": len((m["notes"] or {}).get("concepts", [])),
            "kind": m.get("kind"), "imported": bool(m.get("imported")),
            "elapsed": round(time.time() - m["scan_started"]) if m["status"] == "scanning" and m.get("scan_started") else None,
            "eta": m.get("eta"), "stage_pct": m.get("stage_pct", 0), "pages": m.get("pages"),
            "session": ({"mode": a["mode"], "left": len({x[1] for x in a["queue"]})} if (a := active_session(m["id"])) else None)}


def deck_view(did):
    d = db()
    deck = d["decks"][did]
    mods = [module_summary(d["modules"][mid]) for mid in deck["order"]]
    return {"id": did, "name": deck["name"], "modules": mods, "due": len(due_reviews(did)), "forecast": forecast(did)}

# ---------------------------------------------------------------- grading

def norm(s):
    s = unicodedata.normalize("NFKD", str(s)).encode("ascii", "ignore").decode().lower()
    s = re.sub(r"[^a-z0-9+#]+", " ", s)
    s = re.sub(r"\b(a|an|the)\b", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def similar(a, b):
    a, b = norm(a), norm(b)
    if not a or not b:
        return 0.0
    if a == b or a.replace(" ", "") == b.replace(" ", ""):
        return 1.0
    return difflib.SequenceMatcher(None, a, b).ratio()


def lev(a, b):
    if len(a) < len(b):
        a, b = b, a
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def match(ans, accepted):
    """Typo-tolerant but strict: <=4 chars exact, 5-8 chars 1 typo, 9-14 chars 2 typos, longer ~85% similar."""
    a = norm(ans).replace(" ", "")
    best, ok = 0.0, False
    for x in accepted:
        b = norm(x).replace(" ", "")
        if not a or not b:
            continue
        r = similar(ans, x)
        best = max(best, r)
        n = len(b)
        allow = 0 if n <= 4 else 1 if n <= 8 else 2 if n <= 14 else None
        if a == b or (allow is not None and lev(a, b) <= allow) or (allow is None and r >= 0.85):
            ok = True
    return ok, best


STOP = set("a an the of to in on for and or is are be by with as at it its this that from into which what who how its your you".split())
JUDGE_CACHE = {}


def _stems(text):
    return {w[:5] for w in norm(text).split() if w not in STOP and len(w) > 2}


def plausible(ans, refs, context=""):
    """Is it worth asking the AI? Clearly-wrong answers (no shared idea, not close in spelling) are marked instantly."""
    if max((similar(ans, r) for r in refs), default=0) >= 0.55:
        return True
    a = _stems(ans)
    return bool(a & set().union(*[_stems(r) for r in refs], _stems(context)))


def ai_judge(q, ans, expected):
    st = db()["settings"]
    if not st.get("ai_judge", True) or (not api_key() and st.get("provider") != "claude"):
        return None
    key = (q["id"], norm(ans))
    if key in JUDGE_CACHE:
        return JUDGE_CACHE[key]
    if not plausible(ans, q.get("accepted") or [expected], q.get("explanation", "")):
        return None
    try:
        r = ai_json(
            "You are a STRICT exam checker. Decide if the student's answer means exactly the same thing as the expected "
            "answer (a correct synonym, translation, or equivalent wording). Vague, partial, or related-but-different "
            f"answers are WRONG.\nQuestion: {q['prompt']}\nExpected: {expected}\nStudent: {ans}\n"
            'Return {"correct": true/false, "reason": "short"}',
            {"type": "OBJECT", "properties": {"correct": {"type": "BOOLEAN"}, "reason": {"type": "STRING"}}, "required": ["correct"]}, fast=True)
        JUDGE_CACHE[key] = bool(r.get("correct"))
        return JUDGE_CACHE[key]
    except Exception:
        return None


def grade(q, answer, choice_map=None):
    """Returns dict(correct, score, reveal, detail)."""
    t = q["type"]
    if answer is None or answer == "" or answer == [] or (isinstance(answer, dict) and answer.get("idk")):
        return {"correct": False, "score": 0, "detail": "No answer (counts as wrong)."}
    if t in ("mcq", "true_false"):
        try:
            shown = int(answer)
            orig = choice_map[shown] if choice_map else shown
        except (ValueError, IndexError, TypeError):
            return {"correct": False, "score": 0, "detail": "Invalid choice."}
        ok = orig == q["correct_index"]
        return {"correct": ok, "score": 100 if ok else 0, "chosen": shown}
    if t in ("identification", "fill_blank"):
        ok, best = match(answer, q["accepted"])
        if not ok and len(norm(answer)) >= 2:
            j = ai_judge(q, answer, q["answer"])
            if j:
                return {"correct": True, "score": 100, "detail": "Accepted as an equivalent answer."}
        return {"correct": ok, "score": 100 if ok else 0}
    if t == "enumeration":
        given = [a for a in (answer if isinstance(answer, list) else str(answer).split("\n")) if norm(a)]
        used, marks = set(), []
        for idx, item in enumerate(q["items"]):
            hit = None
            cands = [idx] if q.get("ordered") else range(len(given))
            for gi in cands:
                if gi < len(given) and gi not in used and match(given[gi], item["accepted"])[0]:
                    hit = gi
                    break
            if hit is not None:
                used.add(hit)
            marks.append(hit is not None)
        # items not matched by spelling: let AI check meaning ("own words" answers for drawbacks, advantages, etc.)
        left_req = [k for k, ok in enumerate(marks) if not ok]
        refs = [q["items"][k]["text"] for k in left_req] + [a for k in left_req for a in q["items"][k].get("accepted", [])]
        left_ans = [g for gi, g in enumerate(given) if gi not in used and plausible(g, refs, q.get("explanation", ""))]
        ckey = (q["id"], tuple(norm(x) for x in left_ans), tuple(left_req))
        if ckey in JUDGE_CACHE:
            for k in JUDGE_CACHE[ckey]:
                marks[k] = True
            left_req = []
        st_ = db()["settings"]
        has_ai = api_key() or st_.get("provider") == "claude"
        if left_req and left_ans and has_ai and not q.get("ordered") and st_.get("ai_judge", True):
            try:
                r = ai_json(
                    "STRICT exam checker for an enumeration question. For each REQUIRED item, say whether one of the "
                    "student's entries states the same idea (own words/synonyms OK; vague, partial or different ideas are NOT). "
                    "Each student entry can match at most one required item.\n"
                    f"Question: {q['prompt']}\nREQUIRED (unmatched): {json.dumps({k: q['items'][k]['text'] for k in left_req}, ensure_ascii=False)}\n"
                    f"STUDENT entries: {json.dumps(left_ans, ensure_ascii=False)}\n"
                    'Return {"matched": [list of REQUIRED keys (numbers) that are correctly stated]}',
                    {"type": "OBJECT", "properties": {"matched": {"type": "ARRAY", "items": {"type": "INTEGER"}}}, "required": ["matched"]}, fast=True)
                ok_keys = [int(k) for k in (r.get("matched") or []) if int(k) in left_req][:len(left_ans)]
                JUDGE_CACHE[ckey] = ok_keys
                for k in ok_keys:
                    marks[k] = True
            except Exception:
                pass
        got = sum(marks)
        return {"correct": got == len(q["items"]), "score": round(100 * got / len(q["items"])), "marks": marks,
                "detail": f"{got}/{len(q['items'])} items correct" + (" (order matters)" if q.get("ordered") else "")}
    if t == "essay":
        if len(norm(answer).split()) < 8:
            return {"correct": False, "score": 0, "detail": "Too short. Explain fully in your own words."}
        r = ai_json(
            "Grade this exam essay STRICTLY against the rubric. Each rubric point must be clearly and correctly stated "
            "(own words are fine). Wrong statements reduce the score.\n"
            f"Question: {q['prompt']}\nRubric key points: {json.dumps(q['rubric'], ensure_ascii=False)}\n"
            f"Reference: {q.get('explanation', '')}\nStudent essay: {answer}\n"
            "Return JSON: score 0-100, covered and missing rubric points (copy them), and 1-3 sentences of feedback.",
            {"type": "OBJECT", "required": ["score", "covered", "missing", "feedback"], "properties": {
                "score": {"type": "INTEGER"}, "covered": {"type": "ARRAY", "items": {"type": "STRING"}},
                "missing": {"type": "ARRAY", "items": {"type": "STRING"}}, "feedback": {"type": "STRING"}}})
        score = max(0, min(100, int(r.get("score", 0))))
        ok = score >= 80 and len(r.get("missing") or []) <= (1 if len(q["rubric"]) >= 5 else 0)
        return {"correct": ok, "score": score, "covered": r.get("covered", []), "missing": r.get("missing", []),
                "detail": r.get("feedback", "")}
    return {"correct": False, "score": 0}


def reveal(q):
    t = q["type"]
    if t in ("mcq", "true_false"):
        return {"correct_index": q["correct_index"], "text": q["choices"][q["correct_index"]]}
    if t in ("identification", "fill_blank"):
        return {"text": q["answer"], "accepted": q["accepted"][1:4]}
    if t == "enumeration":
        return {"items": [i["text"] for i in q["items"]], "ordered": q.get("ordered", False)}
    return {"rubric": q["rubric"]}

# ---------------------------------------------------------------- rewards

def level_of(xp):
    lvl, need, acc = 1, 150, 0
    while xp >= acc + need:
        acc += need
        lvl += 1
        need = 150 + (lvl - 1) * 100
    return lvl, xp - acc, need


def profile_view():
    p = db()["profile"]
    lvl, into, need = level_of(p["xp"])
    today = date.today().isoformat()
    alive = p["last_day"] in (today, (date.today() - timedelta(days=1)).isoformat())
    return {"xp": p["xp"], "level": lvl, "into": into, "need": need, "rank": RANKS[min(lvl - 1, len(RANKS) - 1)],
            "combo": p["combo"], "best_combo": p["best_combo"], "day_streak": p["day_streak"] if alive else 0,
            "studied_today": p["last_day"] == today, "best_day_streak": p["best_day_streak"],
            "answered": p["answered"], "correct": p["correct"],
            "accuracy": round(100 * p["correct"] / p["answered"]) if p["answered"] else 0,
            "badges": [{"id": k, "name": v[0], "desc": v[1], "icon": v[2], "earned": k in p["badges"]} for k, v in BADGES.items()],
            "history": p["history"]}


def _award(p, bid, new):
    if bid not in p["badges"]:
        p["badges"][bid] = time.time()
        new.append({"id": bid, "name": BADGES[bid][0], "icon": BADGES[bid][2], "desc": BADGES[bid][1]})


def reward(correct, qtype, mode, essay_score=0):
    p = db()["profile"]
    new_badges = []
    today = date.today()
    t = today.isoformat()
    if p["last_day"] != t:
        p["day_streak"] = p["day_streak"] + 1 if p["last_day"] == (today - timedelta(days=1)).isoformat() else 1
        p["last_day"] = t
        p["best_day_streak"] = max(p["best_day_streak"], p["day_streak"])
    p["answered"] += 1
    p["history"][t] = p["history"].get(t, 0) + 1
    before = level_of(p["xp"])[0]
    xp = 0
    if correct:
        p["correct"] += 1
        p["combo"] += 1
        p["best_combo"] = max(p["best_combo"], p["combo"])
        mult = min(1 + 0.1 * (p["combo"] - 1), 2.5) * (1.5 if mode == "exam" else 1.2 if mode in ("review", "boost") else 0.5 if mode.startswith("practice") else 1)
        xp = round(XP_BASE[qtype] * mult)
        if mode == "review":
            p["reviews_correct"] += 1
        _award(p, "first_bite", new_badges)
    else:
        p["combo"] = 0
    p["xp"] += xp
    c = p["combo"]
    for n, b in ((10, "on_fire"), (25, "inferno"), (50, "fully_cooked")):
        if c >= n:
            _award(p, b, new_badges)
    for n, b in ((3, "simmer3"), (7, "roast7"), (30, "slow30")):
        if p["day_streak"] >= n:
            _award(p, b, new_badges)
    if p["answered"] >= 100:
        _award(p, "century", new_badges)
    if p["reviews_correct"] >= 10:
        _award(p, "never_forget", new_badges)
    if qtype == "essay" and essay_score >= 95:
        _award(p, "wordsmith", new_badges)
    if datetime.now().hour >= 23 or datetime.now().hour < 4:
        _award(p, "night_owl", new_badges)
    if p["xp"] >= 5000:
        _award(p, "xp5k", new_badges)
    return {"xp": xp, "combo": p["combo"], "badges": new_badges, "level_up": level_of(p["xp"])[0] > before}

# ---------------------------------------------------------------- sessions

SESSIONS = {}


class Blocked(Exception):
    pass


def persist_sessions():
    """Keep unfinished sessions on disk so you can resume after switching tabs or restarting."""
    db()["sessions"] = {sid: {k: v for k, v in s.items() if k != "answered_ids"}
                        for sid, s in SESSIONS.items() if not s.get("done")}


def restore_sessions():
    for sid, s in (db().get("sessions") or {}).items():
        if s.get("done") or s.get("module_id") and s["module_id"] not in db()["modules"]:
            continue
        s = dict(s)                                   # copy: never put the live session (with its set) into the saved data
        s["queue"] = [tuple(x) for x in s.get("queue", [])]
        s["answered_ids"] = set()
        SESSIONS[sid] = s


def active_session(mid, mode=None):
    for s in SESSIONS.values():
        if not s.get("done") and s.get("module_id") == mid and (mode is None or s["mode"] == mode) and s["queue"]:
            return s
    return None


def sessions_view():
    out = []
    for s in SESSIONS.values():
        if s.get("done") or not s["queue"]:
            continue
        m = db()["modules"].get(s["module_id"]) if s.get("module_id") else None
        out.append({"id": s["id"], "module_id": s.get("module_id"), "mode": s["mode"],
                    "deck_id": s.get("deck_id"),
                    "title": m["title"] if m else ("Exam Boost" if s["mode"] == "boost" else "Spaced review"), "left": len({x[1] for x in s["queue"]})})
    return out


def start_session(mid, mode):
    d = db()
    m = d["modules"].get(mid) if mid else None
    # resume where you left off (same module + mode)
    old = active_session(mid, mode)
    if old:
        if mode == "learn" and m:
            ok_ids = {x["id"] for x in active_qs(m) if m["progress_q"][x["id"]]["streak"] < need()}
            old["queue"] = [x for x in old["queue"] if x[1] in ok_ids]
        if old["queue"]:
            r = next_question(old["id"]); r["resumed"] = True
            return r
        old["done"] = True
    for sid, s_ in list(SESSIONS.items()):          # tidy finished ones; a new mode replaces practice on the same module
        if not s_.get("done") and s_.get("module_id") == mid and s_["mode"] != "exam" and mode == "exam":
            s_["done"] = True
        if s_.get("done"):
            SESSIONS.pop(sid, None)
    if mode in ("practice", "practice_all"):
        if not m or m["status"] != "ready":
            raise Blocked("This module isn't ready yet.")
        if not is_unlocked(m):
            raise Blocked("LOCKED. Pass the previous module's Mastery Exam (95%+) first.")
        pool = m["questions"] if mode == "practice_all" else active_qs(m)
        q = [(mid, x["id"]) for x in pool]
        random.shuffle(q)
    elif mode == "review":
        did = m["deck_id"] if m else None
        items = due_reviews(did)
        if not items:
            raise Blocked("No reviews due right now. Come back later!")
        random.shuffle(items)
        q = items
    else:
        if not m or m["status"] != "ready":
            raise Blocked("This module isn't ready yet.")
        if not is_unlocked(m):
            raise Blocked("LOCKED. Pass the previous module's Mastery Exam (95%+) first.")
        due = due_reviews(m["deck_id"])
        if due and not m["mastered"]:
            raise Blocked(f"Retention check first! You have {len(due)} due review(s) from mastered modules. Clear them to continue.")
        if m["mastered"]:
            raise Blocked("Already mastered. It now lives in spaced reviews so you never forget it.")
        prog = m["progress_q"]
        if mode == "learn":
            q = [(mid, x["id"]) for x in active_qs(m) if prog[x["id"]]["streak"] < need()]
            if not q:
                raise Blocked("Every question is learned. Take the Mastery Exam!")
            # weakest first, then shuffle within
            random.shuffle(q)
            q.sort(key=lambda it: prog[it[1]]["streak"])
        elif mode == "exam":
            if any(prog[x["id"]]["streak"] < need() for x in active_qs(m)):
                raise Blocked("Exam locked. Learn every question first (3 correct in a row each).")
            q = [(mid, x["id"]) for x in active_qs(m)]
            random.shuffle(q)
        else:
            raise Blocked("bad mode")
    sid = uuid.uuid4().hex[:10]
    SESSIONS[sid] = {"id": sid, "mode": mode, "module_id": mid, "queue": q, "total": len(q), "cur": None,
                     "done": False, "right": 0, "wrong": 0, "wrong_ids": [], "xp": 0, "since": {}, "step": 0,
                     "answered_ids": set()}
    persist_sessions(); save()
    return next_question(sid)


def _q(mid, qid):
    m = db()["modules"][mid]
    return m, next(x for x in m["questions"] if x["id"] == qid)


def next_question(sid):
    s = SESSIONS[sid]
    if not s["queue"]:
        return finish(s)
    mid, qid = s["queue"][0]
    m, q = _q(mid, qid)
    choices, cmap = None, None
    if q["type"] == "mcq":
        cmap = list(range(len(q["choices"])))
        random.shuffle(cmap)              # new order every time: no position memorizing
        choices = [q["choices"][i] for i in cmap]
    elif q["type"] == "true_false":
        cmap, choices = [0, 1], ["True", "False"]
    s["cur"] = {"mid": mid, "qid": qid, "cmap": cmap, "t": time.time()}
    vis = None
    if q.get("visual_ref"):
        vis = {"ref": q["visual_ref"], "module_id": mid, "kind": m.get("kind"), "box": q.get("visual_box")}
    p = m["progress_q"][qid]
    left = len({x[1] for x in s["queue"]})
    return {"session": sid, "mode": s["mode"], "done": False, "module_title": m["title"],
            "question": {"id": qid, "type": q["type"], "type_label": TYPE_LABEL[q["type"]], "prompt": q["prompt"],
                         "choices": choices, "n_items": len(q.get("items", [])), "ordered": q.get("ordered", False),
                         "visual": vis, "streak": p["streak"], "need": need(), "difficulty": q.get("difficulty", 2)},
            "stats": {"remaining": left, "total": s["total"], "right": s["right"], "wrong": s["wrong"],
                      "mastery": round(learn_ratio(db()["modules"][s["module_id"]]) * 99) if s["module_id"] and s["mode"] == "learn" else None},
            "profile": profile_view()}


def answer(sid, qid, ans):
    s = SESSIONS.get(sid)
    if not s or s["done"]:
        raise Blocked("Session expired. Start again.")
    cur = s["cur"]
    if not cur or cur["qid"] != qid:
        raise Blocked("That's not the current question.")
    m, q = _q(cur["mid"], qid)
    res = grade(q, ans, cur["cmap"])
    if res.get("chosen") is not None and cur["cmap"]:
        res["correct_shown"] = cur["cmap"].index(q["correct_index"])
    p = m["progress_q"][qid]
    ok = res["correct"]
    update_memory(p, ok)
    p["last"] = time.time()
    p["correct" if ok else "wrong"] += 1
    s["queue"].pop(0)
    s["step"] += 1
    if s["mode"] == "learn":
        if ok:
            p["streak"] += 1
            if p["streak"] < need():
                gap = random.randint(5, 8) + p["streak"] * 2   # spaced repeat inside the session
                s["queue"].insert(min(gap, len(s["queue"])), (cur["mid"], qid))
        else:
            p["streak"] = max(0, p["streak"] - penalty())       # wrong = lose a level (hardcore: back to zero)
            s["queue"].insert(min(3, len(s["queue"])), (cur["mid"], qid))
    elif s["mode"] == "review":
        if ok:
            p["box"] = min(p["box"] + 1, len(REVIEW_INTERVALS) - 1)
            schedule(p, m["deck_id"])
        else:
            p["box"] = 0
            p["due"] = time.time() + REVIEW_INTERVALS[0]
            s["queue"].insert(min(3, len(s["queue"])), (cur["mid"], qid))  # must fix it now
    elif s["mode"] == "exam":
        if not ok:
            s["wrong_ids"].append(qid)
    elif s["mode"] == "boost":
        if not ok:                                          # relearn until correct once (successive relearning)
            s["queue"].insert(min(3, len(s["queue"])), (cur["mid"], qid))
        elif m["mastered"]:
            schedule(p, m["deck_id"])
    elif s["mode"] in ("practice", "practice_all"):
        if not ok:                                          # free practice: miss it -> it comes back, mastery untouched
            s["queue"].insert(min(3, len(s["queue"])), (cur["mid"], qid))
    if ok:
        s["right"] += 1
    else:
        s["wrong"] += 1
    r = reward(ok, q["type"], s["mode"], res.get("score", 0))
    s["xp"] += r["xp"]
    persist_sessions()
    save()
    return {"result": {**res, "reveal": reveal(q), "explanation": q.get("explanation", ""), "streak": p["streak"],
                       "need": need(), "learned": s["mode"] == "learn" and ok and p["streak"] >= need()},
            "reward": r, "profile": profile_view()}


def _master(m, out, first_try, wrong_ids=()):
    prog = m["progress_q"]
    m["mastered"], m["mastered_at"] = True, time.time()
    now = time.time()
    for qq in active_qs(m):            # hand over to long-term spaced repetition (memory-model timing)
        pq = prog[qq["id"]]
        pq["box"] = 0
        if pq.get("lr"):
            schedule(pq, m["deck_id"])
        else:
            pq["due"] = now + REVIEW_INTERVALS[1]
    for qid in wrong_ids:              # passed with a few misses: those come back in a review soon
        if qid in prog:
            prog[qid].update(box=0, due=now + REVIEW_INTERVALS[0])
    p = db()["profile"]
    bonus = 500 + (250 if first_try else 0)
    p["xp"] += bonus
    out["bonus"] = bonus
    _award(p, "well_done", out["badges"])
    if first_try:
        _award(p, "chefs_kiss", out["badges"])
    if sum(1 for x in db()["modules"].values() if x["mastered"]) >= 3:
        _award(p, "triple", out["badges"])


def regrade_past_exams():
    """Exams taken under the old 100% rule that score 95%+ now count as passed."""
    changed = False
    for m in db()["modules"].values():
        if m.get("mastered"):
            continue
        for e in m.get("exams", []):
            if e.get("abandoned") or not e.get("total"):
                continue
            sc = int(100 * e["right"] / e["total"])
            if sc >= PASS_PCT:
                e.update(passed=True, score=sc, regraded=True)
                _master(m, {"badges": []}, first_try=False)
                changed = True
                break
    if changed:
        save()


def _finish_exam(s, abandoned=False):
    m = db()["modules"][s["module_id"]]
    prog = m["progress_q"]
    answered_all = not s["queue"]
    score = int(100 * s["right"] / s["total"]) if s["total"] else 0      # 94.9% counts as 94 -> fail
    passed = answered_all and not abandoned and score >= PASS_PCT
    rec = {"t": time.time(), "right": s["right"], "total": s["total"], "score": score, "passed": passed, "abandoned": abandoned}
    first_try = not m["exams"]
    m["exams"].append(rec)
    out = {"passed": passed, "bonus": 0, "badges": [], "score": score}
    if passed:
        _master(m, out, first_try, s["wrong_ids"])
    else:
        for qid in s["wrong_ids"]:          # failed items must be re-learned before the next attempt
            prog[qid]["streak"] = 0 if penalty() > 1 else max(0, need() - 1)
    s["done"] = True
    persist_sessions()
    save()
    return out


def finish(s):
    out = {"session": s["id"], "mode": s["mode"], "done": True, "right": s["right"], "wrong": s["wrong"],
           "total": s["total"], "xp": s["xp"], "profile": None}
    if s["mode"] == "exam" and not s["done"]:
        r = _finish_exam(s)
        out.update(passed=r["passed"], bonus=r["bonus"], badges=r["badges"], wrong_count=len(s["wrong_ids"]), score=r["score"], pass_pct=PASS_PCT)
    s["done"] = True
    persist_sessions(); save()
    m = db()["modules"].get(s["module_id"]) if s["module_id"] else None
    if m:
        out["module"] = module_summary(m)
        order = db()["decks"][m["deck_id"]]["order"]
        i = order.index(m["id"])
        if m["mastered"] and i + 1 < len(order):
            out["next_module"] = module_summary(db()["modules"][order[i + 1]])
    if s.get("deck_id"):
        out["forecast"] = forecast(s["deck_id"])
    out["profile"] = profile_view()
    return out


def exam_active(mid):
    return any(s["mode"] == "exam" and not s["done"] and s["module_id"] == mid for s in SESSIONS.values())
