// 前端：抓取 /api/papers，依使用者選項排序/過濾並渲染卡片
let ALL = [];

const $ = (s) => document.querySelector(s);
const listEl = $('#list');
const statusEl = $('#status');
const metaEl = $('#meta');

function fmtDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

function scoreClass(s) {
  if (s >= 80) return 'hot';
  if (s >= 55) return 'high';
  return '';
}

function render() {
  const sort = $('#sort').value;
  const range = parseInt($('#range').value, 10);
  const q = $('#search').value.trim().toLowerCase();

  let rows = ALL.filter((p) => p.daysOld <= range);
  if (q) {
    rows = rows.filter(
      (p) =>
        (p.title || '').toLowerCase().includes(q) ||
        (p.summary || '').toLowerCase().includes(q)
    );
  }
  rows.sort((a, b) =>
    sort === 'date'
      ? Date.parse(b.published) - Date.parse(a.published)
      : b.score - a.score || Date.parse(b.published) - Date.parse(a.published)
  );

  statusEl.textContent = `符合條件 ${rows.length} 篇`;
  listEl.innerHTML = '';

  for (const p of rows) {
    const card = document.createElement('article');
    card.className = 'card';

    const kwTags = (p.matched || [])
      .slice(0, 6)
      .map((k) => `<span class="tag kw">${k}</span>`)
      .join('');
    const catTags = (p.categories || [])
      .slice(0, 3)
      .map((c) => `<span class="tag">${c}</span>`)
      .join('');

    card.innerHTML = `
      <div class="card-top">
        <h2 class="card-title"><a href="${p.url}" target="_blank" rel="noopener">${p.title}</a></h2>
        <div class="score ${scoreClass(p.score)}"><b>${p.score}</b><small>有料分數</small></div>
      </div>
      <p class="authors">${(p.authors || []).slice(0, 5).join('、')}${
      (p.authors || []).length > 5 ? ' 等' : ''
    }</p>
      <p class="summary clamp">${p.summary || ''}</p>
      <button class="more">展開摘要</button>
      <div class="card-bottom">
        ${kwTags}${catTags}
        <span class="date">${fmtDate(p.published)}（${p.daysOld} 天前）</span>
      </div>
      <div class="links">
        <a href="${p.url}" target="_blank" rel="noopener">arXiv 摘要頁</a>
        <a href="${p.pdf}" target="_blank" rel="noopener">PDF 全文</a>
      </div>
    `;

    const sum = card.querySelector('.summary');
    const moreBtn = card.querySelector('.more');
    moreBtn.addEventListener('click', () => {
      sum.classList.toggle('clamp');
      moreBtn.textContent = sum.classList.contains('clamp') ? '展開摘要' : '收合';
    });

    listEl.appendChild(card);
  }
}

async function load() {
  statusEl.innerHTML = '<span class="spinner"></span>正在從 arXiv 抓取最新論文…';
  listEl.innerHTML = '';
  try {
    const res = await fetch('/api/papers');
    if (!res.ok) throw new Error('伺服器回應 ' + res.status);
    const data = await res.json();
    ALL = data.papers || [];
    metaEl.innerHTML = `共收錄 <b>${data.count}</b> 篇<br>更新於 ${new Date(
      data.generatedAt
    ).toLocaleString('zh-TW')}`;
    render();
  } catch (err) {
    statusEl.textContent = '載入失敗：' + err.message + '（請稍後再試）';
  }
}

['#sort', '#range', '#search'].forEach((s) =>
  $(s).addEventListener('input', render)
);
$('#refresh').addEventListener('click', load);

load();
