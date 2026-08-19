// api/me.js
// 前端每次載入頁面時呼叫這支API，用cookie裡的登入憑證確認「你是誰」，
// 並回傳目前的點數餘額，前端據此顯示登入列。

const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

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

module.exports = async function handler(req, res) {
  const cookies = parseCookies(req);
  const token = cookies.qimen_session;

  if (!token) {
    return res.status(200).json({ loggedIn: false });
  }

  try {
    const payload = jwt.verify(token, process.env.SESSION_JWT_SECRET);

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
    const { data, error } = await supabase
      .from('app_users')
      .select('display_name, picture_url, points_balance')
      .eq('line_user_id', payload.sub)
      .single();

    if (error || !data) {
      return res.status(200).json({ loggedIn: false });
    }

    return res.status(200).json({
      loggedIn: true,
      displayName: data.display_name,
      pictureUrl: data.picture_url,
      pointsBalance: data.points_balance,
    });
  } catch (err) {
    // token 驗證失敗（過期/被竄改）一律視為未登入
    return res.status(200).json({ loggedIn: false });
  }
};
