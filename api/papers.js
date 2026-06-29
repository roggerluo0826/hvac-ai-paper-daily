// Vercel Serverless Function — 從 arXiv 抓取「數位孿生 × 空調 × AI」高價值論文並評分
// 零依賴：使用 Node 內建 fetch（Node 18+）與輕量 XML 解析。

// 主題搜尋字串：每一條都綁定建築 / HVAC / 冷凍空調 / 數位孿生 領域錨點，
// 避免抓到純機器人、純物理、智慧電網等不相干論文。
const QUERIES = [
  'all:"digital twin" AND (all:HVAC OR all:"building energy" OR all:building)',
  'all:"physics-informed" AND (all:building OR all:HVAC OR all:"thermal comfort")',
  'all:"reinforcement learning" AND (all:HVAC OR all:building OR all:"thermal comfort" OR all:chiller)',
  'all:"deep reinforcement learning" AND (all:building OR all:HVAC)',
  'all:"building energy" AND (all:surrogate OR all:"digital twin" OR all:control OR all:optimization)',
  'all:"model predictive control" AND (all:HVAC OR all:building OR all:"thermal comfort")',
  'all:"thermal comfort" AND (all:"reinforcement learning" OR all:"deep learning" OR all:control)',
  'all:"digital twin" AND all:building AND (all:Modelica OR all:EnergyPlus OR all:energy)',
  'all:(HVAC OR chiller OR refrigeration OR "heat pump") AND (all:"deep learning" OR all:"machine learning" OR all:control)',
  'all:"indoor environmental quality" AND (all:prediction OR all:control)',
];

// 領域錨點（必要）：論文必須命中至少一個，否則直接淘汰 —— 確保只看建築/空調/冷凍/數位孿生
// 命中於 title 權重 ×2、abstract ×1
const DOMAIN_WEIGHTS = {
  'hvac': 5,
  'building energy': 5,
  'air conditioning': 4,
  'air-conditioning': 4,
  'refrigeration': 4,
  'heat pump': 4,
  'chiller': 4,
  'thermal comfort': 4,
  'energyplus': 4,
  'indoor environmental quality': 4,
  'smart building': 4,
  'building automation': 4,
  'building heating': 4,
  'building cooling': 4,
  'refrigerant': 3,
  'indoor air': 3,
  'buildings': 3,
  'modelica': 3,
  'built environment': 3,
  'ventilation': 3,
  'district heating': 3,
  'data center cooling': 3,
  'room temperature': 2,
  'occupancy': 2,
};

// AI / 自動控制方法（加值）：只有在領域命中後才計分，且至少要中一個才顯示
const METHOD_WEIGHTS = {
  'physics-informed': 6,
  'physics informed': 6,
  'pinn': 6,
  'digital twin': 4,
  'sim-to-real': 5,
  'sim2real': 5,
  'deep reinforcement learning': 5,
  'reinforcement learning': 4,
  'model predictive control': 4,
  'surrogate': 4,
  'multi-objective': 3,
  'pareto': 3,
  'autonomous control': 3,
  'fmu': 3,
  'real-time': 2,
  'edge': 2,
  'pmv': 2,
  'optimization': 1,
  'deep learning': 1,
  'machine learning': 1,
};

// 排除清單：命中任一者直接淘汰 —— 機器人 / 載具 / 航太 / 通訊網路等非建築空調主題
// （即使它們借用了 HVAC、heat pump、digital twin、control 等字眼）
const EXCLUDE_KEYWORDS = [
  'robot', 'quadruped', 'legged', 'locomotion', 'humanoid', 'manipulator', 'manipulation',
  'drone', ' uav', 'blimp', 'spacecraft', 'satellite', 'aircraft', 'flight control',
  'autonomous driving', 'self-driving', 'autonomous vehicle', 'electric vehicle',
  'electric-vehicle', 'vehicle routing', 'internet of vehicles', 'fleet',
  '5g', '6g', 'cellular network', 'wireless network',
];

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
  p.matched = [];

  // 排除清單：命中非建築空調主題 → 標記淘汰
  const blob = title + ' ' + abs;
  p.excluded = EXCLUDE_KEYWORDS.find((kw) => blob.includes(kw)) || null;

  // 命中計分：標題 ×2、摘要 ×1，並記錄命中關鍵字
  const hit = (kw, w) => {
    const inTitle = title.includes(kw);
    const inAbs = abs.includes(kw);
    if (!inTitle && !inAbs) return 0;
    p.matched.push(kw);
    return (inTitle ? w * 2 : 0) + (inAbs ? w : 0);
  };

  // 第 1 層：領域錨點
  let domainScore = 0;
  for (const [kw, w] of Object.entries(DOMAIN_WEIGHTS)) domainScore += hit(kw, w);

  // 第 2 層：AI / 自動控制方法
  let methodScore = 0;
  for (const [kw, w] of Object.entries(METHOD_WEIGHTS)) methodScore += hit(kw, w);

  // 近期加權：越新分數越高（30 天內遞減加成）
  const days = daysOld(p.published);
  const recency = Math.max(0, 30 - days) * 0.3;

  p.domainScore = domainScore;
  p.methodScore = methodScore;
  p.rawScore = Math.round((domainScore + methodScore + recency) * 10) / 10;
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

    // 領域門檻：必須是建築/空調/冷凍/數位孿生領域（domainScore>0）
    // 且至少命中一個 AI / 自動控制方法（methodScore>0），再濾掉太弱的
    papers = papers.filter(
      (p) => !p.excluded && p.domainScore > 0 && p.methodScore > 0 && p.rawScore >= 5
    );
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
