const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(bodyParser.json());

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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

// メッセージ受信 & 解析
app.post('/webhook', async (req, res) => {
  const body = req.body;
  if (body.object === 'page') {
    for (const entry of body.entry) {
      const webhook_event = entry.messaging[0];
      if (webhook_event.message && webhook_event.message.text) {
        const rawText = webhook_event.message.text;
        try {
          // Claude APIで解析
          const message = await client.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 1024,
            messages: [{
              role: 'user',
              content: `以下の注文メッセージから【氏名・郵便番号・住所・電話番号・注文内容・支払い方法】を抽出し、純粋なJSON形式のみで出力してください。マークダウン不要。
メッセージ: ${rawText}`
            }]
          });

          const responseText = message.content[0].text.replace(/```json|```/g, '').trim();
          const orderData = JSON.parse(responseText);

          // GASへ送信
          if (process.env.GAS_URL) {
            await axios.post(process.env.GAS_URL, {
              ...orderData,
              raw_text: rawText
            });
          }
          console.log("解析・送信完了:", orderData);
        } catch (error) {
          console.error("処理エラー:", error);
        }
      }
    }
    res.status(200).send('EVENT_RECEIVED');
  } else {
    res.sendStatus(404);
  }
});

const PORT = process.env.PORT || 3000;

console.log('=== Checking environment variables ===');
console.log('VERIFY_TOKEN:', process.env.VERIFY_TOKEN ? 'SET' : 'NOT SET');
console.log('ANTHROPIC_API_KEY:', process.env.ANTHROPIC_API_KEY ? 'SET' : 'NOT SET');
console.log('GAS_URL:', process.env.GAS_URL ? 'SET' : 'NOT SET');
console.log('=====================================');

app.listen(PORT, () => {
  console.log(`Messenger Bot is running on port ${PORT}`);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled Error:', err);
});
