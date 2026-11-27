#!/usr/bin/env python3
"""
Lit docs/sitemap.url, parcourt le sitemap (index -> sous-sitemaps -> pages) et enregistre le texte de chaque page
dans extracted/web/<chemin>.txt, plus extracted/web/_pages.json (inventaire). Bibliothèque standard uniquement.
Politesse : un User-Agent explicite et une pause entre les requêtes.
"""
import json, os, re, subprocess, sys, time, urllib.request, urllib.error, urllib.parse
import xml.etree.ElementTree as ET
from html.parser import HTMLParser

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "extracted", "web")
UA = "Mozilla/5.0 (compatible; MariePouleCrawler/0.1; +https://www.coworking-metz.fr/)"
PAUSE = 0.6
NS = "{http://www.sitemaps.org/schemas/sitemap/0.9}"


def get(url, binary=False, tries=4):
    """Télécharge via curl (mieux toléré que urllib par le CDN du site), avec nouvelles tentatives."""
    last = None
    for k in range(tries):
        p = subprocess.run(
            ["curl", "-sL", "--max-time", "45", "-A", UA, "-H", "Accept-Language: fr", "-w", "\n%{http_code}\n%{content_type}", url],
            capture_output=True,
        )
        raw = p.stdout
        try:
            body, code, ctype = raw.rsplit(b"\n", 2)
        except ValueError:
            last = f"curl rc={p.returncode}"
            time.sleep(2 * (k + 1))
            continue
        if code.strip() == b"200":
            ctype = ctype.decode("latin-1")
            return (body if binary else body.decode("utf-8", "replace")), ctype
        last = f"HTTP {code.decode('latin-1')}"
        time.sleep(2 * (k + 1))
    raise RuntimeError(f"échec après {tries} essais : {last}")


def sitemap_urls(url, seen):
    """Retourne [(url_page, lastmod, sitemap_source)] en descendant dans les sous-sitemaps."""
    if url in seen:
        return []
    seen.add(url)
    xml, _ = get(url)
    time.sleep(PAUSE)
    root = ET.fromstring(xml.encode("utf-8"))
    res = []
    if root.tag == NS + "sitemapindex":
        for sm in root.findall(NS + "sitemap"):
            res += sitemap_urls(sm.find(NS + "loc").text.strip(), seen)
    else:
        for u in root.findall(NS + "url"):
            loc = u.find(NS + "loc").text.strip()
            lm = u.find(NS + "lastmod")
            res.append((loc, lm.text.strip() if lm is not None and lm.text else "", url))
    return res


SKIP = {"script", "style", "noscript", "svg", "nav", "header", "footer", "aside", "form", "iframe", "button", "select", "template"}
BLOCK = {"p", "div", "section", "article", "li", "tr", "br", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "table", "blockquote", "dt", "dd", "figcaption"}
JUNK_CLASS = re.compile(r"cookie|cmp|consent|breadcrumb|notification|brevo|share|skip|screen-reader|menu|sidebar|related|comment|cart|woocommerce-(?:breadcrumb|result|ordering)")


class Extract(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.skip = 0
        self.stack = []
        self.out = []
        self.title = ""
        self.meta = {}
        self.in_title = False
        self.main_depth = None
        self.have_main = False
        self.buf_all = []
        self.href = None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "title":
            self.in_title = True
        if tag == "meta":
            k = a.get("name") or a.get("property")
            if k and a.get("content"):
                self.meta[k] = a["content"]
        junk = bool(JUNK_CLASS.search((a.get("class") or "") + " " + (a.get("id") or "")))
        skip_here = tag in SKIP or (junk and tag not in ("body", "html", "main", "article"))
        if tag not in ("br", "img", "meta", "link", "input", "hr", "source"):
            self.stack.append(skip_here)
            if skip_here:
                self.skip += 1
        if self.skip:
            return
        if tag in ("h1", "h2", "h3", "h4"):
            self.out.append("\n" + "#" * int(tag[1]) + " ")
        elif tag == "li":
            self.out.append("\n- ")
        elif tag in BLOCK:
            self.out.append("\n")
        if tag == "a" and a.get("href", "").startswith(("http", "/")):
            self.href = a["href"]
        if tag == "img" and a.get("alt"):
            self.out.append(f" [image : {a['alt'].strip()}] ")

    def handle_endtag(self, tag):
        if tag == "title":
            self.in_title = False
        if tag in ("br", "img", "meta", "link", "input", "hr", "source"):
            return
        if self.stack:
            if self.stack.pop():
                self.skip -= 1
        if tag == "a":
            self.href = None
        if not self.skip and tag in BLOCK:
            self.out.append("\n")

    def handle_data(self, data):
        if self.in_title:
            self.title += data
        if self.skip:
            return
        t = data.replace("\xa0", " ")
        if t.strip():
            if self.href and not self.href.startswith("#"):
                t = f"[{t.strip()}]({self.href}) "
            self.out.append(t)

    def text(self):
        raw = "".join(self.out)
        lines = [re.sub(r"[ \t]+", " ", l).strip() for l in raw.split("\n")]
        res, prev = [], None
        for l in lines:
            if l and l != prev and l != "-":
                res.append(l)
            prev = l if l else prev
        return "\n".join(res)


def slug_for(url):
    p = urllib.parse.urlparse(url)
    s = (p.path.strip("/") or "accueil")
    return re.sub(r"[^A-Za-z0-9/_\-.]", "_", s)


def main():
    os.makedirs(OUT, exist_ok=True)
    raw = open(os.path.join(ROOT, "docs", "sitemap.url"), encoding="utf-8", errors="replace").read()
    start = re.search(r"https?://\S+", raw).group(0)
    print("sitemap racine :", start)
    pages = sitemap_urls(start, set())
    print("URLs listées :", len(pages))
    inventory = []
    for i, (url, lastmod, src) in enumerate(pages, 1):
        rec = {"url": url, "lastmod": lastmod, "sitemap": src.rsplit("/", 1)[-1], "status": ""}
        try:
            body, ctype = get(url, binary=True)
            time.sleep(PAUSE)
            dest = os.path.join(OUT, slug_for(url))
            if "pdf" in ctype.lower() or url.lower().endswith(".pdf"):
                os.makedirs(os.path.dirname(dest + ".pdf") or OUT, exist_ok=True)
                open(dest + ".pdf", "wb").write(body)
                text = subprocess.run(["pdftotext", "-layout", dest + ".pdf", "-"], capture_output=True).stdout.decode("utf-8", "replace")
                title, meta = os.path.basename(url), {}
                os.remove(dest + ".pdf")
            elif "html" in ctype.lower():
                html = body.decode("utf-8", "replace")
                ex = Extract()
                ex.feed(html)
                text, title, meta = ex.text(), ex.title.strip(), ex.meta
            else:
                rec["status"] = "non-texte:" + ctype[:30]
                inventory.append(rec)
                continue
            head = [f"URL : {url}", f"Titre : {title}"]
            if meta.get("description"):
                head.append("Description : " + meta["description"])
            if lastmod:
                head.append("Dernière modification : " + lastmod)
            os.makedirs(os.path.dirname(dest + ".txt"), exist_ok=True)
            open(dest + ".txt", "w", encoding="utf-8").write("\n".join(head) + "\n\n" + text + "\n")
            rec.update(status="ok", title=title, chars=len(text), file=os.path.relpath(dest + ".txt", ROOT))
        except Exception as e:
            rec.update(status="erreur", error=f"{type(e).__name__}: {e}"[:160])
        inventory.append(rec)
        print(f"[{i}/{len(pages)}] {rec['status']:8} {url}")
    json.dump(inventory, open(os.path.join(OUT, "_pages.json"), "w"), ensure_ascii=False, indent=1)
    from collections import Counter
    print(dict(Counter(r["status"].split(":")[0] for r in inventory)), "caractères:", sum(r.get("chars", 0) for r in inventory))


if __name__ == "__main__":
    sys.exit(main())
