// scripts/setWebhook.js
import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
dotenv.config();

const bot   = new TelegramBot(process.env.BOT_TOKEN);
const url   = process.env.APP_URL; // e.g. https://xxxxx.ngrok.io
const hook  = `${url}/api/webhook`;

bot.setWebHook(hook)
  .then(() => console.log('✅ Webhook terdaftar di', hook))
  .catch(console.error);