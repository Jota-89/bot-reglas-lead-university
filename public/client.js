// public/client.js
const form    = document.getElementById('chat-form');
const input   = document.getElementById('user-input');
const output  = document.getElementById('chat-output');
const sendBtn = document.getElementById('send-btn');

function appendMessage(role, text) {
  if (!output) return;
  const row = document.createElement('div');
  row.className = `msg ${role}`;
  row.textContent = text;
  output.appendChild(row);
  output.scrollTop = output.scrollHeight;
}
function appendCard(el) {
  if (!output) return;
  output.appendChild(el);
  output.scrollTop = output.scrollHeight;
}
function setLoading(v) {
  if (!sendBtn) return;
  if (v) { sendBtn.setAttribute('disabled','true'); sendBtn.classList.add('is-loading'); }
  else   { sendBtn.removeAttribute('disabled');      sendBtn.classList.remove('is-loading'); }
}
function endpoints() {
  return {
    rewrite:  "/api/consultar",
    emulator: "http://localhost:5001/demo-bot/us-central1/consultarReglamento",
  };
}
async function enviarPregunta(pregunta) {
  const body = { data: { pregunta } };
  const { rewrite, emulator } = endpoints();
  // 1) mismo origen
  try {
    const r1 = await fetch(rewrite, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body) });
    const ct1 = (r1.headers.get("content-type") || "").toLowerCase();
    if (r1.ok && ct1.includes("application/json")) return r1.json();
  } catch {}
  // 2) emulador
  const r2 = await fetch(emulator, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body) });
  const ct2 = (r2.headers.get("content-type") || "").toLowerCase();
  if (!r2.ok || !ct2.includes("application/json")) {
    const txt = await r2.text().catch(()=> "");
    throw new Error(`Backend error: ${r2.status} ${txt.slice(0,120)}`);
  }
  return r2.json();
}

/* ===== Visualizadores ===== */
function cardWrapper(title) {
  const card = document.createElement('div');
  card.className = 'viz-card';
  if (title) {
    const h = document.createElement('h3');
    h.className = 'viz-title';
    h.textContent = title;
    card.appendChild(h);
  }
  return card;
}
function renderTable(v) {
  const card = cardWrapper(v.title);
  const table = document.createElement('table'); table.className = 'viz-table';
  if (Array.isArray(v.columns)) {
    const thead = document.createElement('thead');
    const tr = document.createElement('tr');
    v.columns.forEach(c => { const th = document.createElement('th'); th.textContent = c; tr.appendChild(th); });
    thead.appendChild(tr); table.appendChild(thead);
  }
  if (Array.isArray(v.rows)) {
    const tbody = document.createElement('tbody');
    v.rows.forEach(r => {
      const tr = document.createElement('tr');
      r.forEach(cell => { const td = document.createElement('td'); td.textContent = String(cell); tr.appendChild(td); });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
  }
  card.appendChild(table);
  return card;
}
function renderSteps(v) {
  const card = cardWrapper(v.title);
  const ol = document.createElement('ol'); ol.className = 'viz-steps';
  (v.items || []).forEach(txt => { const li = document.createElement('li'); li.textContent = txt; ol.appendChild(li); });
  card.appendChild(ol);
  return card;
}
function renderRefs(refs) {
  if (!refs || !refs.length) return null;
  const wrap = document.createElement('div'); wrap.className = 'ref-chips';
  refs.forEach(r => {
    const chip = document.createElement('span');
    chip.className = 'ref-chip';
    chip.textContent = r.article || r.summary || 'Ref';
    chip.title = r.summary || '';
    wrap.appendChild(chip);
  });
  return wrap;
}
function renderExamples(examples) {
  (examples || []).forEach(v => {
    if (v.type === 'table') appendCard(renderTable(v));
    else if (v.type === 'steps') appendCard(renderSteps(v));
  });
}

/* ===== Wire ===== */
function wire() {
  if (!form || !input || !output) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = (input.value || '').trim();
    if (!q) return;

    appendMessage('user', q);
    input.value = '';

    try {
      setLoading(true);
      const data   = await enviarPregunta(q);
      const answer = (data.answer ?? data.result?.respuesta ?? data.respuesta ?? '').trim();
      if (answer) appendMessage('bot', answer);
      renderExamples(data.examples);
      const refsEl = renderRefs(data.refs);
      if (refsEl) appendCard(refsEl);
    } catch (err) {
      console.error(err);
      appendMessage('bot', `Error: ${err.message}`);
    } finally {
      setLoading(false);
      input.focus();
    }
  });
}
document.addEventListener('DOMContentLoaded', wire);
