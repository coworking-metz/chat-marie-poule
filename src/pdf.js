// Export PDF d'une conversation, généré en mémoire (rien n'est écrit sur disque ni journalisé).
import PDFDocument from "pdfkit";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LOGO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "logo.png");
export const PDF_MAX_MESSAGES = 40;
export const PDF_MAX_CHARS = 6000;
const INK = "#1a1e26", GREY = "#6b7080", GOLD = "#a87a10", BLUE = "#1a4fa0";

/** Valide le corps de POST /api/pdf : { messages:[{role,content}] } -> messages propres, ou { error }. */
export function cleanPdfMessages(body) {
  const input = body?.messages;
  if (!Array.isArray(input) || input.length === 0) return { error: "Aucun message." };
  if (input.length > PDF_MAX_MESSAGES) return { error: `Conversation trop longue (${PDF_MAX_MESSAGES} messages maximum).` };
  const messages = [];
  for (const m of input) {
    if ((m?.role !== "user" && m?.role !== "assistant") || typeof m.content !== "string") return { error: "Message invalide." };
    const content = m.content.trim().slice(0, PDF_MAX_CHARS);
    if (content) messages.push({ role: m.role, content });
  }
  return messages.length ? { messages } : { error: "Aucun message." };
}

// Caractères représentables par les polices standard du PDF (WinAnsi) ; le reste (emojis, etc.) est retiré proprement.
const WIN_EXTRA = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";
export function pdfSafe(s) {
  return String(s)
    .replace(/[    ]/g, " ")
    .replace(/[​-‏︎️⁠]/g, "")
    .replace(/\r/g, "")
    .split("")
    .filter((c) => c === "\n" || (c >= " " && c <= "~") || (c >= "¡" && c <= "ÿ") || WIN_EXTRA.includes(c))
    .join("")
    .replace(/ {2,}/g, " ");
}

/** Texte inline Markdown léger -> morceaux { t, bold, italic, link }. */
export function inlineRuns(s) {
  const runs = [];
  const re = /\*\*(.+?)\*\*|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s)<]+[^\s).,;:!?<])|(?:^|(?<=[\s(]))\*(?!\s)(.+?)\*(?=[\s).,;:!?]|$)/g;
  let last = 0, m;
  const push = (t, o = {}) => t && runs.push({ t, ...o });
  while ((m = re.exec(s))) {
    push(s.slice(last, m.index));
    if (m[1] !== undefined) push(m[1], { bold: true });
    else if (m[3] !== undefined) { push(m[2], { link: m[3] }); push(` (${m[3]})`, { url: m[3] }); }
    else if (m[4] !== undefined) push(m[4], { link: m[4], url: m[4] });
    else push(m[5], { italic: true });
    last = m.index + m[0].length;
  }
  push(s.slice(last));
  return runs;
}

const fmtDate = (d) => new Intl.DateTimeFormat("fr-FR", { dateStyle: "long", timeStyle: "short", timeZone: "Europe/Paris" }).format(d);

/** Génère le PDF ; renvoie une Promise<Buffer>. */
export function conversationPdf(messages, date = new Date()) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margins: { top: 56, bottom: 64, left: 56, right: 56 }, bufferPages: true,
      info: { Title: "Conversation avec Marie-Poule — Coworking Metz", Author: "Marie-Poule (IA)", Creator: "Marie-Poule" } });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    const x0 = doc.page.margins.left, W = doc.page.width - x0 - doc.page.margins.right;
    const R = "Helvetica", B = "Helvetica-Bold", I = "Helvetica-Oblique", BI = "Helvetica-BoldOblique";

    // En-tête
    let top = doc.y;
    try { if (fs.existsSync(LOGO)) { doc.image(LOGO, x0, top, { width: 130 }); top += 130 * 430 / 1280 + 14; } } catch { /* logo illisible : on continue sans */ }
    doc.x = x0; doc.y = top;
    doc.font(B).fontSize(16).fillColor(INK).text("Conversation avec Marie-Poule — Coworking Metz", x0, doc.y, { width: W });
    doc.font(R).fontSize(10).fillColor(GREY).text(`Générée le ${fmtDate(date)}`, x0, doc.y + 2, { width: W });
    doc.moveTo(x0, doc.y + 10).lineTo(x0 + W, doc.y + 10).lineWidth(1.5).strokeColor("#eab234").stroke();
    doc.y += 24;

    const writeRuns = (runs, opts) => {
      const list = runs.length ? runs : [{ t: " " }];
      list.forEach((r, i) => {
        const font = r.bold && r.italic ? BI : r.bold ? B : r.italic ? I : R;
        const isLink = Boolean(r.link);
        doc.font(r.url && !r.link ? R : font).fontSize(r.url && !r.link ? 8.5 : 10.5)
          .fillColor(isLink ? BLUE : r.url ? GREY : INK)
          .text(r.t, { ...opts, continued: i < list.length - 1, link: r.link, underline: isLink, lineGap: 2 });
      });
    };

    for (const m of messages) {
      if (doc.y > doc.page.height - doc.page.margins.bottom - 70) doc.addPage();
      doc.x = x0;
      doc.font(B).fontSize(10.5).fillColor(m.role === "user" ? INK : GOLD).text(m.role === "user" ? "Vous" : "Marie-Poule", x0, doc.y, { width: W });
      doc.moveDown(0.2);
      for (const raw of pdfSafe(m.content).split("\n")) {
        const line = raw.trimEnd();
        if (!line.trim()) { doc.moveDown(0.3); continue; }
        const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
        if (bullet) {
          const y = doc.y;
          doc.font(R).fontSize(10.5).fillColor(INK).text("•", x0 + 6, y, { lineBreak: false });
          doc.x = x0 + 20; doc.y = y;
          writeRuns(inlineRuns(bullet[1]), { width: W - 20 });
          doc.x = x0;
        } else {
          const head = /^#{1,6}\s+(.*)$/.exec(line);
          writeRuns(head ? [{ t: head[1], bold: true }] : inlineRuns(line), { width: W });
        }
        doc.moveDown(0.15);
      }
      doc.moveDown(0.9);
    }

    // Pied de page et numéros sur toutes les pages
    const { start, count } = doc.bufferedPageRange();
    for (let i = start; i < start + count; i++) {
      doc.switchToPage(i);
      const bottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0; // évite un saut de page en écrivant dans la marge
      const y = doc.page.height - 44;
      doc.font(R).fontSize(8).fillColor(GREY)
        .text("Réponses générées par une IA, susceptibles d'erreurs — www.coworking-metz.fr", x0, y, { width: W - 60, lineBreak: false, link: "https://www.coworking-metz.fr/" })
        .text(`${i + 1} / ${count}`, x0 + W - 50, y, { width: 50, align: "right", lineBreak: false });
      doc.page.margins.bottom = bottom;
    }
    doc.end();
  });
}
