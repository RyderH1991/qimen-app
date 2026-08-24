// api/history.js
// GET  /api/history        -> 回傳目前登入使用者的解盤歷史紀錄（最新50筆）
// DELETE /api/history?id=xxx -> 刪除指定的一筆紀錄（只能刪自己的）

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
    res.status(401).json({ error: '請先登入' });
    return;
  }

  let lineUserId;
  try {
    const payload = jwt.verify(token, process.env.SESSION_JWT_SECRET);
    lineUserId = payload.sub;
  } catch (err) {
    res.status(401).json({ error: '登入已過期，請重新登入' });
    return;
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('readings')
      .select('id, question, palace, shen, star, door, tian_gan, di_gan, interpretation, created_at')
      .eq('line_user_id', lineUserId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      console.error('Fetch history error:', error);
      res.status(500).json({ error: '讀取歷史紀錄失敗' });
      return;
    }

    res.status(200).json({ readings: data });
    return;
  }

  if (req.method === 'DELETE') {
    const id = req.query.id;
    if (!id) {
      res.status(400).json({ error: '缺少要刪除的紀錄ID' });
      return;
    }

    // 條件式刪除：id 跟 line_user_id 都要符合，確保使用者只能刪自己的紀錄
    const { error, count } = await supabase
      .from('readings')
      .delete({ count: 'exact' })
      .eq('id', id)
      .eq('line_user_id', lineUserId);

    if (error) {
      console.error('Delete history error:', error);
      res.status(500).json({ error: '刪除失敗，請稍後再試' });
      return;
    }

    if (!count) {
      res.status(404).json({ error: '找不到這筆紀錄，或不屬於你的帳號' });
      return;
    }

    res.status(200).json({ ok: true });
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
};
