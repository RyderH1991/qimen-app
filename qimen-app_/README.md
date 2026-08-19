# 奇門遁甲擲盤占卜

六位數字排盤 + Claude AI（Haiku 4.5）解盤 Demo。

## 專案結構

```
qimen-app/
├── index.html            前端頁面（骰盤、排盤邏輯、畫面）— 放在根目錄，Vercel才能零設定辨識為首頁
├── api/
│   └── interpret.js       後端 Serverless Function，呼叫 Claude API
├── package.json
├── .gitignore
└── .env.example           環境變數範例（複製成 .env 使用）
```

## 部署到 Vercel 的步驟

### 1. 把專案推上 GitHub
把整個 `qimen-app` 資料夾建立成一個新的 GitHub repository，push 上去。
（`.env` 不會被上傳，因為 `.gitignore` 已經排除它 —— 這是刻意設計，金鑰不能進 GitHub。）

### 2. 在 Vercel 匯入這個 repository
1. 登入 vercel.com → New Project
2. 選擇剛剛的 GitHub repository → Import
3. Framework Preset 選 **Other**（因為這不是 Next.js/React 專案，是純靜態網頁 + Serverless Function）
4. Root Directory 保持預設即可
5. **先不要按 Deploy**，往下看下一步設定環境變數

### 3. 設定環境變數（最重要的一步）
在 Vercel 專案設定畫面：
1. 找到 **Environment Variables**
2. Name 填：`ANTHROPIC_API_KEY`
3. Value 填：你自己的 API Key（`sk-ant-...` 開頭那串）
4. Environment 三個都勾（Production / Preview / Development）
5. 按 Add，然後才按 **Deploy**

### 4. 部署完成
Vercel 會給你一個網址（例如 `qimen-app.vercel.app`），打開就能測試骰盤 + AI 解盤功能。

## 本機測試（選用）

如果想在自己電腦上先測試：

```bash
npm install -g vercel
vercel dev
```

執行前記得先把 `.env.example` 複製一份改名為 `.env`，並填入你自己的 API Key。

## 之後可以擴充的部分（尚未實作）

- 使用者帳號系統、點數扣款邏輯
- 每週/每月免費次數的資料庫記錄
- 金流串接（綠界/藍新/Stripe 等）
