// 本機測試：直接呼叫 handler，驗證 arXiv 抓取＋解析＋評分
import handler from '../api/papers.js';

const res = {
  _status: 200,
  _headers: {},
  setHeader(k, v) { this._headers[k] = v; },
  status(c) { this._status = c; return this; },
  json(obj) {
    console.log('HTTP', this._status);
    if (obj.error) { console.error('ERROR:', obj.error); return; }
    console.log('generatedAt:', obj.generatedAt);
    console.log('count:', obj.count);
    console.log('\n=== Top 8 ===');
    for (const p of obj.papers.slice(0, 8)) {
      console.log(`\n[${p.score}] ${p.title}`);
      console.log(`  ${p.published.slice(0, 10)} (${p.daysOld}d) | ${p.categories.join(', ')}`);
      console.log(`  matched: ${p.matched.join(', ')}`);
      console.log(`  ${p.url}`);
    }
  },
};

await handler({}, res);
