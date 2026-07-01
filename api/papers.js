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
  // 補充主題（權重較低）：資料中心散熱 / 節電節能 / 需量反應
  'all:"data center" AND (all:cooling OR all:thermal OR all:HVAC OR all:energy)',
  'all:"data center" AND (all:"reinforcement learning" OR all:"machine learning" OR all:"deep learning")',
  'all:("demand response" OR "peak shaving" OR "load shifting") AND (all:building OR all:HVAC OR all:"data center")',
  'all:("energy efficiency" OR "energy saving") AND (all:building OR all:HVAC OR all:chiller OR all:"data center")',
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
  'room temperature': 2,
  'occupancy': 2,
  // 補充領域（權重較低）：資料中心散熱 / 節電節能 / 需量反應
  'data center': 3,
  'datacenter': 3,
  'data centre': 3,
  'server room': 3,
  'demand response': 3,
  'demand-side': 2,
  'peak shaving': 2,
  'load shifting': 2,
  'energy efficiency': 2,
  'energy saving': 2,
  'energy conservation': 2,
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

// 韌性參數：arXiv API 有時單條查詢就要 20s+，且對併發會限流。
// 因此限制併發、每條查詢單獨逾時、並設整體截止時間，保證在 Vercel maxDuration 前回傳。
const PER_FETCH_TIMEOUT_MS = 12000; // 單條查詢最多等 12 秒，逾時當作空結果
const CONCURRENCY = 5;              // 同時最多 5 條，避免被 arXiv 限流
const OVERALL_DEADLINE_MS = 45000;  // 整支函式最多跑 45 秒（maxDuration 60，留裕度）

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
  // 單條查詢逾時保護：超過 PER_FETCH_TIMEOUT_MS 就中止，避免拖垮整支函式
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PER_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'hvac-ai-paper-daily/1.0 (research reading list)' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`arXiv ${res.status}`);
    const xml = await res.text();
    return parseFeed(xml);
  } finally {
    clearTimeout(timer);
  }
}

// 有限併發執行：一次最多 CONCURRENCY 條，任一條失敗/逾時不影響其他條。
// 整體有 deadline 保護：到時就用「目前已成功的結果」回傳，不再等待。
async function fetchAllQueries() {
  const collected = [];
  let index = 0;
  const deadline = Date.now() + OVERALL_DEADLINE_MS;

  async function worker() {
    while (index < QUERIES.length && Date.now() < deadline) {
      const q = QUERIES[index++];
      try {
        const entries = await fetchQuery(q);
        collected.push(...entries);
      } catch (_) {
        // 單條失敗（逾時/限流/網路）忽略，繼續下一條
      }
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, QUERIES.length) }, worker);
  // 整體 deadline 兜底：即使某些 worker 仍卡著，也不會超過 OVERALL_DEADLINE_MS
  await Promise.race([
    Promise.all(workers),
    new Promise((resolve) => setTimeout(resolve, OVERALL_DEADLINE_MS)),
  ]);
  return collected;
}

export default async function handler(req, res) {
  try {
    const all = await fetchAllQueries();
    const byId = new Map();
    for (const p of all) {
      if (!byId.has(p.id)) byId.set(p.id, p);
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

    // 只有抓到論文才長快取 6 小時（背景更新）；若這次一篇都沒抓到（arXiv 全逾時），
    // 只短快取 60 秒，讓下次請求盡快重試，而不是把空白結果卡住 6 小時。
    if (papers.length > 0) {
      res.setHeader('Cache-Control', 'public, s-maxage=21600, stale-while-revalidate=86400');
    } else {
      res.setHeader('Cache-Control', 'public, s-maxage=60');
    }
    res.status(200).json({
      generatedAt: new Date().toISOString(),
      count: papers.length,
      papers,
    });
  } catch (err) {
    res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
}
