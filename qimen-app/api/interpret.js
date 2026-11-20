// api/interpret.js
// Vercel Serverless Function：接收前端傳來的盤象資料 + 使用者問題，
// 先確認登入狀態 + 扣點/免費次數，通過後才呼叫 Claude API 做奇門遁甲解盤。
//
// 注意：ANTHROPIC_API_KEY / SUPABASE_SERVICE_ROLE_KEY 都是從 Vercel 的環境變數讀取，
// 絕對不要把金鑰寫死在程式碼裡。

const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const POINTS_PER_USE = 10;

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

  const { question, pan, mode, cards } = req.body || {};
  const isGame = mode === 'game';

  if (!pan || !pan.palace) {
    res.status(400).json({ error: '缺少盤象資料（pan）' });
    return;
  }
  if (isGame && (!cards || !cards.guide || !cards.aware)) {
    res.status(400).json({ error: '缺少桌遊牌卡資料（cards）' });
    return;
  }

  // ---- 2. 檢查免費次數 / 扣點 ----
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data: user, error: fetchError } = await supabase
    .from('app_users')
    .select('points_balance, free_uses_remaining')
    .eq('line_user_id', lineUserId)
    .single();

  if (fetchError || !user) {
    console.error('Fetch user error:', fetchError);
    res.status(500).json({ error: '無法讀取使用者資料，請稍後再試' });
    return;
  }

  const freeEligible = (user.free_uses_remaining || 0) > 0;

  let usedFree = false;
  let newPointsBalance = user.points_balance;
  let newFreeUsesRemaining = user.free_uses_remaining;

  if (freeEligible) {
    // 使用一次免費額度，扣減次數，不扣點
    newFreeUsesRemaining = user.free_uses_remaining - 1;
    const { error: updateError } = await supabase
      .from('app_users')
      .update({ free_uses_remaining: newFreeUsesRemaining })
      .eq('line_user_id', lineUserId);

    if (updateError) {
      console.error('Update free-use count error:', updateError);
      res.status(500).json({ error: '伺服器發生錯誤，請稍後再試' });
      return;
    }
    usedFree = true;
  } else {
    // 免費額度已用完，檢查點數是否足夠
    if (user.points_balance < POINTS_PER_USE) {
      res.status(402).json({
        error: '免費次數已用完，點數不足，請儲值後再使用',
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

  // 桌遊模式：牌面與真實奇門四害並列
  const clip = (v, n = 120) => String(v ?? '').slice(0, n);
  let gameHarmText = '牌面與真實奇門皆無四害';
  if (isGame) {
    const arr = Array.isArray(pan.harmSummary) ? pan.harmSummary.slice(0, 10).map((x) => clip(x, 60)) : [];
    if (arr.length) gameHarmText = arr.join('；');
  }

  const gameSystemPrompt = `你是一位精通奇門遁甲的老師，也熟悉「奇門引路」這款桌遊。語氣沉穩、溫和、有洞察，不譁眾取寵。
「奇門引路」把奇門遁甲的宮、門、星、神、天盤干、地盤干當作隱喻語言，玩家走完遊戲後，會拿到各一張牌卡，組成一宮盤象，另外還有一張「引導卡」（一個意象處境加一句引導問句）、一張「覺察卡」（這一局跟玩家有關的人生議題），有時還有一張「神諭卡」。

你會收到：玩家的問題、由牌卡組成的單宮盤象、四害狀態，以及引導卡、覺察卡、神諭卡。
四害狀態有三種情況，請這樣處理：
- 「牌面抽到，且符合真實奇門規則」：此象成立，請明確點出並提醒。
- 「僅牌面抽到，真實奇門規則未構成」：這是玩家這局實際抽到的牌，仍要當作這局的重要提醒來解讀，但不要說成真實奇門的凶象。
- 「牌面未抽到，但真實奇門規則成立」：玩家可能以為這一局沒有四害、事情會很順利，請溫和而清楚地指出，這組盤象在真實奇門中確實存在此害，需要留意。

你的任務：
- 只負責「解讀」，不要重新計算或質疑盤象。
- 一定要針對玩家的問題回答，給出具體、貼近生活的解讀與建議，避免空泛的話術。
- 把盤象（宮、門、星、神、天盤干代表外顯的一面、地盤干代表內在真實的一面）和問題連起來解讀。
- 自然地帶入引導卡的意象與引導問句、覺察卡的議題，讓玩家回頭看自己；若有神諭卡，用它的主旨作為結尾的一句提醒或祝福。引導問句可以原樣引用一次，讓玩家自己思考。
- 空無代表「虛」、「尚未成形」、「還沒定」。
- 不要過度恐嚇，也不要空洞安慰。
- 回覆控制在 450～650 字，用繁體中文，分 3～4 段，不要用條列式，語感像老師在跟人講解。`;

  const gameUserPrompt = `【玩家的問題】
${clip(question, 300) || '（玩家未輸入具體問題，請就整體盤象與牌卡做通用解讀）'}

【牌卡組成的盤象】
宮位：${clip(pan.palace, 10)}宮
八神：${clip(pan.shen, 10)}
八星：${clip(pan.star, 10)}
八門：${clip(pan.door, 10)}門
天盤干（外顯的一面）：${clip(pan.tianGan, 10)}
地盤干（內在真實的一面）：${clip(pan.diGan, 10)}
四害狀態：${gameHarmText}

【引導卡】
${clip(cards?.guide?.no, 5)}號「${clip(cards?.guide?.name, 40)}」
意象：${clip(cards?.guide?.desc, 200)}
引導問句：${clip(cards?.guide?.question, 120)}

【覺察卡】
${clip(cards?.aware?.no, 5)}號「${clip(cards?.aware?.topic, 20)}」
引導語：${clip(cards?.aware?.question, 120)}

【神諭卡】
${cards?.oracle ? `${clip(cards.oracle.no, 5)}號「${clip(cards.oracle.title, 60)}」` : '（玩家沒有使用神諭卡）'}

請根據以上內容，針對玩家的問題進行解讀。`;

  const systemPrompt = isGame ? gameSystemPrompt : `你是一位精通奇門遁甲的命理老師，語氣沉穩、專業、溫和，不譁眾取寵。
使用者會提供一組已經排算完成的「單宮盤象」資料（宮位、值符八神、八星、八門、天地盤干、以及是否犯門迫/擊刑/入墓/空無），
以及使用者想問的問題。

你的任務：
- 只負責「解讀」這組盤象資料，不要重新計算或質疑盤象本身是否正確，盤象已經用固定規則精算過。
- 針對使用者的問題，給出具體、實用、貼近生活的解讀與建議，避免空泛的話術。
- 如果盤中出現門迫、擊刑、入墓等凶象，要適度提醒使用者需留意的地方，但語氣不要過度恐嚇。
- 若有空無，說明這代表的「虛」、「暫緩」、「尚未成形」等意涵。
- 回覆控制在 300～450 字之間，用繁體中文，分 2～3 段呈現，不要用條列式，語感像是老師在跟人講解。`;

  const userPrompt = isGame ? gameUserPrompt : `【使用者問題】
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
        max_tokens: isGame ? 1500 : 1000,
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

    const interpretationText = text || '（AI 未回傳內容，請重新嘗試）';

    // 寫入歷史紀錄（失敗也不影響這次解盤結果照常回傳給使用者）
    const { error: historyError } = await supabase.from('readings').insert({
      line_user_id: lineUserId,
      question: question ? (isGame ? '【桌遊】' + question : question) : (isGame ? '【桌遊】' : null),
      palace: pan.palace,
      shen: pan.shen,
      star: pan.star,
      door: pan.door,
      tian_gan: pan.tianGan,
      di_gan: pan.diGan,
      interpretation: interpretationText,
    });
    if (historyError) {
      console.error('Insert reading history error:', historyError);
    }

    res.status(200).json({
      interpretation: interpretationText,
      usedFree,
      pointsBalance: newPointsBalance,
      freeUsesRemaining: newFreeUsesRemaining,
    });
  } catch (err) {
    console.error('Interpret handler error:', err);
    res.status(500).json({ error: '伺服器發生錯誤，請稍後再試' });
  }
};
