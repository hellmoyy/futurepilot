// bot.js

import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
import { saveApiCredentials, getApiCredentials } from './db.js'
dotenv.config(); // otomatis baca .env

// Ambil token dari .env
const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('⚠️ BOT_TOKEN belum di-set di .env!');
  process.exit(1);
}

// Buat instance bot dengan polling
const bot = new TelegramBot(token, { polling: true });
console.log('🚀 Bot jalan pakai long-polling');


// Di bot.js, setelah inisialisasi `bot`:

// 1. Handler /help
bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  const helpMsg = `
📖 *Daftar Command*:
/help – Tampilkan bantuan  
/connect_binance <API_KEY> <SECRET> – Sambung Binance  
/connect_bybit <API_KEY> <SECRET> – Sambung Bybit  
(kirimi chart pakai foto, lalu bot analisa)
  `;
  bot.sendMessage(chatId, helpMsg, { parse_mode: 'Markdown' });
});


bot.onText(/\/connect_(binance|bybit) (\S+) (\S+)/, (msg, match) => {
  const chatId = msg.chat.id
  const [, ex, apiKey, secret] = match
  saveApiCredentials(chatId, ex, { apiKey, secret })
  bot.sendMessage(chatId, `✅ ${ex.toUpperCase()} connected!`)
})

const creds = getApiCredentials(chatId)
if (creds.binance) { /* tombol Binance */ }
if (creds.bybit)   { /* tombol Bybit */ }