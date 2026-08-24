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

## 金流（綠界 ECPay）串接說明

**強烈建議先用測試環境驗證整個流程，再切換到正式環境**，避免正式串接時因為參數/檢查碼算法問題導致真實款項出錯。

### 測試環境（先用這組，不會真的扣款）
```
ECPAY_MERCHANT_ID=2000132
ECPAY_HASH_KEY=5294y06JbISpM5x9
ECPAY_HASH_IV=v77hoKGq4kWxNNIS
ECPAY_CHECKOUT_URL=https://payment-stage.ecpay.com.tw/Cashier/AioCheckOut/V5
```
這組是綠界官方公開的測試帳號，任何人都能用來測試串接流程。測試環境的信用卡輸入頁面可以用綠界文件提供的測試卡號完成「假付款」，藉此驗證從按下儲值按鈕 → 導向付款頁 → 付款完成 → 點數有沒有正確加進帳號，整條路徑都正常。

### 切換到正式環境
確認測試流程沒問題後，把環境變數改成你自己正式審核通過的商店資料：
```
ECPAY_MERCHANT_ID=你的正式特店編號
ECPAY_HASH_KEY=你的正式HashKey
ECPAY_HASH_IV=你的正式HashIV
ECPAY_CHECKOUT_URL=https://payment.ecpay.com.tw/Cashier/AioCheckOut/V5
```

### 運作流程
1. 使用者登入後點「儲值」，選一個點數方案
2. 前端導向 `/api/create-order?package=100`（後端建立pending訂單，算出檢查碼，回傳一個自動送出的表單）
3. 瀏覽器整頁跳轉到綠界付款頁面完成付款
4. 綠界從**伺服器端**（不是使用者瀏覽器）呼叫 `/api/payment-callback`，帶著付款結果
5. 後端驗證檢查碼、確認付款成功後，把點數加進 `app_users.points_balance`，訂單狀態改為 `paid`
6. 使用者付款完成後，瀏覽器會被導回首頁（`ECPAY_CLIENT_BACK_URL`），此時點數應該已經加好了（因為步驟4通常比使用者按返回商店的按鈕快）
