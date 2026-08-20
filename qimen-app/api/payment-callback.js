// api/payment-callback.js
// 綠界的 ReturnURL：付款完成後，綠界會用伺服器對伺服器的方式POST資料到這裡（不是使用者的瀏覽器）。
// 這裡必須：1. 驗證CheckMacValue確認是真的綠界送來的 2. 更新訂單狀態 3. 加點給使用者
// 4. 回傳固定格式的文字 "1|OK" 給綠界，否則綠界會重複通知

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

function generateCheckMacValue(params, hashKey, hashIV) {
  const filtered = { ...params };
  delete filtered.CheckMacValue;

  const sorted = Object.keys(filtered)
    .sort()
    .map((k) => `${k}=${filtered[k]}`)
    .join('&');
  const raw = `HashKey=${hashKey}&${sorted}&HashIV=${hashIV}`;

  let encoded = encodeURIComponent(raw).toLowerCase();
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
  try {
    const body = req.body || {};
    const receivedMac = body.CheckMacValue;
    const computedMac = generateCheckMacValue(
      body,
      process.env.ECPAY_HASH_KEY,
      process.env.ECPAY_HASH_IV
    );

    if (!receivedMac || receivedMac !== computedMac) {
      console.error('CheckMacValue mismatch', { receivedMac, computedMac, body });
      // 檢查碼不對，可能不是真的綠界送來的通知，不處理但仍回應避免對方一直重試
      res.status(200).send('0|CheckMacValueError');
      return;
    }

    if (body.RtnCode === '1') {
      const supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY
      );

      const { data: order, error: fetchError } = await supabase
        .from('orders')
        .select('*')
        .eq('id', body.MerchantTradeNo)
        .single();

      if (fetchError || !order) {
        console.error('Order not found:', body.MerchantTradeNo, fetchError);
      } else if (order.status === 'pending') {
        // 先標記訂單為已付款，避免重複通知時重複加點
        const { error: updateOrderError } = await supabase
          .from('orders')
          .update({ status: 'paid', paid_at: new Date().toISOString() })
          .eq('id', order.id)
          .eq('status', 'pending'); // 條件式更新，避免同時處理兩次通知造成重複加點

        if (!updateOrderError) {
          const { data: user, error: userFetchError } = await supabase
            .from('app_users')
            .select('points_balance')
            .eq('line_user_id', order.line_user_id)
            .single();

          if (!userFetchError && user) {
            await supabase
              .from('app_users')
              .update({ points_balance: user.points_balance + order.package_points })
              .eq('line_user_id', order.line_user_id);
          }
        }
      }
      // order.status 已經是 paid 的情況（重複通知）：不重複加點，直接回1|OK即可
    }

    res.status(200).send('1|OK');
  } catch (err) {
    console.error('Payment callback error:', err);
    // 我方發生錯誤時，不要回 1|OK，讓綠界之後重新通知一次，避免漏帳
    res.status(500).send('0|ServerError');
  }
};
