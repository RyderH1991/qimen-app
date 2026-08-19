// api/interpret.js
// Vercel Serverless Function：接收前端傳來的盤象資料 + 使用者問題，
// 呼叫 Claude API 做奇門遁甲解盤，回傳解讀文字給前端。
//
// 注意：ANTHROPIC_API_KEY 是從 Vercel 的環境變數讀取，
// 絕對不要把金鑰寫死在程式碼裡。

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

  const { question, pan } = req.body || {};

  if (!pan || !pan.palace) {
    res.status(400).json({ error: '缺少盤象資料（pan）' });
    return;
  }

  // ---- 把四害狀態轉成人類可讀的文字 ----
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

    res.status(200).json({ interpretation: text || '（AI 未回傳內容，請重新嘗試）' });
  } catch (err) {
    console.error('Interpret handler error:', err);
    res.status(500).json({ error: '伺服器發生錯誤，請稍後再試' });
  }
};
