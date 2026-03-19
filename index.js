const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(bodyParser.json());
app.get('/health', (req, res) => res.status(200).send('OK'));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// 会話セッション管理
const sessions = new Map();

// オペレーター切替キーワード（タイ語）
const OPERATOR_KEYWORDS = ['เจ้าหน้าที่', 'ติดต่อคน', 'ขอคุยกับคน'];

// 注文完了メッセージ
const ORDER_COMPLETE_MSG = `ご注文ありがとうございました！確認後にご連絡いたします🙏
ขอบคุณสำหรับคำสั่งซื้อ! เราจะติดต่อกลับหลังจากตรวจสอบแล้ว🙏
Thank you for your order! We will contact you after confirmation🙏`;

// システムプロンプト
const SYSTEM_PROMPT = `あなたはFacebook Messenger上で動作する注文受付アシスタントです。
目的は「マンゴーの注文を正確に取得し、途中離脱を防ぎながら、必要に応じて人間オペレーターへ自然に引き継ぐこと」です。

# 基本ルール
- 会話は必ず「アンケート形式（1質問ずつ）」で進める
- 一度に複数の質問をしない
- ユーザーが迷わないよう、選択肢を明確に提示する
- 常に「เจ้าหน้าที่に相談する」選択肢を提示する
- ユーザーが自由入力しても意図を汲み取り、適切に次の質問へ進める
- マークダウン記法（*, **, ---, #など）は絶対に使わない
- プレーンテキストのみで返答する

# トーン
- 親切・シンプル・安心感
- 短く、わかりやすく
- 日本語・タイ語両対応

# 会話フロー
## 1. 数量確認
「何ケースご注文されますか？」
選択肢：1ケース / 2ケース / 3ケース / 4ケース以上 / เจ้าหน้าที่に相談

## 2. 配送先
「配送先のご住所を入力してください」
郵便番号・住所・氏名・電話番号を含めるよう案内

## 3. 支払い方法
「お支払い方法を選択してください」
選択肢：銀行振込 / その他 / เจ้าหน้าที่に相談

## 4. 最終確認
「以下の内容でよろしいですか？」
商品・数量・配送先・支払い方法を表示

## 5. 完了
注文確定時、以下のJSON形式のみを含むメッセージを出力：
ORDER_JSON:{"product":"mango","quantity":"","address":"","payment":"","timestamp":"","user_id":""}

# オペレーター切替
以下の場合は「担当者が対応いたします。少々お待ちください🙏」と返す：
- ユーザーが「เจ้าหน้าที่」などを送信
- 入力が2回以上不明確
- クレーム・トラブル`;

// Facebook Send API
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

// refに応じた挨拶メッセージ
const getWelcomeMessage = (ref) => {
  const messages = {
    mango: '🥭 Thai Premium Food Club Japan へようこそ！\nマンゴーのご注文ページです。\nご希望の内容を順番にお伺いします。\n\n「注文をはじめる」と送ってください😊'
  };
  return messages[ref] || '🌟 Thai Premium Food Club Japan へようこそ！';
};

// Claude APIで応答生成
const getChatResponse = async (senderId, userMessage) => {
  if (!sessions.has(senderId)) {
    sessions.set(senderId, []);
  }
  const history = sessions.get(senderId);
  history.push({ role: 'user', content: userMessage });

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: history
  });

  const assistantText = response.content[0].text;
  history.push({ role: 'assistant', content: assistantText });
  sessions.set(senderId, history);

  return assistantText;
};

// GASへ注文データ送信
const sendToGAS = async (orderData) => {
  if (process.env.GAS_URL) {
    await axios.post(process.env.GAS_URL, orderData);
  }
};

// Facebook Webhook検証
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

// メッセージ受信
app.post('/webhook', async (req, res) => {
  const body = req.body;
  if (body.object !== 'page') return res.sendStatus(404);

  for (const entry of body.entry) {
    const event = entry.messaging[0];
    const senderId = event.sender.id;

    try {
      // refを受け取る（m.meリンクからの流入）
      const ref =
        event.postback?.referral?.ref ||
        event.referral?.ref ||
        event.postback?.payload;

      if (ref) {
        sessions.delete(senderId); // セッションリセット
        const welcome = getWelcomeMessage(ref.toLowerCase());
        await sendMessage(senderId, welcome);
        continue;
      }

      // 通常メッセージ
      if (event.message?.text) {
        const userText = event.message.text.trim();

        // オペレーター切替チェック
        if (OPERATOR_KEYWORDS.some(kw => userText.includes(kw))) {
          sessions.delete(senderId);
          await sendMessage(senderId, '担当者が対応いたします。少々お待ちください🙏');
          continue;
        }

        // Claude APIで会話
        const reply = await getChatResponse(senderId, userText);

        // 注文完了JSONの検出
        if (reply.includes('ORDER_JSON:')) {
          const jsonMatch = reply.match(/ORDER_JSON:(\{.*\})/);
          if (jsonMatch) {
            const orderData = JSON.parse(jsonMatch[1]);
            orderData.user_id = senderId;
            orderData.timestamp = new Date().toISOString();
            await sendToGAS({ ...orderData, raw_text: userText });
            await sendMessage(senderId, ORDER_COMPLETE_MSG);
            sessions.delete(senderId);
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

const PORT = process.env.PORT || 3000;

console.log('=== Checking environment variables ===');
console.log('VERIFY_TOKEN:', process.env.VERIFY_TOKEN ? 'SET' : 'NOT SET');
console.log('ANTHROPIC_API_KEY:', process.env.ANTHROPIC_API_KEY ? 'SET' : 'NOT SET');
console.log('PAGE_ACCESS_TOKEN:', process.env.PAGE_ACCESS_TOKEN ? 'SET' : 'NOT SET');
console.log('GAS_URL:', process.env.GAS_URL ? 'SET' : 'NOT SET');
console.log('=====================================');

app.listen(PORT, () => {
  console.log(`Messenger Bot is running on port ${PORT}`);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled Error:', err);
});