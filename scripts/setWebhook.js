// scripts/setWebhook.js
import TelegramBot from 'node-telegram-bot-api';

const token = process.env.BOT_TOKEN;
const bot = new TelegramBot(token);
const url = process.env.APP_URL; // eg. https://myapp.vercel.app
bot.setWebHook(`${url}/api/webhook`).then(() => {
  console.log('Webhook terdaftar!');
});