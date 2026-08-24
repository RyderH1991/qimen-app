// api/interpret.js
// Vercel Serverless Function：接收前端傳來的盤象資料 + 使用者問題，
// 先確認登入狀態 + 扣點/免費次數，通過後才呼叫 Claude API 做奇門遁甲解盤。
//
// 注意：ANTHROPIC_API_KEY / SUPABASE_SERVICE_ROLE_KEY 都是從 Vercel 的環境變數讀取，
// 絕對不要把金鑰寫死在程式碼裡。

const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const POINTS_PER_USE = 10;
const FREE_PERIOD_DAYS = 30;
const FREE_PERIOD_MS = FREE_PERIOD_DAYS * 24 * 60 * 60 * 1000;

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
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: '伺服器尚未設定 ANTHROPIC_API_KEY 環境變數' });
    return;
  }

  // ---- 1. 確認登入狀態 ----
  const cookies = parseCookies(req);
  const token = cookies.qimen_session;
  if (!token) {
    res.status(401).json({ error: '請先登入才能使用 AI 解盤', code: 'not_logged_in' });
    return;
  }

  let lineUserId;
  try {
    const payload = jwt.verify(token, process.env.SESSION_JWT_SECRET);
    lineUserId = payload.sub;
  } catch (err) {
    res.status(401).json({ error: '登入已過期，請重新登入', code: 'not_logged_in' });
    return;
  }

  const { question, pan } = req.body || {};

  if (!pan || !pan.palace) {
    res.status(400).json({ error: '缺少盤象資料（pan）' });
    return;
  }

  // ---- 2. 檢查免費次數 / 扣點 ----
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data: user, error: fetchError } = await supabase
    .from('app_users')
    .select('points_balance, last_free_use_at')
    .eq('line_user_id', lineUserId)
    .single();

  if (fetchError || !user) {
    console.error('Fetch user error:', fetchError);
    res.status(500).json({ error: '無法讀取使用者資料，請稍後再試' });
    return;
  }

  const now = new Date();
  const lastFree = user.last_free_use_at ? new Date(user.last_free_use_at) : null;
  const freeEligible = !lastFree || now.getTime() - lastFree.getTime() >= FREE_PERIOD_MS;

  let usedFree = false;
  let newPointsBalance = user.points_balance;

  if (freeEligible) {
    // 使用免費次數：只更新時間戳記，不扣點
    const { error: updateError } = await supabase
      .from('app_users')
      .update({ last_free_use_at: now.toISOString() })
      .eq('line_user_id', lineUserId);

    if (updateError) {
      console.error('Update free-use timestamp error:', updateError);
      res.status(500).json({ error: '伺服器發生錯誤，請稍後再試' });
      return;
    }
    usedFree = true;
  } else {
    // 非免費資格，檢查點數是否足夠
    if (user.points_balance < POINTS_PER_USE) {
      res.status(402).json({
        error: '點數不足，請儲值後再使用',
        code: 'insufficient_points',
        pointsBalance: user.points_balance,
      });
      return;
    }

    newPointsBalance = user.points_balance - POINTS_PER_USE;
    const { error: deductError } = await supabase
      .from('app_users')
      .update({ points_balance: newPointsBalance })
      .eq('line_user_id', lineUserId);

    if (deductError) {
      console.error('Deduct points error:', deductError);
      res.status(500).json({ error: '伺服器發生錯誤，請稍後再試' });
      return;
    }
  }

  // ---- 3. 組 prompt，呼叫 Claude API ----
  const harmLines = [];
  if (pan.doorHarm) harmLines.push(`${pan.door}門在${pan.palace}宮犯「門迫」`);
  if (pan.tianJixing) harmLines.push(`天盤干「${pan.tianGan}」犯「擊刑」`);
  if (pan.diJixing) harmLines.push(`地盤干「${pan.diGan}」犯「擊刑」`);
  if (pan.tianRumu) harmLines.push(`天盤干「${pan.tianGan}」逢「入墓」`);
  if (pan.diRumu) harmLines.push(`地盤干「${pan.diGan}」逢「入墓」`);
  if (pan.tianEmpty) harmLines.push('天盤干為「空無」');
  if (pan.diEmpty) harmLines.push('地盤干為「空無」');
  const harmText = harmLines.length ? harmLines.join('、') : '此盤無四害，狀態平順';

  const systemPrompt = `你是一位精通奇門遁甲的命理老師，語氣沉穩、專業、溫和，不譁眾取寵。
使用者會提供一組已經排算完成的「單宮盤象」資料（宮位、值符八神、八星、八門、天地盤干、以及是否犯門迫/擊刑/入墓/空無），
以及使用者想問的問題。

你的任務：
- 只負責「解讀」這組盤象資料，不要重新計算或質疑盤象本身是否正確，盤象已經用固定規則精算過。
- 針對使用者的問題，給出具體、實用、貼近生活的解讀與建議，避免空泛的話術。
- 如果盤中出現門迫、擊刑、入墓等凶象，要適度提醒使用者需留意的地方，但語氣不要過度恐嚇。
- 若有空無，說明這代表的「虛」、「暫緩」、「尚未成形」等意涵。
- 回覆控制在 300～450 字之間，用繁體中文，分 2～3 段呈現，不要用條列式，語感像是老師在跟人講解。`;

  const userPrompt = `【使用者問題】
${question || '（使用者未輸入具體問題，請就整體盤象做通用解讀）'}

【盤象資料】
宮位：${pan.palace}宮
值符八神：${pan.shen}
八星：${pan.star}
八門：${pan.door}門
天盤干：${pan.tianGan}
地盤干：${pan.diGan}
四害狀態：${harmText}

請根據以上盤象，針對使用者的問題進行解讀。`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        system: systemPrompt,
        messages: [
          { role: 'user', content: userPrompt }
        ]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Claude API error:', response.status, errText);
      res.status(502).json({ error: 'AI 服務呼叫失敗，請稍後再試' });
      return;
    }

    const data = await response.json();
    const text = (data.content || [])
      .map((block) => (block.type === 'text' ? block.text : ''))
      .filter(Boolean)
      .join('\n');

    res.status(200).json({
      interpretation: text || '（AI 未回傳內容，請重新嘗試）',
      usedFree,
      pointsBalance: newPointsBalance,
    });
  } catch (err) {
    console.error('Interpret handler error:', err);
    res.status(500).json({ error: '伺服器發生錯誤，請稍後再試' });
  }
};
