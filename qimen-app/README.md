# 奇門遁甲擲盤占卜

六位數字排盤 + Claude AI（Haiku 4.5）解盤 + LINE登入。

## 專案結構

```
qimen-app/
├── index.html              前端頁面（骰盤、排盤邏輯、登入UI）— 放根目錄，Vercel零設定辨識為首頁
├── api/
│   ├── interpret.js         AI解盤，呼叫 Claude API
│   ├── line-login.js        LINE登入導轉
│   ├── line-callback.js     LINE授權完成後的回呼，換資料、核發登入憑證
│   ├── me.js                查詢目前登入狀態與點數
│   └── logout.js            登出
├── package.json
├── .gitignore
├── .env.example             環境變數範例（複製成 .env 使用）
└── supabase-schema.sql      Supabase資料表建立語法
```

## 登入架構說明

**不使用 Supabase Auth**（因為LINE網頁版登入的Token簽章演算法HS256，跟Supabase Auth要求的ES256不相容，這是LINE跟Supabase雙方的規格限制，無法透過設定繞過）。

改成完全自建：
1. 使用者點「使用LINE登入」→ 導去 `/api/line-login`
2. 該API把使用者導去LINE的授權頁面
3. 授權完成，LINE導回 `/api/line-callback`
4. 後端直接跟LINE換取使用者資料（不驗證簽章，改用UserInfo端點取得JSON資料）
5. 後端把使用者資料寫入Supabase的 `app_users` 表，並核發自己的登入憑證（JWT），存進httpOnly cookie
6. 之後每次載入頁面，前端呼叫 `/api/me` 用cookie確認登入狀態、拿點數餘額

Supabase在這個架構裡純粹當「資料庫」，不使用它的登入/驗證機制，所有讀寫都由後端用 `service_role key` 執行，一般使用者無法直接存取資料庫。

## 部署到 Vercel 的步驟

### 1. 建立資料表
到 Supabase → SQL Editor，貼上 `supabase-schema.sql` 的內容並執行。

### 2. 把專案推上 GitHub
確保 GitHub repository 裡的檔案結構跟上面一致（`index.html` 在根目錄，不是子資料夾）。

### 3. 在 Vercel 設定環境變數
Project Settings → Environment Variables，依照 `.env.example` 的說明，把以下都設定好（Production/Preview/Development都勾選）：

- `ANTHROPIC_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`（**注意是 Secret key，不是 Publishable key**，在 Supabase Project Settings → API Keys 的 Secret keys 區塊）
- `LINE_CHANNEL_ID`
- `LINE_CHANNEL_SECRET`
- `LINE_CALLBACK_URL`（設成 `https://你的正式網址/api/line-callback`）
- `SESSION_JWT_SECRET`（自己隨機打一串，或用 `openssl rand -hex 32` 產生）

### 4. 回到 LINE Developers Console
把你的 LINE Login Channel 的 **Callback URL** 改成：
```
https://你的正式網址/api/line-callback
```
（不再是Supabase的callback網址）

### 5. 重新部署
設定完環境變數後，回 Vercel → Deployments → Redeploy（或推一個新commit觸發全新部署）。

## Supabase 那邊可以清掉的東西

之前建立的 **Custom OIDC Provider（LINE Login）** 這個設定已經不會用到了，可以到 Authentication → Sign In/Providers → Custom Providers 裡刪除，避免混淆。

## 之後可以擴充的部分（尚未實作）

- AI解盤時的點數扣款邏輯（`api/interpret.js` 目前還沒接使用者身份驗證）
- 每週/每月免費次數的判斷（`last_free_use_at` 欄位已經預留）
- 點數儲值（金流串接，綠界 ECPay）
