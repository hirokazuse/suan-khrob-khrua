const express = require('express');
const bodyParser = require('body-parser');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const axios = require('axios'); // GASへの送信に使用

const app = express();
app.use(bodyParser.json());

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Facebook Webhook検証用
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
          // 1. Geminiでテキスト解析
          const model = genAI.getGenerativeModel({ model: "gemini-3-flash" });
          //const model = genAI.getGenerativeModel({ model: "models/gemini-1.5-flash" });
          //const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });
          //const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
          //const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });
          const prompt = `以下の注文メッセージから【氏名・郵便番号・住所・電話番号・注文内容・支払い方法】を抽出し、純粋なJSON形式で出力してください。
          郵便番号はハイフンを入れてください。
          メッセージ: ${rawText}`;

          const result = await model.generateContent(prompt);
          const response = await result.response;
          const orderData = JSON.parse(response.text().replace(/```json|```/g, ''));

          // 2. Google Drive (GAS) へ送信
          // GASのWebアプリURLを環境変数 GAS_URL に設定しておく想定です
          if (process.env.GAS_URL) {
            await axios.post(process.env.GAS_URL, {
              ...orderData,
              raw_text: rawText // 元データも保存
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

//const PORT = process.env.PORT || 3000;
//app.listen(PORT, () => console.log(`Messenger Bot is running on port ${PORT}`));
const PORT = process.env.PORT || 3000;

// 環境変数チェック
console.log('=== Checking environment variables ===');
console.log('VERIFY_TOKEN:', process.env.VERIFY_TOKEN ? 'SET' : 'NOT SET');
console.log('GEMINI_API_KEY:', process.env.GEMINI_API_KEY ? 'SET' : 'NOT SET');
console.log('GAS_URL:', process.env.GAS_URL ? 'SET' : 'NOT SET');
console.log('=====================================');

app.listen(PORT, () => {
  console.log(`Messenger Bot is running on port ${PORT}`);
});

// エラーハンドラ
process.on('unhandledRejection', (err) => {
  console.error('Unhandled Error:', err);
});
