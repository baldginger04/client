// =====================================================================
// pdf-brand.js — shared pieces for the portal's branded PDF downloads
// (Prime Sheet, Compare P&Ls).
//
//   - jsPDF + AutoTable load on first use only, so pages stay light.
//   - Brand band: Bald Ginger logo top-left, client logo top-right, orange rule.
//   - Footer on every page: "Prepared by Bald Ginger … Page x of y".
// Text stays real text (selectable, sharp when printed), not a screenshot.
// =====================================================================
import { loadImageAsPng } from './branding.js';

const JSPDF_SRC = 'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js';
const AUTOTABLE_SRC = 'https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.2/dist/jspdf.plugin.autotable.min.js';

export const PDF_NAVY = [27, 42, 75];
export const PDF_ORANGE = [216, 91, 49];
export const PDF_GREY = [110, 116, 128];
export const PDF_MARGIN = 36;
export { loadImageAsPng };

let pdfLibPromise = null;
function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector('script[data-src="' + src + '"]')) { resolve(); return; }
    const el = document.createElement('script');
    el.src = src; el.async = true; el.dataset.src = src;
    el.onload = () => resolve();
    el.onerror = () => { el.remove(); reject(new Error('Could not load the PDF library — check your connection and try again.')); };
    document.head.appendChild(el);
  });
}

/** Resolves to the jsPDF constructor with AutoTable attached. */
export function ensurePdfLib() {
  if (window.jspdf && window.jspdf.jsPDF && window.jspdf.jsPDF.API.autoTable) return Promise.resolve(window.jspdf.jsPDF);
  if (!pdfLibPromise) {
    pdfLibPromise = loadScriptOnce(JSPDF_SRC)
      .then(() => loadScriptOnce(AUTOTABLE_SRC))
      .then(() => {
        if (!(window.jspdf && window.jspdf.jsPDF && window.jspdf.jsPDF.API.autoTable)) throw new Error('PDF library failed to initialize.');
        return window.jspdf.jsPDF;
      })
      .catch((e) => { pdfLibPromise = null; throw e; });
  }
  return pdfLibPromise;
}

// The Bald Ginger logo in the repo (assets/Bald-Ginger_Color_HORZ.png) is the
// color logo on a solid black background. On a white page that would print as
// a black box, so knock the black out to transparent (soft edges preserved)
// and trim the empty margin. The tagline's white letters sit on the orange
// bar, so they survive. Resolves null if the image can't be loaded.
let bgLogoPromise = null;
export function loadBaldGingerLogo() {
  if (bgLogoPromise) return bgLogoPromise;
  bgLogoPromise = loadImageAsPng(new URL('assets/Bald-Ginger_Color_HORZ.png', document.baseURI).href, 900)
    .then((img) => new Promise((resolve) => {
      if (!img) { resolve(null); return; }
      const el = new Image();
      el.onload = () => {
        try {
          const c = document.createElement('canvas');
          c.width = img.w; c.height = img.h;
          const g = c.getContext('2d');
          g.drawImage(el, 0, 0);
          const d = g.getImageData(0, 0, img.w, img.h); const px = d.data;
          let x0 = img.w, y0 = img.h, x1 = -1, y1 = -1;
          for (let i = 0; i < px.length; i += 4) {
            const a = Math.max(px[i], px[i + 1], px[i + 2]);   // brightness = how far from black
            if (a < 24) { px[i + 3] = 0; continue; }
            // Solid strokes (brightness >= 170) stay fully opaque in their true
            // color; only the anti-aliased edges fade, un-mixed from the black.
            const alpha = Math.min(1, a / 170);
            if (alpha < 1) {
              px[i] = Math.min(255, px[i] / alpha); px[i + 1] = Math.min(255, px[i + 1] / alpha); px[i + 2] = Math.min(255, px[i + 2] / alpha);
            }
            px[i + 3] = Math.round(alpha * 255);
            const p = i / 4, x = p % img.w, y = (p - x) / img.w;
            if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
          }
          if (x1 < 0) { resolve(null); return; }
          g.putImageData(d, 0, 0);
          const w = x1 - x0 + 1, h = y1 - y0 + 1;
          const out = document.createElement('canvas'); out.width = w; out.height = h;
          out.getContext('2d').drawImage(c, x0, y0, w, h, 0, 0, w, h);
          resolve({ dataUrl: out.toDataURL('image/png'), w, h });
        } catch (e) { resolve(null); }
      };
      el.onerror = () => resolve(null);
      el.src = img.dataUrl;
    }))
    .then((r) => { if (!r) bgLogoPromise = null; return r; });
  return bgLogoPromise;
}

/**
 * Brand band + title block at the top of page 1.
 *   title    — big navy line (client name, or report name)
 *   subtitle — orange line under it
 *   note     — small grey line under that (optional)
 *   bgLogo, clientLogo — from loadBaldGingerLogo() / loadImageAsPng(), may be null
 * Returns the y position where content should start.
 */
export function drawBrandHeader(doc, { title, subtitle, note, bgLogo, clientLogo }) {
  const W = doc.internal.pageSize.getWidth();
  const M = PDF_MARGIN;
  const BAND_H = 58;
  if (bgLogo) {
    const h = BAND_H, w = Math.min(bgLogo.w * (h / bgLogo.h), 200);
    doc.addImage(bgLogo.dataUrl, 'PNG', M, M - 6, w, bgLogo.h * (w / bgLogo.w));
  } else {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(15); doc.setTextColor(...PDF_ORANGE);
    doc.text('BALD GINGER', M, M + 22);
  }
  if (clientLogo) {
    const maxW = 160, maxH = BAND_H;
    const k = Math.min(maxW / clientLogo.w, maxH / clientLogo.h);
    const lw = clientLogo.w * k, lh = clientLogo.h * k;
    doc.addImage(clientLogo.dataUrl, 'PNG', W - M - lw, M - 6 + (BAND_H - lh) / 2, lw, lh);
  }
  doc.setDrawColor(...PDF_ORANGE); doc.setLineWidth(1.2);
  doc.line(M, M + BAND_H + 4, W - M, M + BAND_H + 4);

  let y = M + BAND_H + 26;
  doc.setTextColor(...PDF_NAVY);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(17);
  doc.text(doc.splitTextToSize(pdfText(title || ''), W - 2 * M)[0] || '', M, y);
  if (subtitle) {
    y += 17;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(11); doc.setTextColor(...PDF_ORANGE);
    doc.text(doc.splitTextToSize(pdfText(subtitle), W - 2 * M)[0], M, y);
  }
  if (note) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(...PDF_GREY);
    const lines = doc.splitTextToSize(pdfText(note), W - 2 * M).slice(0, 3);
    lines.forEach((ln) => { y += 12; doc.text(ln, M, y); });
  }
  return y + 12;
}

/** Footer on every page. Call after all content is drawn. */
export function drawFooters(doc) {
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight();
  const M = PDF_MARGIN;
  const pages = doc.internal.getNumberOfPages();
  const stamp = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(130, 136, 148);
    doc.text('Prepared by Bald Ginger  ·  Accounting | Finance | Business Ops  ·  Generated ' + stamp, M, H - M + 6);
    doc.text('Page ' + p + ' of ' + pages, W - M, H - M + 6, { align: 'right' });
  }
}

/** The PDF's built-in font has no Unicode minus sign or curly quotes in some
 *  viewers; normalize text that goes into the PDF. */
export function pdfText(s) {
  return String(s == null ? '' : s)
    .replace(/−/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "2026-09", "Casa Bianca", "Prime Sheet" -> 2026-09_Casa_Bianca_Prime_Sheet.pdf */
export function pdfFileName(...parts) {
  const clean = (x) => String(x || '').replace(/[^A-Za-z0-9-]+/g, '_').replace(/^_+|_+$/g, '');
  return parts.map(clean).filter(Boolean).join('_') + '.pdf';
}
