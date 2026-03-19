const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(bodyParser.json());
app.get('/health', (req, res) => res.status(200).send('OK'));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ===== セッション管理 =====
const sessions = new Map();
const sessionTimestamps = new Map();
const lastMessageTime = new Map();
const SESSION_TTL = 30 * 60 * 1000;

// ===== 商品判定 =====
const detectProduct = (text) => {
  if (!text) return null;

  if (text.includes('マンゴー') || text.toLowerCase().includes('mango')) {
    return 'マンゴー';
  }

  return null;
};

// ===== ref解析 =====
const getProductConfig = (ref) => {
  if (!ref) return null;

  if (ref.includes('mango_12')) {
    return { product: 'マンゴー', size: '12個（大玉）' };
  }
  if (ref.includes('mango_14')) {
    return { product: 'マンゴー', size: '14個（標準）' };
  }
  if (ref.includes('mango_16')) {
    return { product: 'マンゴー', size: '16個（小ぶり）' };
  }
  if (ref.includes('mango')) {
    return { product: 'マンゴー' };
  }
  if (ref.includes('consult')) {
    return { consult: true };
  }

  return null;
};

// ===== セッション取得 =====
const getSession = (senderId) => {
  const now = Date.now();

  if (
    sessionTimestamps.has(senderId) &&
    now - sessionTimestamps.get(senderId) > SESSION_TTL
  ) {
    sessions.delete(senderId);
  }

  sessionTimestamps.set(senderId, now);

  if (!sessions.has(senderId)) {
    sessions.set(senderId, []);
  }

  return sessions.get(senderId);
};

// ===== メッセージ送信 =====
const sendMessage = async (recipientId, text) => {
  await axios.post(
    `https://graph.facebook.com/v18.0/me/messages`,
    {
      recipient: { id: recipientId },
      message: { text }
    },
    {
      params: { access_token: process.env.PAGE_ACCESS_TOKEN }
    }
  );
};

// ===== GAS送信 =====
const sendToGAS = async (data) => {
  if (process.env.GAS_URL) {
    await axios.post(process.env.GAS_URL, data);
  }
};

// ===== Claude =====
const SYSTEM_PROMPT = `あなたは注文受付アシスタントです。

- 1質問ずつ
- シンプルに
- プレーンテキストのみ

ORDER_JSON:{"product":"","quantity":"","address":"","payment":"","timestamp":"","user_id":""}
`;

const getChatResponse = async (senderId, userMessage) => {
  const history = getSession(senderId);
  history.push({ role: 'user', content: userMessage });

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: history
  });

  const text = response.content[0].text;
  history.push({ role: 'assistant', content: text });

  return text;
};

// ===== リマインド =====
setInterval(() => {
  const now = Date.now();

  for (const [userId, time] of lastMessageTime.entries()) {
    if (now - time > 5 * 60 * 1000) {
      sendMessage(userId, 'ご注文の途中ですが続けますか？😊');
      lastMessageTime.delete(userId);
    }
  }
}, 60000);

// ===== Webhook =====
app.post('/webhook', async (req, res) => {
  const body = req.body;
  if (body.object !== 'page') return res.sendStatus(404);

  for (const entry of body.entry) {
    const event = entry.messaging[0];
    const senderId = event.sender.id;

    try {
      const ref =
        event.postback?.referral?.ref ||
        event.referral?.ref ||
        event.postback?.payload;

      // ===== ref処理 =====
      if (ref) {
        sessions.delete(senderId);

        const config = getProductConfig(ref.toLowerCase());

        if (config?.consult) {
          await sendMessage(senderId, '担当者が対応いたします。少々お待ちください🙏');
          continue;
        }

        if (config?.product === 'マンゴー') {
          const msg = config.size
            ? `ご利用ありがとうございます😊
こちらはAsiannetshopramaniの公式注文ページです。

${config.product}（${config.size}）ですね🥭
何ケースご希望ですか？

1 / 2 / 3 / 4以上（送料無料） / เจ้าหน้าที่に相談`
            : `ご利用ありがとうございます😊
こちらはAsiannetshopramaniの公式注文ページです。

${config.product}のご注文ですね🥭
何ケースご希望ですか？

1 / 2 / 3 / 4以上（送料無料） / เจ้าหน้าที่に相談`;

          sessions.set(senderId, [{ role: 'assistant', content: msg }]);
          await sendMessage(senderId, msg);
          continue;
        }

        await sendMessage(senderId, '担当者が対応いたします。少々お待ちください🙏');
        continue;
      }

      // ===== 通常メッセージ =====
      if (event.message?.text) {
        const userText = event.message.text.trim();
        lastMessageTime.set(senderId, Date.now());

// セッションなし
if (!sessions.has(senderId)) {

  const detected = detectProduct(userText);

  if (detected === 'マンゴー') {
    const msg = `ご利用ありがとうございます😊
こちらはAsiannetshopramaniの公式注文ページです。

マンゴーのご注文ですね🥭
何ケースご希望ですか？

1 / 2 / 3 / 4以上（送料無料） / เจ้าหน้าที่に相談`;

    sessions.set(senderId, [{ role: 'assistant', content: msg }]);
    await sendMessage(senderId, msg);
    continue;
  }

  // ★ これを必ず追加
  await sendMessage(senderId, '担当者が対応いたします。少々お待ちください🙏');

  await sendToGAS({
    type: 'operator_request',
    user_id: senderId,
    message: userText,
    timestamp: new Date().toISOString()
  });

  continue;
}
        // ===== Claude =====
        const reply = await getChatResponse(senderId, userText);

        if (reply.includes('ORDER_JSON:')) {
          const match = reply.match(/ORDER_JSON:(\{[\s\S]*?\})/);

          if (match) {
            const orderData = JSON.parse(match[1]);
            orderData.user_id = senderId;
            orderData.timestamp = new Date().toISOString();

            await sendToGAS(orderData);
            await sendMessage(senderId, 'ご注文ありがとうございます🙏');

            sessions.delete(senderId);
            continue;
          }
        }

        await sendMessage(senderId, reply);
      }

    } catch (err) {
      console.error(err);
    }
  }

  res.status(200).send('OK');
});

// ===== 起動 =====
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Bot running on ${PORT}`);
});