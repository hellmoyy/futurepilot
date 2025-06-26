// pages/api/webhook.js
import TelegramBot from 'node-telegram-bot-api';

export const config = { api: { bodyParser: false } };

const token = process.env.BOT_TOKEN;
const bot = new TelegramBot(token);

export default async function handler(req, res) {
  if (req.method === 'POST') {
    const buf = await buffer(req);
    const update = JSON.parse(buf.toString());
    // Contoh: balas setiap pesan masuk dengan “Pong!”
    if (update.message && update.message.text) {
      await bot.sendMessage(update.message.chat.id, 'Pong! 🤖');
    }
    res.status(200).send('OK');
  } else {
    res.status(405).end();
  }
}

// util untuk Next.js buffer
async function buffer(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}