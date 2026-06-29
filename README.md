# 📄 每日論文 · 數位孿生 × 空調 AI

每日自動從 [arXiv](https://arxiv.org) 彙整「數位孿生（Digital Twin）× 空調 HVAC × AI 能源優化」領域的最新高價值論文，用乾淨的卡片版面列出，取代每天手動查找的麻煩。

研究主題與關鍵字源自個人 NotebookLM 筆記本「數位孿生與空調AI研究」歸納的核心方向。

## 功能

- **自動抓取**：serverless function 從 arXiv API 抓取 10 組主題查詢（PINN、強化學習、數位孿生、代理模型、MPC…）的最新論文
- **有料評分**：依高價值關鍵字加權（PINN、深度強化學習、Sim-to-Real、Pareto 多目標、Modelica/EnergyPlus…）＋近期加成，正規化為 0–100「有料分數」
- **前端閱讀**：排序（有料分數／最新）、時間範圍（7/30/90 天）、關鍵字過濾、展開摘要、一鍵連 arXiv 摘要頁與 PDF
- **快取**：Edge 快取 6 小時，自動更新，無需資料庫、無需 API 金鑰

## 技術

- 零依賴：Node 內建 `fetch` + 輕量 Atom 解析
- 前端：原生 HTML / CSS / JS
- 部署：Vercel（`api/papers.js` 為 serverless function，靜態檔直接服務）

## 本機開發

```bash
npm run test:api    # 直接測試抓取＋評分（不需起伺服器）
npm run dev         # vercel dev，本機完整預覽 http://localhost:3000
```

## 調整搜尋方向

編輯 `api/papers.js`：
- `QUERIES` — arXiv 搜尋字串
- `KEYWORD_WEIGHTS` — 「有料」關鍵字權重

## arXiv 分類

`cs.LG`（機器學習）· `cs.AI`（人工智慧）· `eess.SY`（系統控制）· `cs.CE`（計算工程）· `math.OC`（最佳化控制）
