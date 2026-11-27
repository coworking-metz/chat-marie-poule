#!/usr/bin/env python3
"""
Extraction du texte brut de ./docs vers ./extracted (une copie .txt par source) + extracted/_inventory.json.
Python 3, bibliothèque standard uniquement (+ pdftotext de poppler pour les PDF).
Les images ne sont pas lues ici : elles sont seulement inventoriées.
"""
import hashlib, json, os, re, shutil, subprocess, sys, zipfile
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "docs")
OUT = os.path.join(ROOT, "extracted")
MAX_ROWS = 20000  # lignes max conservées par feuille de calcul (le surplus est signalé)

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
S = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"


def sha1(path):
    h = hashlib.sha1()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def read_text(path):
    raw = open(path, "rb").read()
    for enc in ("utf-8-sig", "utf-16", "cp1252", "latin-1"):
        try:
            return raw.decode(enc)
        except Exception:
            continue
    return raw.decode("utf-8", "replace")


def docx(path):
    z = zipfile.ZipFile(path)
    names = ["word/document.xml"] + sorted(n for n in z.namelist() if re.match(r"word/(header|footer)\d*\.xml", n))
    out = []
    for n in names:
        if n not in z.namelist():
            continue
        root = ET.fromstring(z.read(n))
        def para(p):
            t = []
            for e in p.iter():
                if e.tag == W + "t":
                    t.append(e.text or "")
                elif e.tag == W + "tab":
                    t.append("\t")
                elif e.tag in (W + "br", W + "cr"):
                    t.append("\n")
            return "".join(t)
        body = root.find(W + "body")
        items = list(body) if body is not None else list(root)
        for el in items:
            if el.tag == W + "p":
                s = para(el).strip()
                if s:
                    out.append(s)
            elif el.tag == W + "tbl":
                for tr in el.iter(W + "tr"):
                    cells = []
                    for tc in tr.findall(W + "tc"):
                        cells.append(" ".join(para(p).strip() for p in tc.iter(W + "p") if para(p).strip()))
                    if any(cells):
                        out.append(" | ".join(cells))
    return "\n".join(out), {}


def pptx(path):
    z = zipfile.ZipFile(path)
    def num(n):
        return int(re.search(r"(\d+)\.xml$", n).group(1))
    slides = sorted((n for n in z.namelist() if re.match(r"ppt/slides/slide\d+\.xml$", n)), key=num)
    notes = {num(n): n for n in z.namelist() if re.match(r"ppt/notesSlides/notesSlide\d+\.xml$", n)}
    out = []
    for i, n in enumerate(slides, 1):
        out.append(f"--- Diapositive {i} ---")
        for p in ET.fromstring(z.read(n)).iter(A + "p"):
            s = "".join(t.text or "" for t in p.iter(A + "t")).strip()
            if s:
                out.append(s)
        if num(n) in notes:
            txt = []
            for p in ET.fromstring(z.read(notes[num(n)])).iter(A + "p"):
                s = "".join(t.text or "" for t in p.iter(A + "t")).strip()
                if s and not s.isdigit():
                    txt.append(s)
            if txt:
                out.append("[Notes] " + " ".join(txt))
    return "\n".join(out), {"slides": len(slides)}


def xlsx(path):
    z = zipfile.ZipFile(path)
    shared = []
    if "xl/sharedStrings.xml" in z.namelist():
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).iter(S + "si"):
            shared.append("".join(t.text or "" for t in si.iter(S + "t")))
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    rels = {r.get("Id"): r.get("Target") for r in ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))}
    out, info, truncated = [], [], False
    for sh in wb.iter(S + "sheet"):
        name = sh.get("name")
        target = rels.get(sh.get(R + "id"), "")
        target = target.lstrip("/")
        member = target if target.startswith("xl/") else "xl/" + target
        if member not in z.namelist():
            continue
        out.append(f"=== Feuille : {name} ===")
        rows = 0
        for _, row in ET.iterparse(z.open(member), events=("end",)):
            if row.tag != S + "row":
                continue
            vals = []
            for c in row.findall(S + "c"):
                t = c.get("t")
                v = c.find(S + "v")
                if t == "s" and v is not None and v.text is not None:
                    val = shared[int(v.text)] if int(v.text) < len(shared) else ""
                elif t == "inlineStr":
                    val = "".join(x.text or "" for x in c.iter(S + "t"))
                elif v is not None and v.text is not None:
                    val = v.text
                else:
                    val = ""
                vals.append(val.replace("\n", " ").replace("\t", " "))
            row.clear()
            while vals and vals[-1] == "":
                vals.pop()
            if not vals:
                continue
            rows += 1
            if rows <= MAX_ROWS:
                out.append("\t".join(vals))
            elif rows == MAX_ROWS + 1:
                out.append(f"[... feuille tronquée après {MAX_ROWS} lignes ...]")
                truncated = True
        info.append(f"{name}:{rows}")
    return "\n".join(out), {"sheets": info, "truncated": truncated}


def odt(path):
    z = zipfile.ZipFile(path)
    T = "{urn:oasis:names:tc:opendocument:xmlns:text:1.0}"
    out = []
    for e in ET.fromstring(z.read("content.xml")).iter():
        if e.tag in (T + "p", T + "h"):
            s = "".join(e.itertext()).strip()
            if s:
                out.append(s)
    return "\n".join(out), {}


def pdf(path):
    p = subprocess.run(["pdftotext", "-layout", path, "-"], capture_output=True, timeout=300)
    text = p.stdout.decode("utf-8", "replace")
    pages = text.count("\f") or 1
    return text.replace("\f", "\n\n"), {"pages": pages}


def plain(path):
    return read_text(path), {}


HANDLERS = {
    "docx": docx, "pptx": pptx, "pptm": pptx, "xlsx": xlsx, "xlsm": xlsx, "odt": odt, "pdf": pdf,
    "csv": plain, "txt": plain, "md": plain, "json": plain, "gform": plain,
}
IMAGES = {"jpg", "jpeg", "png", "heic", "gif", "webp"}


def main():
    os.makedirs(OUT, exist_ok=True)
    inv_path = os.path.join(OUT, "_inventory.json")
    prev = {}
    if os.path.exists(inv_path):
        shutil.copyfile(inv_path, os.path.join(OUT, "_inventory.prev.json"))
        prev = {r["path"]: r.get("sha1") for r in json.load(open(inv_path))}
    inventory = []
    for dirpath, _, files in os.walk(SRC):
        for f in sorted(files):
            full = os.path.join(dirpath, f)
            rel = os.path.relpath(full, SRC)
            ext = f.rsplit(".", 1)[-1].lower() if "." in f else ""
            rec = {"path": rel, "ext": ext, "bytes": os.path.getsize(full), "sha1": sha1(full), "status": "", "chars": 0}
            if f.startswith("~$"):
                rec["status"] = "verrou-office"
            elif ext == "url":
                m = re.search(r"https?://\S+", read_text(full))
                rec.update(status="url", url=m.group(0) if m else "")
            elif ext in IMAGES:
                rec["status"] = "image"
            elif ext in HANDLERS:
                try:
                    text, info = HANDLERS[ext](full)
                    rec.update(info)
                    rec["chars"] = len(text.strip())
                    dest = os.path.join(OUT, rel + ".txt")
                    os.makedirs(os.path.dirname(dest), exist_ok=True)
                    open(dest, "w", encoding="utf-8").write(text)
                    if rec["chars"] == 0:
                        rec["status"] = "vide"
                    elif ext == "pdf" and rec["chars"] < 40 * rec.get("pages", 1):
                        rec["status"] = "scan"
                    else:
                        rec["status"] = "ok"
                except Exception as e:
                    rec.update(status="erreur", error=f"{type(e).__name__}: {e}"[:200])
            else:
                rec["status"] = "format-inconnu"
            inventory.append(rec)
    json.dump(inventory, open(inv_path, "w"), ensure_ascii=False, indent=1)
    if prev:
        now = {r["path"]: r["sha1"] for r in inventory}
        new = sorted(set(now) - set(prev))
        gone = sorted(set(prev) - set(now))
        changed = sorted(p for p in now if p in prev and prev[p] and prev[p] != now[p])
        print(f"Depuis la dernière extraction : {len(new)} nouveau(x), {len(changed)} modifié(s), {len(gone)} supprimé(s)")
        for label, lst in (("NOUVEAU", new), ("MODIFIÉ", changed), ("SUPPRIMÉ", gone)):
            for p in lst[:50]:
                print(f"  {label} {p}")
    # Bilan
    from collections import Counter
    c = Counter((r["status"]) for r in inventory)
    print("fichiers:", len(inventory), dict(c))
    print("caractères extraits:", sum(r["chars"] for r in inventory))
    for st in ("erreur", "vide", "scan", "format-inconnu", "verrou-office"):
        l = [r for r in inventory if r["status"] == st]
        if l:
            print(f"--- {st} ({len(l)})")
            for r in l[:15]:
                print("  ", r["path"], r.get("error", ""))


if __name__ == "__main__":
    sys.exit(main())
