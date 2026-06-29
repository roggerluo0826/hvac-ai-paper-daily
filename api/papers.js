// Vercel Serverless Function — 從 arXiv 抓取「數位孿生 × 空調 × AI」高價值論文並評分
// 零依賴：使用 Node 內建 fetch（Node 18+）與輕量 XML 解析。

// 主題搜尋字串（對應 NotebookLM 歸納的核心研究方向）
const QUERIES = [
  'all:"digital twin" AND (all:HVAC OR all:"building energy")',
  'all:"physics-informed neural network" AND (all:building OR all:HVAC OR all:energy)',
  'all:"reinforcement learning" AND all:HVAC',
  'all:"deep reinforcement learning" AND (all:building OR all:HVAC)',
  'all:"building energy" AND (all:surrogate OR all:"digital twin")',
  'all:"model predictive control" AND (all:HVAC OR all:building)',
  'all:"thermal comfort" AND (all:"reinforcement learning" OR all:"deep learning")',
  'all:"digital twin" AND all:building AND (all:Modelica OR all:EnergyPlus OR all:simulation)',
  'all:"indoor environmental quality" AND all:prediction',
  'all:"physics-informed" AND all:"reinforcement learning"',
];

// 高價值關鍵字權重（NotebookLM 歸納的「有料」特徵）
// 命中於 title 權重 ×2、abstract ×1
const KEYWORD_WEIGHTS = {
  'physics-informed': 6,
  'physics informed': 6,
  'pinn': 6,
  'digital twin': 5,
  'sim-to-real': 5,
  'sim2real': 5,
  'deep reinforcement learning': 5,
  'reinforcement learning': 4,
  'surrogate': 4,
  'pareto': 3,
  'multi-objective': 3,
  'model predictive control': 3,
  'thermal comfort': 3,
  'indoor environmental quality': 3,
  'energy management': 3,
  'building energy': 3,
  'hvac': 3,
  'chiller': 3,
  'modelica': 3,
  'energyplus': 3,
  'fmu': 3,
  'data center': 2,
  'real-time': 2,
  'edge': 2,
  'occupancy': 1,
  'pmv': 2,
};

const ARXIV_ENDPOINT = 'https://export.arxiv.org/api/query';
const MAX_PER_QUERY = 30;

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decodeEntities(m[1]) : '';
}

// 解析 arXiv Atom feed
function parseFeed(xml) {
  const entries = [];
  const re = /<entry>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const idRaw = tag(block, 'id'); // e.g. http://arxiv.org/abs/2501.01234v1
    const idMatch = idRaw.match(/abs\/([^v\s]+)(v\d+)?/);
    const arxivId = idMatch ? idMatch[1] : idRaw;

    const authors = [];
    const are = /<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g;
    let am;
    while ((am = are.exec(block)) !== null) authors.push(decodeEntities(am[1]));

    const cats = [];
    const cre = /<category[^>]*term="([^"]+)"/g;
    let cm;
    while ((cm = cre.exec(block)) !== null) cats.push(cm[1]);

    // PDF / abs 連結
    let absUrl = idRaw.replace('http://', 'https://');

    entries.push({
      id: arxivId,
      title: tag(block, 'title'),
      summary: tag(block, 'summary'),
      authors,
      categories: [...new Set(cats)],
      published: tag(block, 'published'),
      updated: tag(block, 'updated'),
      url: absUrl,
      pdf: `https://arxiv.org/pdf/${arxivId}`,
    });
  }
  return entries;
}

function scorePaper(p) {
  const title = (p.title || '').toLowerCase();
  const abs = (p.summary || '').toLowerCase();
  let score = 0;
  const hits = [];
  for (const [kw, w] of Object.entries(KEYWORD_WEIGHTS)) {
    const inTitle = title.includes(kw);
    const inAbs = abs.includes(kw);
    if (inTitle || inAbs) {
      score += (inTitle ? w * 2 : 0) + (inAbs ? w : 0);
      hits.push(kw);
    }
  }
  // 近期加權：越新分數越高（30 天內遞減加成）
  const days = daysOld(p.published);
  const recency = Math.max(0, 30 - days) * 0.3;
  score += recency;

  p.matched = hits;
  p.rawScore = Math.round(score * 10) / 10;
  return p;
}

function daysOld(iso) {
  if (!iso) return 9999;
  const t = Date.parse(iso);
  if (isNaN(t)) return 9999;
  return (Date.now() - t) / 86400000;
}

async function fetchQuery(q) {
  const url =
    `${ARXIV_ENDPOINT}?search_query=${encodeURIComponent(q)}` +
    `&sortBy=submittedDate&sortOrder=descending&start=0&max_results=${MAX_PER_QUERY}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'hvac-ai-paper-daily/1.0 (research reading list)' },
  });
  if (!res.ok) throw new Error(`arXiv ${res.status}`);
  const xml = await res.text();
  return parseFeed(xml);
}

export default async function handler(req, res) {
  try {
    const results = await Promise.allSettled(QUERIES.map(fetchQuery));
    const byId = new Map();
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      for (const p of r.value) {
        if (!byId.has(p.id)) byId.set(p.id, p);
      }
    }

    let papers = [...byId.values()].map(scorePaper);

    // 正規化為 0-100「有料分數」
    const max = Math.max(1, ...papers.map((p) => p.rawScore));
    papers.forEach((p) => {
      p.score = Math.round((p.rawScore / max) * 100);
      p.daysOld = Math.round(daysOld(p.published));
    });

    // 過濾掉幾乎無關的（分數過低）
    papers = papers.filter((p) => p.rawScore >= 3);
    // 預設依有料分數排序
    papers.sort((a, b) => b.score - a.score || Date.parse(b.published) - Date.parse(a.published));

    // Edge 快取 6 小時，背景更新
    res.setHeader('Cache-Control', 'public, s-maxage=21600, stale-while-revalidate=86400');
    res.status(200).json({
      generatedAt: new Date().toISOString(),
      count: papers.length,
      papers,
    });
  } catch (err) {
    res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
}
