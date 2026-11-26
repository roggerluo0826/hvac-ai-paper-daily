// 讀者對位自我檢查：node scripts/test-fit.js
import assert from 'node:assert';
import { audienceFit } from '../api/papers.js';

// DeepMind BCOOLER (arXiv 2211.07357) —— 失敗推薦的原案例：應判為 ML 讀者、抓到動機句與「challenges」
const bcooler = audienceFit(
  "This paper is a technical overview of DeepMind and Google's recent work on reinforcement learning for controlling commercial cooling systems. " +
  'These live experiments had a variety of challenges in areas such as evaluation, learning from offline data, and constraint satisfaction. ' +
  'Our paper describes these challenges in the hope that awareness of them will benefit future applied RL work. ' +
  'We also describe the way we adapted our RL system to deal with these challenges, resulting in energy savings of approximately 9% and 13%.'
);
assert.equal(bcooler.audience, 'ml');
assert.match(bcooler.motive, /in the hope/);
assert.match(bcooler.negative, /challenges/);

// 實務取向、無負面字眼
const field = audienceFit('We report a field trial of chiller sequencing in an existing building, verified with measurement and verification.');
assert.equal(field.audience, 'practice');
assert.equal(field.negative, null);

assert.deepEqual(audienceFit(''), { audience: null, motive: null, negative: null });
console.log('audienceFit OK');
