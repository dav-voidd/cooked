"""Turn an uploaded file into Gemini content parts + saved visual assets (stdlib only)."""
import base64, hashlib, io, os, re, zipfile
import xml.etree.ElementTree as ET
from collections import Counter

IMG_MIME = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
            ".heic": "image/heic", ".heif": "image/heif"}
TEXT_EXT = {".txt", ".md", ".csv", ".json", ".html", ".htm", ".py", ".cpp", ".c", ".java", ".js"}
MAX_IMAGES = 60
MAX_IMG_BYTES = 14 * 1024 * 1024
MIN_IMG = 6 * 1024  # skip tiny icons/bullets

NS = {"a": "http://schemas.openxmlformats.org/drawingml/2006/main",
      "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
      "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
      "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
      "rel": "http://schemas.openxmlformats.org/package/2006/relationships"}


class ExtractError(Exception):
    pass


def _num(name):
    m = re.findall(r"\d+", name)
    return int(m[-1]) if m else 0


def _rels(z, path):
    d = os.path.dirname(path)
    rp = f"{d}/_rels/{os.path.basename(path)}.rels"
    out = {}
    if rp in z.namelist():
        for r in ET.fromstring(z.read(rp)).findall("rel:Relationship", NS):
            tgt = r.get("Target", "")
            if r.get("TargetMode") == "External":
                continue
            full = os.path.normpath(os.path.join(d, tgt)).replace("\\", "/")
            out[r.get("Id")] = full
    return out


def _paras(root, tag_p, tag_t):
    lines = []
    for p in root.iter(tag_p):
        t = "".join(x.text or "" for x in p.iter(tag_t)).strip()
        if t:
            lines.append(t)
    return lines


class Collector:
    def __init__(self, media_dir):
        self.media_dir = media_dir
        self.parts = []
        self.visuals = []
        self.total = 0
        self.seen = set()
        os.makedirs(media_dir, exist_ok=True)

    def text(self, t):
        if t.strip():
            self.parts.append({"text": t})

    def image(self, data, ext, where, force=False):
        ext = ext.lower()
        if ext not in IMG_MIME or (len(data) < MIN_IMG and not force):
            return
        h = hashlib.md5(data).hexdigest()[:10]
        if h in self.seen or len(self.visuals) >= MAX_IMAGES or self.total + len(data) > MAX_IMG_BYTES:
            return
        self.seen.add(h)
        self.total += len(data)
        name = f"img{len(self.visuals) + 1}_{h}{ext}"
        with open(os.path.join(self.media_dir, name), "wb") as f:
            f.write(data)
        ref = f"img:{name}"
        self.visuals.append({"ref": ref, "where": where})
        self.parts.append({"text": f"[VISUAL ref=\"{ref}\" located at {where}]"})
        self.parts.append({"inline_data": {"mime_type": IMG_MIME[ext], "data": base64.b64encode(data).decode()}})


def _pptx(z, c):
    slides = sorted([n for n in z.namelist() if re.match(r"ppt/slides/slide\d+\.xml$", n)], key=_num)
    if not slides:
        raise ExtractError("No slides found in PPTX")
    # count image usage across slides to drop repeated logos/backgrounds
    usage = Counter()
    rels_by = {}
    for s in slides:
        rels_by[s] = _rels(z, s)
        for tgt in set(rels_by[s].values()):
            if "/media/" in tgt:
                usage[tgt] += 1
    logo_limit = max(3, len(slides) // 3)
    for s in slides:
        n = _num(s)
        root = ET.fromstring(z.read(s))
        lines = _paras(root, f"{{{NS['a']}}}p", f"{{{NS['a']}}}t")
        notes = ""
        for tgt in rels_by[s].values():
            if "notesSlide" in tgt and tgt in z.namelist():
                nl = _paras(ET.fromstring(z.read(tgt)), f"{{{NS['a']}}}p", f"{{{NS['a']}}}t")
                nl = [l for l in nl if not re.fullmatch(r"\d+", l)]
                if nl:
                    notes = "\nSpeaker notes: " + " ".join(nl)
        tables = len(root.findall(".//a:tbl", NS))
        c.text(f"\n=== Slide {n} ===\n" + "\n".join(lines) + notes + (f"\n({tables} table(s) on this slide, text included above)" if tables else ""))
        for blip in root.iter(f"{{{NS['a']}}}blip"):
            rid = blip.get(f"{{{NS['r']}}}embed")
            tgt = rels_by[s].get(rid)
            if tgt and tgt in z.namelist() and usage[tgt] <= logo_limit:
                c.image(z.read(tgt), os.path.splitext(tgt)[1], f"slide {n}")
        if root.findall(".//p:graphicFrame", NS) and not tables:
            c.text(f"(Slide {n} contains a chart/diagram object; its text, if any, is included above)")


def _docx(z, c):
    if "word/document.xml" not in z.namelist():
        raise ExtractError("Not a valid DOCX")
    root = ET.fromstring(z.read("word/document.xml"))
    rels = _rels(z, "word/document.xml")
    body = root.find("w:body", NS)
    buf, para_no = [], 0
    for p in body.iter(f"{{{NS['w']}}}p"):
        para_no += 1
        t = "".join(x.text or "" for x in p.iter(f"{{{NS['w']}}}t")).strip()
        if t:
            buf.append(t)
        for blip in p.iter(f"{{{NS['a']}}}blip"):
            tgt = rels.get(blip.get(f"{{{NS['r']}}}embed"))
            if tgt and tgt in z.namelist():
                c.text("\n".join(buf)); buf = []
                c.image(z.read(tgt), os.path.splitext(tgt)[1], f"paragraph {para_no} (after: '{(t or '')[:60]}')")
    c.text("\n".join(buf))


def extract(path, media_dir):
    """Returns (parts_without_big_blob, visuals, kind, blob) where blob=(bytes,mime) for PDFs."""
    ext = os.path.splitext(path)[1].lower()
    c = Collector(media_dir)
    with open(path, "rb") as f:
        data = f.read()
    if ext == ".pdf":
        return [], [], "pdf", (data, "application/pdf")
    if ext in (".ppt", ".doc"):
        raise ExtractError(f"Old {ext} format isn't supported. Open it in PowerPoint/Word and Save As .{ext[1:]}x or PDF.")
    if ext in (".pptx", ".ppsx", ".docx"):
        try:
            z = zipfile.ZipFile(io.BytesIO(data))
        except zipfile.BadZipFile:
            raise ExtractError("File is corrupted or not a real Office file")
        (_docx if ext == ".docx" else _pptx)(z, c)
        if not c.parts:
            raise ExtractError("No readable content found in file")
        return c.parts, c.visuals, ext[1:], None
    if ext in IMG_MIME:
        c.image(data, ext, "the uploaded image", force=True)
        return c.parts, c.visuals, "image", None
    if ext in TEXT_EXT:
        txt = data.decode("utf-8", "ignore")
        if ext in (".html", ".htm"):
            txt = re.sub(r"<script.*?</script>|<style.*?</style>", "", txt, flags=re.S)
            txt = re.sub(r"<[^>]+>", " ", txt)
        c.text(txt)
        return c.parts, [], "text", None
    raise ExtractError(f"Unsupported file type {ext}. Use PDF, PPTX, DOCX, images, or TXT.")
