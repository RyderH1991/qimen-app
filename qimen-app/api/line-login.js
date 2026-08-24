// api/line-login.js
// 使用者按「使用 LINE 登入」時，前端直接導向這支API，
// 這裡負責產生防偽驗證用的 state，並把使用者導去LINE的授權頁面。

const crypto = require('crypto');

module.exports = async function handler(req, res) {
  const state = crypto.randomBytes(16).toString('hex');

  // 把 state 存進一個短效期的 cookie，等LINE導回來時比對，防止CSRF攻擊
  res.setHeader(
    'Set-Cookie',
    `line_oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`
  );

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.LINE_CHANNEL_ID,
    redirect_uri: process.env.LINE_CALLBACK_URL,
    state,
    scope: 'openid profile',
  });

  res.writeHead(302, {
    Location: `https://access.line.me/oauth2/v2.1/authorize?${params.toString()}`,
  });
  res.end();
};
