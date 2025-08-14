// functions/index.js
const { onRequest } = require("firebase-functions/v2/https");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");
const pdfParse = require("pdf-parse");

admin.initializeApp();

/** ============================================
 *  CONFIG
 *  ============================================ */
const genAI = new GoogleGenerativeAI("AIzaSyCr4iFChsKJmvN92nNHq1xX97XFDy-cuxk");

// Activa scraping si quieres sumar el sitio. (true/false)
const ENABLE_WEB_SOURCES = true;

const EXTRA_DOCS = [
  { file: "Practica_Profesional.pdf", label: "Practica Profesional Supervisada (PPS)" },
  { file: "DEC-010-A Política para las clases virtuales e hibridas.pdf", label: "Politica clases virtuales e hibridas (DEC-010) camara" },
  { file: "SolicituddePracticaProfesional2023.docx", label: "Solicitud de Practica Profesional (PPS)" },
  { file: "Politicadeusodecamara.docx", label: "Politica de uso de camara" }   // <-- NUEVO
];


// Boletines / comunicados internos con OVERRIDES (PRIORIDAD sobre otras fuentes)
const BULLETINS = [
  {
    title: "Convocatoria PPS 2025Q3",
    text: "Periodo abierto para recepcion de solicitudes de Practica Profesional Supervisada. Fecha limite: lunes 01 de septiembre de 2025. Solicitudes posteriores se evaluan caso por caso. La PPS es requisito de graduacion; conlleva la matricula de un curso con sesiones semanales durante el cuatrimestre y el desarrollo del TFG. La PPS no se puede convalidar. Si ya trabaja, debe solicitar igualmente para evaluar aplicabilidad de la posicion. Para PPS en tercer cuatrimestre, el/la estudiante debe estar laborando a mas tardar el lunes 01 de septiembre de 2025; si inicia despues, debe comunicarlo para valorar.",
    source: "Comunicado oficial (correo)",
    date: "2025-09-01"
  }
];

/** ============================================
 *  ESTADO / RUTAS
 *  ============================================ */
let reglamentoText = null;
let ragIndex = null;
const DATA_DIR   = path.join(__dirname, "data");
const INDEX_PATH = path.join(DATA_DIR, "index.json");

/** ============================================
 *  CARGA DE PDF / DOCX
 *  ============================================ */
async function loadReglamento() {
  if (reglamentoText) return reglamentoText;
  const pdfPath = path.join(__dirname, "Reglamento.pdf");
  if (!fs.existsSync(pdfPath)) {
    console.error("No existe Reglamento.pdf en:", pdfPath);
    reglamentoText = "Error: no se encontro el reglamento.";
    return reglamentoText;
  }
  const data = await pdfParse(fs.readFileSync(pdfPath));
  reglamentoText = (data.text || "").replace(/\u0000/g, "");
  return reglamentoText;
}

async function loadPdfLocal(fileName) {
  const p = path.join(__dirname, fileName);
  if (!fs.existsSync(p)) {
    console.warn("No existe PDF:", p);
    return "";
  }
  const data = await pdfParse(fs.readFileSync(p));
  return (data.text || "").replace(/\u0000/g, "");
}

async function loadDocxLocal(fileName) {
  const p = path.join(__dirname, fileName);
  if (!fs.existsSync(p)) {
    console.warn("No existe DOCX:", p);
    return "";
  }
  // Lazy require para no crashear si no lo instalaste
  const mammoth = require("mammoth");
  const { value } = await mammoth.extractRawText({ path: p });
  return (value || "").replace(/\s{2,}/g, " ").trim();
}

/** ============================================
 *  CHUNKING
 *  ============================================ */
function chunkReglamento(text) {
  const parts = [];
  const re = /(Articulo\s+\d+[^\n:.]*[:.]?)|(Artículo\s+\d+[^\n:.]*[:.]?)/ig;
  let m, lastIdx = 0, currentTitle = "Seccion";

  while ((m = re.exec(text)) !== null) {
    const start = m.index;
    if (start > lastIdx) {
      const chunk = text.slice(lastIdx, start).trim();
      if (chunk) parts.push({ article: currentTitle, text: chunk, source: "Reglamento" });
    }
    currentTitle = (m[1] || m[2] || "Articulo").replace(/\s+/g, " ").trim();
    lastIdx = start + (m[1] ? m[1].length : m[2].length);
  }
  const tail = text.slice(lastIdx).trim();
  if (tail) parts.push({ article: currentTitle, text: tail, source: "Reglamento" });

  if (!parts.length) {
    for (let i = 0; i < text.length; i += 1200) {
      parts.push({ article: "Seccion", text: text.slice(i, i + 1200), source: "Reglamento" });
    }
  }
  return parts
    .map((p, i) => ({
      id: i + 1,
      article: p.article,
      text: p.text.replace(/\s{2,}/g, " ").slice(0, 1800),
      source: p.source,
    }))
    .filter(p => p.text.length > 80);
}

function chunkGeneric(text, sourceLabel) {
  const clean = text.replace(/\s{2,}/g, " ").trim();
  if (!clean) return [];
  const chunks = [];
  const maxLen = 1600;
  const paras = clean.split(/\n{2,}|\r{2,}/);
  let buf = "";
  for (const p of paras) {
    if ((buf + " " + p).length > maxLen && buf) {
      chunks.push(buf.trim());
      buf = p;
    } else {
      buf += (buf ? " " : "") + p;
    }
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks
    .map((t, i) => ({
      id: 5000 + i,
      article: sourceLabel,
      text: t.slice(0, 1800),
      source: sourceLabel
    }))
    .filter(c => c.text.length > 80);
}

/** ============================================
 *  (OPCIONAL) SCRAPER WEB
 *  ============================================ */
async function fetchHTML(url) {
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.text();
}
function extractQAsFromFAQ(html, label) {
  const cheerio = require("cheerio");
  const $ = cheerio.load(html);
  $("script, style, noscript, iframe, svg").remove();
  const blocks = [];
  const headings = $("h2, h3");
  headings.each((_, el) => {
    const title = $(el).text().trim();
    if (!title || /preguntas frecuentes/i.test(title)) return;
    const paras = [];
    let sib = $(el).next();
    while (sib.length && !/^h[23]$/i.test(sib[0].tagName)) {
      if (sib.is("p, li, ul, ol")) {
        const t = sib.text().replace(/\s{2,}/g, " ").trim();
        if (t) paras.push(t);
      }
      sib = sib.next();
    }
    const answer = paras.join(" ").trim();
    if (answer) blocks.push({ article: `FAQ: ${title}`, text: answer.slice(0, 1800), source: label });
  });
  const bigText = $("main, article, .entry-content, body").text().replace(/\s{2,}/g, " ").trim();
  if (!blocks.length && bigText.length > 160) {
    blocks.push({ article: `${label}`, text: bigText.slice(0, 1800), source: label });
  }
  // dedup
  const seen = new Set();
  const unique = [];
  for (const c of blocks) {
    const key = (c.article + "::" + c.text).toLowerCase();
    if (!seen.has(key)) { seen.add(key); unique.push(c); }
  }
  return unique;
}
async function scrapeOfficialFAQs() {
  if (!ENABLE_WEB_SOURCES) return [];
  const FAQ_SOURCES = [
    { url: "https://ulead.ac.cr/faq/",             label: "FAQ general" },
    { url: "https://ulead.ac.cr/bachilleratos/",   label: "Bachilleratos · FAQ" },
    { url: "https://ulead.ac.cr/maestrias/",       label: "Maestrias · FAQ" },
    { url: "https://ulead.ac.cr/especialidades/",  label: "Especialidades · FAQ" },
    { url: "https://ulead.ac.cr/admision-y-becas/",label: "Admision y Becas" }
  ];
  const out = [];
  for (const { url, label } of FAQ_SOURCES) {
    try {
      const html = await fetchHTML(url);
      out.push(...extractQAsFromFAQ(html, label));
    } catch (e) {
      console.warn("No se pudo scrapear:", label, url, e.message);
    }
  }
  return out.map((c, i) => ({ id: 10_000 + i, ...c }));
}

/** ============================================
 *  EMBEDDINGS / SIMILITUD / MMR
 *  ============================================ */
async function embedText(text) {
  const model = genAI.getGenerativeModel({ model: "text-embedding-004" });
  const res = await model.embedContent({ content: { parts: [{ text }] } });
  return res.embedding?.values || [];
}
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return (na && nb) ? dot / (Math.sqrt(na)*Math.sqrt(nb)) : 0;
}
function expandQueries(q) {
  const qs = new Set([q]);
  const lower = q.toLowerCase();
  if (/(aprue|aprob|nota|minim|escala|calific)/.test(lower)) {
    qs.add(`${q} (nota minima para aprobar, escala de calificaciones, letras A B C D F)`);
  }
  if (/(aplazad|recuperaci|examen extraordinario| d\b)/.test(lower)) {
    qs.add(`${q} (aplazado, prueba de recuperacion, nota final C-)`);
  }
  if (/(credito|carga|matricul|retiro|beca|apelaci|duracion|modalidad|horario|ubicacion|practica)/.test(lower)) {
    qs.add(`${q} (articulos relevantes, requisitos, plazos, datos operativos oficiales)`);
  }
  return Array.from(qs).slice(0, 4);
}

// Boost hacia fuentes específicas según el tema
function sourceBoost(query, srcLabel = "") {
  const q = (query || "").toLowerCase();
  const s = (srcLabel || "").toLowerCase();

  const isProgramInfo = /(duraci[oó]n|duracion|modalidad|modalidades|bachillerato|maestr[ií]a|maestria|especialidad)/i.test(q);
  const isPPS        = /(pr[aá]ctica|practica|pps|solicitud|fecha\s*l[ií]mite|fecha\s*limite)/i.test(q);
  const isCamera     = /(c[aá]mara|camara|video|zoom|encender\s*camara)/i.test(q);

  if (isProgramInfo && /(faq|sitio|bachilleratos|maestrias|especialidades|admision)/i.test(s)) {
    return 0.08;
  }
  if (isPPS && /(boletin|comunicado|pps|solicitud de practica|solicitud de pr[aá]ctica|practica profesional)/i.test(s)) {
    return 0.12;
  }
  if (isCamera && /(camara|politica.*camara|dec-010|clases virtuales|hibridas)/i.test(s)) {
    return 0.12; // prioriza políticas de cámara
  }
  return 0;
}


function mmrSelect(candidates, queryEmb, k = 6, lambda = 0.7) {
  const selected = [];
  const rest = candidates.map(c => ({ ...c }));
  while (selected.length < k && rest.length) {
    let best = null, bestScore = -Infinity;
    for (const c of rest) {
      const sim = cosine(c.embedding, queryEmb);
      let div = 0;
      for (const s of selected) div = Math.max(div, cosine(c.embedding, s.embedding));
      const score = lambda * sim - (1 - lambda) * div;
      if (score > bestScore) { bestScore = score; best = c; }
    }
    selected.push(best);
    const idx = rest.findIndex(x => x.id === best.id);
    if (idx >= 0) rest.splice(idx, 1);
  }
  return selected
    .map(c => ({ ...c, score: cosine(c.embedding, queryEmb) }))
    .sort((a, b) => b.score - a.score);
}

/** ============================================
 *  ÍNDICE RAG
 *  ============================================ */
function loadIndexFromDisk() {
  if (ragIndex) return true;
  if (fs.existsSync(INDEX_PATH)) {
    try {
      ragIndex = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8"));
      return true;
    } catch {
      console.warn("No se pudo leer index.json; se reconstruira.");
    }
  }
  return false;
}

async function buildIndex() {
  const out = [];

  // 1) Reglamento
  const reglText = await loadReglamento();
  const reglChunks = chunkReglamento(reglText);
  for (const c of reglChunks) {
    const emb = await embedText(`${c.article}\n${c.text}`);
    out.push({ ...c, embedding: emb });
  }

  // 2) Docs adicionales: PDF/DOCX
  for (const doc of EXTRA_DOCS) {
    const ext = path.extname(doc.file).toLowerCase();
    let raw = "";
    if (ext === ".pdf") raw = await loadPdfLocal(doc.file);
    else if (ext === ".docx") raw = await loadDocxLocal(doc.file);
    else {
      console.warn("Tipo de archivo no soportado:", doc.file);
      continue;
    }
    if (!raw) continue;
    const chunks = chunkGeneric(raw, doc.label);
    for (const c of chunks) {
      const emb = await embedText(`${c.article}\n${c.text}`);
      out.push({ ...c, embedding: emb });
    }
  }

  // 3) Boletines (OVERRIDES)
  for (const b of BULLETINS) {
    const emb = await embedText(`${b.title}\n${b.text}`);
    out.push({
      id: 990000 + out.length,
      article: b.title,
      text: b.text.slice(0, 1800),
      source: `Boletin / ${b.source} (${b.date})`,
      embedding: emb
    });
  }

  // 4) (Opcional) sitio web
  const webChunks = await scrapeOfficialFAQs();
  for (const c of webChunks) {
    const emb = await embedText(`${c.article}\n${c.text}`);
    out.push({ ...c, embedding: emb });
  }

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
  fs.writeFileSync(INDEX_PATH, JSON.stringify(out));
  ragIndex = out;
  console.log(`Indice listo: ${out.length} chunks`);
}

async function ensureIndex() {
  if (ragIndex) return;
  if (loadIndexFromDisk()) return;
  await buildIndex();
}

async function searchRelevant(query, k = 6) {
  await ensureIndex();
  const qEmbMain = await embedText(query);
  const alts = expandQueries(query);
  const pool = new Map();

  for (const alt of alts) {
    const qEmb = alt === query ? qEmbMain : await embedText(alt);
    ragIndex.forEach(c => {
      const base = cosine(qEmb, c.embedding);
      const boost = sourceBoost(query, c.source || c.article || "");
      const score = base + boost;
      const prev = pool.get(c.id);
      if (!prev || score > prev.score) pool.set(c.id, { ...c, score });
    });
  }
  const candidates = Array.from(pool.values()).sort((a, b) => b.score - a.score).slice(0, 30);
  return mmrSelect(candidates, qEmbMain, k, 0.7);
}

/** ============================================
 *  PROMPT JSON + OVERRIDES
 *  ============================================ */
function buildOverridesBlock() {
  if (!BULLETINS || !BULLETINS.length) return "";
  const lines = BULLETINS.map(b =>
    `- ${b.title} (${b.date}): ${b.text}`
  );
  return `\nACTUALIZACIONES OFICIALES (PRIORITARIAS SI CONTRADICEN OTRAS FUENTES):\n${lines.join("\n")}\n`;
}

function buildJsonPrompt(contexts, pregunta) {
  const ctx = contexts.map((c, i) =>
    `#${i+1} [${c.source}] (${c.article})\n${c.text}`).join("\n\n");

  const overrides = buildOverridesBlock();

  return `
Eres un asistente de Lead University.
Responde SOLO con base en los CONTEXTOS y en las ACTUALIZACIONES OFICIALES (si existen).
Si la pregunta es informativa/operativa (p.ej., fechas, convocatorias, PPS), PRIORIZA las ACTUALIZACIONES OFICIALES.
Si es normativa (evaluaciones, aplazados, apelaciones), PRIORIZA el REGLAMENTO.
Si hay conflicto entre documentos, las ACTUALIZACIONES OFICIALES tienen prioridad.

CONTEXTOS:
${ctx}
${overrides}

PREGUNTA:
${pregunta}

DEVUELVE SOLO JSON (sin markdown ni texto adicional):
{
  "answer": "respuesta clara y breve (max ~120 palabras). Cita 'Art. X' si aplica o 'Boletin' si viene del comunicado.",
  "examples": [
    { "type": "table", "title": "Titulo", "columns": ["Col 1","Col 2"], "rows": [["v11","v12"],["v21","v22"]] },
    { "type": "steps", "title": "Pasos para ...", "items": ["Paso 1","Paso 2","Paso 3"] }
  ],
  "refs": [ { "article": "Art. 12", "summary": "…" } ]
}
`;
}

function parseModelJSON(raw) {
  if (!raw || typeof raw !== "string") return null;
  let s = raw.replace(/^\uFEFF/, "").trim();
  s = s.replace(/^```[a-z]*\s*/i, "").replace(/```$/i, "").trim();
  if (s.startsWith("{") && s.endsWith("}")) {
    try { return JSON.parse(s); } catch {}
  }
  let start = s.indexOf("{");
  while (start !== -1) {
    let depth = 0;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      if (depth === 0) {
        const candidate = s.slice(start, i + 1);
        try { return JSON.parse(candidate); } catch {}
        break;
      }
    }
    start = s.indexOf("{", start + 1);
  }
  return null;
}

/** ============================================
 *  ENDPOINTS
 *  ============================================ */
exports.consultarReglamento = onRequest(async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).send("");

  try {
    const { pregunta } = req.body?.data || req.body || {};
    if (!pregunta || typeof pregunta !== "string") {
      return res.json({ success: false, error: "Pregunta requerida" });
    }
    const contexts = await searchRelevant(pregunta, 6);
    const prompt   = buildJsonPrompt(contexts, pregunta);
    const model    = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const result   = await model.generateContent(prompt);
    const raw      = await result.response.text();
    const parsed   = parseModelJSON(raw);

    if (parsed) {
      return res.json({
        success: true,
        answer: parsed.answer || "",
        examples: Array.isArray(parsed.examples) ? parsed.examples : [],
        refs: Array.isArray(parsed.refs) ? parsed.refs : [],
        context: contexts.map(c => ({ source: c.source, article: c.article, snippet: c.text.slice(0, 220) })),
        timestamp: new Date().toISOString()
      });
    }
    return res.json({
      success: true,
      answer: raw,
      examples: [],
      refs: [],
      context: contexts.map(c => ({ source: c.source, article: c.article, snippet: c.text.slice(0, 220) })),
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error("consultarReglamento error:", err);
    return res.json({ success: false, error: err.message || "Error desconocido" });
  }
});

exports.buildIndex = onRequest(async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).send("");
  try {
    await buildIndex();
    return res.json({ ok: true, chunks: ragIndex?.length || 0 });
  } catch (e) {
    console.error("buildIndex error:", e);
    return res.json({ ok: false, error: e.message });
  }
});

exports.getBecasInfo = onRequest(async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).send("");

  try {
    const text   = await loadReglamento();
    const chunks = chunkReglamento(text).filter(c => /beca/i.test(c.text) || /beca/i.test(c.article));
    const seed   = chunks.length ? chunks : chunkReglamento(text).slice(0, 6);
    const prompt = buildJsonPrompt(seed, "Resumen visual de becas (tipos, requisitos, porcentajes, proceso)");
    const model  = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const result = await model.generateContent(prompt);
    const raw    = await result.response.text();
    const parsed = parseModelJSON(raw);

    return res.json(parsed ? { success: true, ...parsed } : { success: true, answer: raw, examples: [], refs: [] });
  } catch (e) {
    console.error("getBecasInfo error:", e);
    return res.json({ success: false, error: e.message });
  }
});
