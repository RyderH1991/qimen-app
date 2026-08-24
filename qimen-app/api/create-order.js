// api/create-order.js
// 使用者選擇點數方案後，導向這支API（GET /api/create-order?package=100）。
// 這裡負責：確認登入 -> 建立pending訂單 -> 組出綠界要求的參數與檢查碼 -> 回傳一個會自動送出的表單，
// 讓瀏覽器整頁導向綠界的付款頁面。

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

// 點數方案：1點=NT$1，300/1000有折扣
const PACKAGES = {
  '100': { points: 100, amount: 100, name: '奇門遁甲點數 100點' },
  '300': { points: 300, amount: 270, name: '奇門遁甲點數 300點' },
  '1000': { points: 1000, amount: 800, name: '奇門遁甲點數 1000點' },
};

function parseCookies(req) {
  const header = req.headers.cookie || '';
  return Object.fromEntries(
    header
      .split(';')
      .filter(Boolean)
      .map((c) => {
        const idx = c.indexOf('=');
        const k = c.slice(0, idx).trim();
        const v = c.slice(idx + 1).trim();
        return [k, decodeURIComponent(v)];
      })
  );
}

// 綠界「檢查碼機制」標準演算法：
// 1. 參數依A-Z排序 -> 2. 前後加HashKey/HashIV -> 3. URL encode -> 4. 轉小寫 -> 5. SHA256 -> 6. 轉大寫
function generateCheckMacValue(params, hashKey, hashIV) {
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  const raw = `HashKey=${hashKey}&${sorted}&HashIV=${hashIV}`;

  let encoded = encodeURIComponent(raw).toLowerCase();
  // 對齊 .NET UrlEncode 的字元轉換規則
  encoded = encoded
    .replace(/%2d/g, '-')
    .replace(/%5f/g, '_')
    .replace(/%2e/g, '.')
    .replace(/%21/g, '!')
    .replace(/%2a/g, '*')
    .replace(/%28/g, '(')
    .replace(/%29/g, ')')
    .replace(/%20/g, '+');

  return crypto.createHash('sha256').update(encoded).digest('hex').toUpperCase();
}

module.exports = async function handler(req, res) {
  const cookies = parseCookies(req);
  const token = cookies.qimen_session;
  if (!token) {
    res.status(401).send('請先登入後再儲值');
    return;
  }

  let lineUserId;
  try {
    const payload = jwt.verify(token, process.env.SESSION_JWT_SECRET);
    lineUserId = payload.sub;
  } catch (err) {
    res.status(401).send('登入已過期，請重新登入');
    return;
  }

  const packageId = String(req.query.package || '');
  const pkg = PACKAGES[packageId];
  if (!pkg) {
    res.status(400).send('無效的點數方案');
    return;
  }

  // 產生訂單編號（英數字，20字以內）
  const merchantTradeNo =
    'Q' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const merchantTradeDate = `${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(
    now.getDate()
  )} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { error: insertError } = await supabase.from('orders').insert({
    id: merchantTradeNo,
    line_user_id: lineUserId,
    package_points: pkg.points,
    amount_ntd: pkg.amount,
    status: 'pending',
  });

  if (insertError) {
    console.error('Create order error:', insertError);
    res.status(500).send('建立訂單失敗，請稍後再試');
    return;
  }

  const params = {
    MerchantID: process.env.ECPAY_MERCHANT_ID,
    MerchantTradeNo: merchantTradeNo,
    MerchantTradeDate: merchantTradeDate,
    PaymentType: 'aio',
    TotalAmount: String(pkg.amount),
    TradeDesc: 'Qimen Points Top-up',
    ItemName: pkg.name,
    ReturnURL: process.env.ECPAY_RETURN_URL,
    ClientBackURL: process.env.ECPAY_CLIENT_BACK_URL,
    ChoosePayment: 'ALL',
    EncryptType: '1',
  };

  const checkMacValue = generateCheckMacValue(
    params,
    process.env.ECPAY_HASH_KEY,
    process.env.ECPAY_HASH_IV
  );
  params.CheckMacValue = checkMacValue;

  const actionUrl = process.env.ECPAY_CHECKOUT_URL;

  const formInputs = Object.entries(params)
    .map(
      ([k, v]) =>
        `<input type="hidden" name="${k}" value="${String(v).replace(/"/g, '&quot;')}">`
    )
    .join('\n');

  const html = `<!DOCTYPE html>
<html lang="zh-Hant"><head><meta charset="UTF-8"><title>正在導向付款頁面...</title></head>
<body onload="document.forms[0].submit()" style="font-family:sans-serif;text-align:center;padding-top:80px;color:#666;">
  <p>正在導向綠界付款頁面，請稍候...</p>
  <form method="POST" action="${actionUrl}">
    ${formInputs}
  </form>
</body></html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(html);
};
