// api/line-callback.js
// LINE授權完成後會導回這支API，這裡負責：
// 1. 驗證state防止CSRF
// 2. 用授權碼跟LINE換取access token
// 3. 用access token跟LINE要使用者資料（不驗證ID Token簽章，避開HS256/ES256的相容性問題）
// 4. 把使用者資料寫入/更新 Supabase 的 app_users 表
// 5. 核發我們自己的登入憑證（JWT），存進cookie，導回首頁

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
  const { code, state, error } = req.query;
  const cookies = parseCookies(req);

  const redirectHome = (path = '/') => {
    res.writeHead(302, { Location: path });
    res.end();
  };

  if (error) {
    return redirectHome('/?login_error=' + encodeURIComponent(String(error)));
  }

  if (!code || !state || state !== cookies.line_oauth_state) {
    return redirectHome('/?login_error=invalid_state');
  }

  try {
    // 1. 用授權碼換取 access token
    const tokenResp = await fetch('https://api.line.me/oauth2/v2.1/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: String(code),
        redirect_uri: process.env.LINE_CALLBACK_URL,
        client_id: process.env.LINE_CHANNEL_ID,
        client_secret: process.env.LINE_CHANNEL_SECRET,
      }),
    });

    if (!tokenResp.ok) {
      const t = await tokenResp.text();
      console.error('LINE token exchange failed:', tokenResp.status, t);
      return redirectHome('/?login_error=token_exchange_failed');
    }
    const tokenData = await tokenResp.json();

    // 2. 用 access token 跟 LINE 要使用者資料（純JSON，不涉及JWT簽章驗證）
    const profileResp = await fetch('https://api.line.me/oauth2/v2.1/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    if (!profileResp.ok) {
      const t = await profileResp.text();
      console.error('LINE userinfo failed:', profileResp.status, t);
      return redirectHome('/?login_error=profile_fetch_failed');
    }
    const profile = await profileResp.json(); // { sub, name, picture }

    // 3. 寫入/更新 Supabase 使用者資料（用 service_role key，繞過RLS，僅限後端使用）
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
    const { error: upsertError } = await supabase.from('app_users').upsert(
      {
        line_user_id: profile.sub,
        display_name: profile.name || null,
        picture_url: profile.picture || null,
      },
      { onConflict: 'line_user_id' }
    );

    if (upsertError) {
      console.error('Supabase upsert error:', upsertError);
      return redirectHome('/?login_error=db_error');
    }

    // 4. 核發我們自己的登入憑證（JWT），存進 httpOnly cookie
    const sessionToken = jwt.sign(
      { sub: profile.sub, name: profile.name, picture: profile.picture },
      process.env.SESSION_JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.setHeader('Set-Cookie', [
      `line_oauth_state=; Path=/; HttpOnly; Max-Age=0`,
      `qimen_session=${sessionToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`,
    ]);

    return redirectHome('/');
  } catch (err) {
    console.error('LINE callback error:', err);
    return redirectHome('/?login_error=server_error');
  }
};
