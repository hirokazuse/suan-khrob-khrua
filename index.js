const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(bodyParser.json());
app.get('/health', (req, res) => res.status(200).send('OK'));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ===== セッション管理（TTL付き）=====
const sessions = new Map();
const sessionTimestamps = new Map();
const lastMessageTime = new Map();

const SESSION_TTL = 30 * 60 * 1000; // 30分

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

// ===== オペレーターキーワード =====
const OPERATOR_KEYWORDS = ['เจ้าหน้าที่', 'ติดต่อคน', 'ขอคุยกับคน'];

// ===== 注文完了メッセージ =====
const ORDER_COMPLETE_MSG = `ご注文ありがとうございました！確認後にご連絡いたします🙏
ขอบคุณสำหรับคำสั่งซื้อ! เราจะติดต่อกลับหลังจากตรวจสอบแล้ว🙏
Thank you for your order! We will contact you after confirmation🙏`;

// ===== システムプロンプト（強化版）=====
const SYSTEM_PROMPT = `あなたはFacebook Messenger上で動作する注文受付アシスタントです。
目的は「マンゴーの注文を正確に取得し、途中離脱を防ぎながら、必要に応じて人間オペレーターへ自然に引き継ぐこと」です。

# 基本ルール
- 会話は必ずアンケート形式（1質問ずつ）
- 一度に複数質問しない
- 必ず選択肢を提示
- 常に「เจ้าหน้าที่に相談する」を含める
- プレーンテキストのみ

# 売上最大化ルール
- 4ケース以上で送料無料
- 数量選択時に「まとめるとお得」と伝える
- 迷っている場合は自然に4ケースを提案

# トーン
- 短く・親切・安心感
- 日本語＋タイ語

# フロー
1 数量確認
2 配送先
3 支払い
4 確認
5 完了（JSON出力）

# JSON形式
ORDER_JSON:{"product":"mango","quantity":"","address":"","payment":"","timestamp":"","user_id":""}

# オペレーター条件
- キーワード検出
- 不明確な入力2回
- クレーム`;

// ===== Facebook送信 =====
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

// ===== ウェルカム =====
const getWelcomeMessage = (ref) => {
  const messages = {
    mango: '🥭 Thai Premium Food Club Japanへようこそ！\nマンゴー注文です。\n\nそのまま「注文」と送ってください😊'
  };
  return messages[ref] || '🌟 ようこそ！';
};

// ===== Claude応答 =====
const getChatResponse = async (senderId, userMessage) => {
  const history = getSession(senderId);
  history.push({ role: 'user', content: userMessage });

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: history
  });

  const assistantText = response.content[0].text;
  history.push({ role: 'assistant', content: assistantText });

  return assistantText;
};

// ===== GAS送信 =====
const sendToGAS = async (data) => {
  if (process.env.GAS_URL) {
    await axios.post(process.env.GAS_URL, data);
  }
};

// ===== 離脱リマインド =====
setInterval(() => {
  const now = Date.now();

  for (const [userId, time] of lastMessageTime.entries()) {
    if (now - time > 5 * 60 * 1000) {
      sendMessage(
        userId,
        'ご注文の途中ですが続けますか？😊\nเจ้าหน้าที่に相談もできます'
      );
      lastMessageTime.delete(userId);
    }
  }
}, 60000);

// ===== Webhook検証 =====
app.get('/webhook', (req, res) => {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ===== メッセージ受信 =====
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

      if (ref) {
        sessions.delete(senderId);
        const welcome = getWelcomeMessage(ref.toLowerCase());
        await sendMessage(senderId, welcome);
        continue;
      }

      if (event.message?.text) {
        const userText = event.message.text.trim();

        lastMessageTime.set(senderId, Date.now());

        // 開始トリガー
        if (userText.includes('注文') || userText.toLowerCase().includes('start')) {
          sessions.delete(senderId);
        }

        // オペレーター
        if (OPERATOR_KEYWORDS.some(kw => userText.includes(kw))) {
          await sendToGAS({
            type: 'operator_request',
            user_id: senderId,
            message: userText,
            timestamp: new Date().toISOString()
          });

          sessions.delete(senderId);
          await sendMessage(senderId, '担当者が対応いたします。少々お待ちください🙏');
          continue;
        }

        const reply = await getChatResponse(senderId, userText);

        // JSON検出（改善版）
        if (reply.includes('ORDER_JSON:')) {
          const jsonMatch = reply.match(/ORDER_JSON:(\{[\s\S]*?\})/);

          if (jsonMatch) {
            const orderData = JSON.parse(jsonMatch[1]);
            orderData.user_id = senderId;
            orderData.timestamp = new Date().toISOString();

            await sendToGAS({ ...orderData, raw_text: userText });
            await sendMessage(senderId, ORDER_COMPLETE_MSG);

            sessions.delete(senderId);
            lastMessageTime.delete(senderId);
            continue;
          }
        }

        await sendMessage(senderId, reply);
      }

    } catch (error) {
      console.error('処理エラー:', error);
    }
  }

  res.status(200).send('EVENT_RECEIVED');
});

// ===== 起動 =====
const PORT = process.env.PORT || 3000;

console.log('=== ENV CHECK ===');
console.log('VERIFY_TOKEN:', process.env.VERIFY_TOKEN ? 'OK' : 'NG');
console.log('ANTHROPIC_API_KEY:', process.env.ANTHROPIC_API_KEY ? 'OK' : 'NG');
console.log('PAGE_ACCESS_TOKEN:', process.env.PAGE_ACCESS_TOKEN ? 'OK' : 'NG');
console.log('GAS_URL:', process.env.GAS_URL ? 'OK' : 'NG');

app.listen(PORT, () => {
  console.log(`Bot running on ${PORT}`);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled Error:', err);
});