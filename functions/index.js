// functions/index.js
const { onRequest } = require("firebase-functions/v2/https");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");
const pdfParse = require("pdf-parse");

admin.initializeApp();

/** ============================================
 *  CONFIG RÁPIDA
 *  ============================================ */
const genAI = new GoogleGenerativeAI("AIzaSyCr4iFChsKJmvN92nNHq1xX97XFDy-cuxk");

// Si NO quieres usar datos del sitio (solo Reglamento), déjalo en false
const ENABLE_WEB_SOURCES = true;

// Fuentes oficiales (solo si ENABLE_WEB_SOURCES = true)
const FAQ_SOURCES = [
  { url: "https://ulead.ac.cr/faq/",             label: "FAQ general" },
  { url: "https://ulead.ac.cr/bachilleratos/",   label: "Bachilleratos · FAQ" },
  { url: "https://ulead.ac.cr/maestrias/",       label: "Maestrías · FAQ" },
  { url: "https://ulead.ac.cr/especialidades/",  label: "Especialidades · FAQ" },
  { url: "https://ulead.ac.cr/admision-y-becas/",label: "Admisión y Becas" }
];

/** ============================================
 *  ESTADO / RUTAS
 *  ============================================ */
let reglamentoText = null;
let ragIndex = null; // [{id, article, text, embedding, source}]
const DATA_DIR   = path.join(__dirname, "data");
const INDEX_PATH = path.join(DATA_DIR, "index.json");

/** ============================================
 *  UTILIDADES PDF / CHUNKING
 *  ============================================ */
async function loadReglamento() {
  if (reglamentoText) return reglamentoText;
  const pdfPath = path.join(__dirname, "Reglamento.pdf");
  if (!fs.existsSync(pdfPath)) {
    console.error("No existe Reglamento.pdf en:", pdfPath);
    reglamentoText = "Error: no se encontró el reglamento.";
    return reglamentoText;
  }
  const data = await pdfParse(fs.readFileSync(pdfPath));
  reglamentoText = (data.text || "").replace(/\u0000/g, "");
  return reglamentoText;
}

// Divide por “Artículo X” (fallback por longitud si no encuentra títulos)
function chunkReglamento(text) {
  const parts = [];
  const re = /(Artículo\s+\d+[^\n:.]*[:.]?)/ig;
  let m, lastIdx = 0, currentTitle = "Sección";

  while ((m = re.exec(text)) !== null) {
    const start = m.index;
    if (start > lastIdx) {
      const chunk = text.slice(lastIdx, start).trim();
      if (chunk) parts.push({ article: currentTitle, text: chunk, source: "Reglamento" });
    }
    currentTitle = m[1].replace(/\s+/g, " ").trim();
    lastIdx = start + m[0].length;
  }
  const tail = text.slice(lastIdx).trim();
  if (tail) parts.push({ article: currentTitle, text: tail, source: "Reglamento" });

  if (!parts.length) {
    for (let i = 0; i < text.length; i += 1200) {
      parts.push({ article: "Sección", text: text.slice(i, i + 1200), source: "Reglamento" });
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

/** ============================================
 *  SCRAPER (solo si ENABLE_WEB_SOURCES = true)
 *  ============================================ */
async function fetchHTML(url) {
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.text();
}
function extractQAsFromFAQ(html, label) {
  // ⚠️ cargar cheerio SOLO aquí, bajo demanda
  const cheerio = require("cheerio");
  const $ = cheerio.load(html);
  const blocks = [];

  const headings = $("h2, h3");
  headings.each((_, el) => {
    const title = $(el).text().trim();
    if (!title || /preguntas frecuentes/i.test(title)) return;
    const paras = [];
    let sib = $(el).next();
    while (sib.length && !/^h[23]$/i.test(sib[0].tagName)) {
      if (sib.is("p, li, ul, ol")) {
        paras.push(sib.text().replace(/\s{2,}/g, " ").trim());
      }
      sib = sib.next();
    }
    const answer = paras.join(" ").trim();
    if (answer) {
      blocks.push({
        article: `FAQ: ${title}`,
        text: answer.slice(0, 1800),
        source: label,
      });
    }
  });

  if (!blocks.length) {
    const text = $("main, article, .entry-content, body").text().trim().replace(/\s{2,}/g, " ");
    if (text.length > 120) blocks.push({ article: `${label}`, text: text.slice(0, 1800), source: label });
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
    qs.add(`${q} (nota mínima para aprobar, escala de calificaciones, letras A B C D F)`);
  }
  if (/(aplazad|recuperaci|examen extraordinario| D\b)/.test(lower)) {
    qs.add(`${q} (aplazado, prueba de recuperación, nota final C-)`);
  }
  if (/(crédito|carga|matrícul|retiro|beca|apelaci|duración|modalidad|horario|ubicación)/.test(lower)) {
    qs.add(`${q} (artículos relevantes, requisitos, plazos, datos operativos oficiales)`);
  }
  return Array.from(qs).slice(0, 4);
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
      console.warn("No se pudo leer index.json; se reconstruirá.");
    }
  }
  return false;
}
async function buildIndex() {
  const text = await loadReglamento();
  const reglChunks = chunkReglamento(text);
  const out = [];
  // 1) Reglamento
  for (const c of reglChunks) {
    const emb = await embedText(`${c.article}\n${c.text}`);
    out.push({ ...c, embedding: emb });
  }
  // 2) Web oficial (si activado)
  const webChunks = await scrapeOfficialFAQs();
  for (const c of webChunks) {
    const emb = await embedText(`${c.article}\n${c.text}`);
    out.push({ ...c, embedding: emb });
  }
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
  fs.writeFileSync(INDEX_PATH, JSON.stringify(out));
  ragIndex = out;
  console.log(`Índice listo: ${out.length} chunks${ENABLE_WEB_SOURCES ? " (Reglamento + Web)" : ""}`);
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
      const score = cosine(qEmb, c.embedding);
      const prev = pool.get(c.id);
      if (!prev || score > prev.score) pool.set(c.id, { ...c, score });
    });
  }
  const candidates = Array.from(pool.values()).sort((a, b) => b.score - a.score).slice(0, 30);
  return mmrSelect(candidates, qEmbMain, k, 0.7);
}

/** ============================================
 *  PROMPTS + PARSEO ROBUSTO DE JSON
 *  ============================================ */
function buildJsonPrompt(contexts, pregunta) {
  const ctx = contexts.map((c, i) =>
    `#${i+1} [${c.source}] (${c.article})\n${c.text}`).join("\n\n");

  return `
Eres un asistente de Lead University.
Responde SOLO con base en los CONTEXTOS (Reglamento y/o sitio oficial). Si no está, dilo claro.

CONTEXTOS:
${ctx}

PREGUNTA:
${pregunta}

DEVUELVE SOLO JSON (sin markdown ni texto adicional):
{
  "answer": "respuesta clara y breve (máx ~120 palabras). Cita artículos como 'Art. X' cuando aplica. Si es info operativa del sitio, acláralo.",
  "examples": [
    { "type": "table", "title": "Título", "columns": ["Col 1","Col 2"], "rows": [["v11","v12"],["v21","v22"]] },
    { "type": "steps", "title": "Pasos para ...", "items": ["Paso 1","Paso 2","Paso 3"] }
  ],
  "refs": [ { "article": "Art. 12", "summary": "…" } ]
}
`;
}
function parseModelJSON(raw) {
  if (!raw || typeof raw !== "string") return null;
  let s = raw.replace(/^\uFEFF/, "").trim();
  s = s.replace(/^```[a-z]*\s*/i, "").replace(/```$/i, "").trim(); // quita fences
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
    // Fallback si vino texto suelto
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
