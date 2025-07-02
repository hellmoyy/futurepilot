// bot.js
import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
import axios from 'axios';
import Sentiment from 'sentiment';
const sentiment = new Sentiment();
import { detectSymbolFromImage } from './ocr.js';
import { analyzeChartData, generateDetailedAnalysis } from './analysis.js';
import { saveApiCredentials, getApiCredentials, getSubscription, saveSubscription, getAllChatIds,
         getTradeHistoryPaged, getTradeHistoryByPeriod } from './db.server.js';
import { calcATR, calcSLTP, /* calcQuantity, */ confirmSignal } from './riskManager.js';
import { ensurePro } from './middleware.server.js';
import ccxt from 'ccxt';
import { startLivePnLTracking } from './services/livePnL.js';
// Tambahkan di bagian atas bot.js
import cron from 'node-cron';
import Parser from 'rss-parser';
import { ensembleConfirm } from './riskManager.js';


// ===== Brand Voice & Emoji Helpers =====
const EMOJI = {
  signal: '🎯',     // untuk analisis chart
  execution: '🚀',  // untuk order execution
  info: '⚡',       // untuk info umum
  warn: '⚠️',      // untuk peringatan/error
  success: '✅'     // untuk konfirmasi sukses
};

function formatHeader(type, title) {
  return `${EMOJI[type]} *${title}*\n`;
}
function formatFooter(type, text) {
  return `\n${EMOJI[type]} _${text}_`;
}
// ========================================

// Store active trades per chat as an array for multiple positions
const liveTrades = {}; // key: chatId, value: array of trades
// Live PnL globals
const tickerCache = {}; // { symbol: { price, timestamp } }
// Default update interval in ms
const DEFAULT_PNL_INTERVAL = 30000;
// Temporary store for mapping user to file, symbols, and execution contexts
const tempStore = {};

// Number of history entries per page
const HISTORY_PAGE_SIZE = 10;

// Global error handlers to capture unlogged crashes
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

const rssParser = new Parser();
const RSS_FEEDS = [
  { name: 'CoinDesk',      url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
  { name: 'CoinTelegraph', url: 'https://cointelegraph.com/rss' }
];
const seenRss = new Set();


dotenv.config();

if (!process.env.MAYAR_API_BASE) {
  console.error('⚠️ MAYAR_API_BASE belum di-set di .env');
  process.exit(1);
}
// Use base URL (including /hl/v1) directly from environment
const MAYAR_BASE = process.env.MAYAR_API_BASE.replace(/\/$/, '');

if (!process.env.MAYAR_CALLBACK_URL) {
  console.error('⚠️ MAYAR_CALLBACK_URL belum di-set di .env');
  process.exit(1);
}
if (!process.env.MAYAR_DEFAULT_CHANNEL_ID) {
  console.error('⚠️ MAYAR_DEFAULT_CHANNEL_ID belum di-set di .env');
  process.exit(1);
}
const DEFAULT_CHANNEL_ID = process.env.MAYAR_DEFAULT_CHANNEL_ID;

import mongoose from 'mongoose';

// Ambil token dari .env
const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('⚠️ BOT_TOKEN belum di-set di .env!');
  process.exit(1);
}

// Inisialisasi bot dengan long-polling
const bot = new TelegramBot(token, { polling: true });
bot.on('polling_error', (err) => {
  console.error('Polling Error:', err);
});
bot.on('webhook_error', (err) => {
  console.error('Webhook Error:', err);
});
console.log('🚀 Bot jalan pakai long-polling');

// Start ML-enabled live PnL tracking
startLivePnLTracking(bot, liveTrades);

// Setelah console.log('🚀 Bot jalan pakai long-polling');
bot.setMyCommands([
  { command: 'dashboard', description: 'Show and pin your dashboard summary' },
  { command: 'subscribe', description: 'Berlangganan Pro 298rb/bln' }
]);

// Connect to MongoDB for bot operations
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => {
  console.log('✅ MongoDB connected for bot');

  // Command /subscribe - create and send Mayar.id invoice for Pro subscription
  bot.onText(/\/subscribe/, async (msg) => {
    const chatId = msg.chat.id;
    // Check existing subscription
    const sub = await getSubscription(chatId);
    const now = new Date();
    if (sub && sub.status === 'paid' && sub.validUntil > now) {
      return bot.sendMessage(chatId,
        `✅ Langganan *Pro* kamu sudah aktif hingga ${sub.validUntil.toLocaleDateString()}.`,
        { parse_mode: 'Markdown' }
      );
    }
    // If invoice pending, resend link
    if (sub && sub.status === 'pending') {
      // Use stored paymentUrl (contains correct slug)
      const customPendingUrl = sub.paymentUrl;
      return bot.sendMessage(chatId,
        `💳 Pembayaran masih menunggu.
Klik link berikut untuk menyelesaikan pembayaran:
${customPendingUrl}`,
        { parse_mode: 'Markdown', disable_web_page_preview: true }
      );
    }
    try {
      // Create Invoice via Headless API (per Mayar docs)
      const callbackUrl = process.env.MAYAR_CALLBACK_URL;
      const invoiceUrl = `${MAYAR_BASE}/invoice/create`;
      console.log('📥 Final invoice creation URL:', invoiceUrl);
      // Set expiration time for 24 hours from now
      const expiredAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      // Build payload as per Mayar requirements
      const invoicePayload = {
        name: 'FuturePilot Pro – 1 bulan',
        email: msg.from.username ? `${msg.from.username}@telegram.com` : 'user@example.com',
        // Use chatId string as mobile per new requirement, prefixed with 0
        mobile: '0' + String(chatId),
        redirectUrl: callbackUrl,
        description: 'FuturePilot Pro – 1 bulan',
        expiredAt,
        items: [
          { description: 'FuturePilot Pro – 1 bulan', rate: 12000, quantity: 1 }
        ],
        custom_fields: [
          { key: 'chat_id', value: String(chatId) }
        ]
      };
      console.log('🛠️ Creating invoice with payload:', invoicePayload);
      const resp = await axios.post(invoiceUrl, invoicePayload, {
        headers: { Authorization: `Bearer ${process.env.MAYAR_API_KEY}` }
      });
      console.log('📤 Invoice response data:', JSON.stringify(resp.data, null, 2));
      // Debug: log response
      console.log('🛠️ Invoice creation response:', resp.data);
      const { 
        id: invoiceId, 
        link, 
        expiredAt: invoiceExpiredAt,
        transactionId
      } = resp.data.data;
      // Compute validUntil based on invoiceExpiredAt
      const validUntil = invoiceExpiredAt ? new Date(invoiceExpiredAt) : null;
      console.log('⏳ Initial validUntil from expiredAt:', validUntil);
      // Extract `link` field from Mayar response (contains payment URL)
      const paymentUrlRaw = link || undefined;
      console.log('🔍 Raw payment link from response:', paymentUrlRaw);
      // Optionally transform domain if needed, e.g., change to myr.id domain
      const paymentUrl = paymentUrlRaw.replace('futurepilot.pro', 'futurepilot.myr.id');
      console.log('▶️ Using paymentUrl:', paymentUrl);
      console.log('🔥 /subscribe SUCCESS branch, saving:', { chatId, invoiceId, paymentUrl, validUntil });
      await saveSubscription({
        chatId,
        invoiceId,
        transactionId,
        status: 'pending',
        paymentUrl,
        validUntil,
      });
      return bot.sendMessage(chatId,
        `💳 *Langganan Pro* – Rp 12.000/bulan\n` +
        `Klik link berikut untuk melakukan pembayaran:\n${paymentUrl}\n\n` +
        `_Setelah pembayaran sukses, langganan akan otomatis aktif._`,
        { parse_mode: 'Markdown', disable_web_page_preview: true }
      );
    } catch (e) {
      if (e.response?.status === 409) {
        console.warn('⚠️ Mayar invoice already exists:', e.response.data);
        const sub = await getSubscription(chatId);
        if (sub && sub.invoiceId) {
          // Always use custom URL for 409 branch.
          const customUrl = `https://futurepilot.pro/invoices/${sub.invoiceId}`;
          return bot.sendMessage(chatId,
            `💳 Pembayaran masih menunggu. Klik link berikut untuk menyelesaikan pembayaran:\n${customUrl}`,
            { disable_web_page_preview: true }
          );
        }
        return bot.sendMessage(chatId,
          `⚠️ Tagihan sudah dibuat tetapi tidak ditemukan di database. Silakan hubungi support.`,
          { disable_web_page_preview: true }
        );
      }
      if (e.response?.status === 400) {
        console.error('⚠️ Mayar validation errors:', JSON.stringify(e.response.data.data, null, 2));
        return bot.sendMessage(chatId,
          '⚠️ Gagal membuat invoice: data tidak valid. Cek log server untuk detail validasi.'
        );
      }
      if (e.response?.status === 404) {
        console.error('Mayar endpoint tidak ditemukan:', e.response.data);
        return bot.sendMessage(chatId,
          '⚠️ Gagal membuat invoice: endpoint Mayar tidak ditemukan (404). ' +
          'Periksa `MAYAR_API_BASE` di .env.'
        );
      }
      console.error('Create invoice error:', e);
      return bot.sendMessage(chatId,
        `⚠️ Gagal membuat invoice: ${e.message}\n` +
        `Silakan coba lagi nanti.`
      );
    }
  });

}).catch(err => {
  console.error('❌ MongoDB connection error for bot:', err);
});

// Command to start PnL tracking
bot.onText(/\/track/, (msg) => {
  const chatId = msg.chat.id;
  (async () => {
    let allowed = false;
    await ensurePro(chatId, bot, async () => { allowed = true; });
    if (!allowed) return;
    if (!liveTrades[chatId]) {
      return bot.sendMessage(chatId, '⚠️ Belum ada trade aktif untuk dilacak. Eksekusi order dulu.');
    }
    return bot.sendMessage(chatId, '✅ Mulai memantau live PnL untuk trade aktif.');
  })();
});

// Command to stop PnL tracking
bot.onText(/\/stoptrack/, (msg) => {
  const chatId = msg.chat.id;
  (async () => {
    let allowed = false;
    await ensurePro(chatId, bot, async () => { allowed = true; });
    if (!allowed) return;
    delete liveTrades[chatId];
    return bot.sendMessage(chatId, '✅ Live PnL tracking dihentikan.');
  })();
});


// Cron job untuk polling RSS feeds
cron.schedule('*/15 * * * *', async () => {
  const chatIds = await getAllChatIds();
  for (let feed of RSS_FEEDS) {
    try {
      const parsed = await rssParser.parseURL(feed.url);
      for (let item of parsed.items.slice(0, 5)) {
        if (seenRss.has(item.link)) continue;
        seenRss.add(item.link);
        // Send only to users who enabled News
        for (let chatId of chatIds) {
          // Only send to active subscribers
          const sub = await getSubscription(chatId);
          const now = new Date();
          if (!sub || sub.status !== 'paid' || (sub.validUntil && new Date(sub.validUntil) < now)) {
            continue;
          }
          const creds = await getApiCredentials(chatId);
          if (!creds.settings.useNews) continue;
          const title = item.title || 'No title';
          const shortTitle = title.length > 80
            ? title.slice(0, 77) + '…'
            : title;
          const msg = `📰 *${feed.name}*\n${shortTitle}\n🔗 ${item.link}`;
          try {
            await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
          } catch (e) {
            console.warn(`Gagal kirim RSS ke ${chatId}: ${e.message}`);
          }
          await new Promise(r => setTimeout(r, 100));
        }
      }
    } catch (e) {
      console.error(`RSS fetch error (${feed.name}):`, e.message);
    }
  }
});


// Command /start - display user settings buttons and main menu
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  let allowed = false;
  await ensurePro(chatId, bot, async () => { allowed = true; });
  if (!allowed) return;
  const creds = await getApiCredentials(chatId);
  const hasBybit = Boolean(creds.bybit?.apiKey);
  const defaultCex = creds.settings.defaultCex || 'bybit';
  const hasBinance = Boolean(creds.binance?.apiKey);
  // Per-user risk percentage setting (default 1%)

  // Main menu reply keyboard with Dashboard restored
  const replyKeyboard = {
    reply_markup: {
      keyboard: [
        ['📌 Dashboard', '🚀 Trade'],
        ['⚙️ Settings', '❔ Help']
      ],
      resize_keyboard: true
    }
  };

  // Send main menu
  await bot.sendMessage(chatId,
    `👋 Selamat datang di FuturePilot!\nPilih menu utama:`,
    replyKeyboard
  );
  // CEX setup inline buttons under /start
  const cexInline = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: hasBybit   ? '✅ Bybit API'   : '🔑 Set Bybit API',   callback_data: 'setting|api_bybit' },
          { text: hasBinance ? '✅ Binance API' : '🔑 Set Binance API', callback_data: 'setting|api_binance' }
        ],
        [
          { text: `💠 Default CEX: ${defaultCex.toUpperCase()}`, callback_data: 'setting|default_cex' }
        ],
        ...(hasBybit   ? [[{ text: '❌ Disconnect Bybit',   callback_data: 'setting|disconnect_bybit'   }]] : []),
        ...(hasBinance ? [[{ text: '❌ Disconnect Binance', callback_data: 'setting|disconnect_binance' }]] : [])
      ]
    }
  };
  await bot.sendMessage(chatId, '🔧 CEX Configuration:', cexInline);
});
// Command /dashboard - show user dashboard summary
// Command /dashboard - show user dashboard summary
bot.onText(/\/dashboard|📌 Dashboard/, async (msg) => {
  const chatId = msg.chat.id;
  let allowed = false;
  await ensurePro(chatId, bot, async () => { allowed = true; });
  if (!allowed) return;

  // 1. Status langganan Pro
  const sub   = await getSubscription(chatId);
  const now   = new Date();
  let subStatus = '❌ Tidak berlangganan';
  if (sub) {
    if (sub.status === 'paid' && sub.validUntil > now) {
      subStatus = `✅ Aktif hingga ${new Date(sub.validUntil).toLocaleDateString()}`;
    } else if (sub.status === 'pending') {
      subStatus = '⏳ Pending pembayaran';
    } else if (sub.status === 'cancelled') {
      subStatus = '❌ Langganan dibatalkan';
    }
  }

  // 2. Saldo USDT di Bybit & Binance (Spot dan Futures terpisah)
  const creds = await getApiCredentials(chatId);
  let bybitBalance = '–', binanceFutures = '–', binanceSpot = '–';
  try {
    if (creds.bybit?.apiKey) {
      // (unchanged)
      const c = new ccxt.bybit({
        apiKey: creds.bybit.apiKey,
        secret: creds.bybit.secret,
        defaultType: 'swap',
        enableRateLimit: true,
        options: { defaultSettle: 'USDT' },
      });
      await c.loadMarkets();
      const bal = (await c.fetchBalance({ type: 'future' })).free.USDT;
      bybitBalance = `${bal.toFixed(4)} USDT`;
    }
    if (creds.binance?.apiKey) {
      const c = new ccxt.binance({
        apiKey: creds.binance.apiKey,
        secret: creds.binance.secret,
        defaultType: 'future',
        enableRateLimit: true,
      });
      await c.loadMarkets();
      // Fetch futures
      try {
        const fut = await c.fetchBalance({ type: 'future' });
        binanceFutures = fut.free.USDT !== undefined ? `${fut.free.USDT.toFixed(4)} USDT` : '–';
      } catch (e) {
        binanceFutures = '–';
      }
      // Fetch spot
      try {
        const spot = await c.fetchBalance();
        binanceSpot = spot.free.USDT !== undefined ? `${spot.free.USDT.toFixed(4)} USDT` : '–';
      } catch (e) {
        binanceSpot = '–';
      }
    }
  } catch (e) {
    console.warn('Dashboard: gagal fetch balance →', e.message);
  }

  // 3. Pengaturan leverage & risk
  const riskPct  = creds.settings.defaultRisk !== undefined ? creds.settings.defaultRisk : 1;
  const leverage = creds.settings.leverage || 1;

  // 4. Ringkasan posisi aktif
  const positions = liveTrades[chatId] || [];
  let posText = positions.length
    ? '\n*Posisi Aktif:*\n' + positions.map(p =>
        `• ${p.symbol} | ${p.side.toUpperCase()} | Qty: ${p.qty} | Entry: ${p.entry}`
      ).join('\n')
    : '\nTidak ada posisi aktif.';

  // 5. Bangun dan kirim pesan dashboard
  const dashMsg =
    formatHeader('info', 'Dashboard') +
    `• Status Pro: ${subStatus}\n` +
    `• Saldo Bybit: ${bybitBalance}\n` +
    `• Binance Futures: ${binanceFutures}\n` +
    `• Binance Spot: ${binanceSpot}\n` +
    `• Leverage: ${leverage}×\n` +
    `• Risk: ${riskPct}%` +
    posText +
    formatFooter('info', 'Gunakan /trade untuk melihat posisi.');

  await bot.sendMessage(chatId, dashMsg, { parse_mode: 'Markdown' });
});

// Command /help
bot.onText(/\/help|❔ Help/, (msg) => {
  const chatId = msg.chat.id;
  (async () => {
    let allowed = false;
    await ensurePro(chatId, bot, async () => { allowed = true; });
    if (!allowed) return;
    const helpMsg = `
📖 *Daftar Command*:
/start – Tampilkan menu utama
/dashboard – Tampilkan ringkasan dashboard
/settings – Atur preferensi (risiko, leverage, CEX, dll.)
/track – Mulai memantau live PnL
/stoptrack – Hentikan live PnL tracking
/connect_bybit <API_KEY> <SECRET> – Sambung Bybit
/connect_binance <API_KEY> <SECRET> – Sambung Binance
Kirim chart dengan caption "ETH/USDT" atau biarkan bot deteksi otomatis.
    `;
    bot.sendMessage(chatId, helpMsg, { parse_mode: 'Markdown' });
  })();
});

// Command /trade or 🚀 Trade - show basic positions menu
bot.onText(/\/trade|🚀 Trade/, async (msg) => {
  const chatId = msg.chat.id;
  let allowed = false;
  await ensurePro(chatId, bot, async () => { allowed = true; });
  if (!allowed) return;
  const tradeMenu = {
    reply_markup: {
      inline_keyboard: [
        [ { text: '🔍 Positions', callback_data: 'trade|view_positions' } ],
        [ { text: '⏳ History', callback_data: 'history' } ],
        [ { text: '❌ Close All', callback_data: 'trade|close_all' } ]
      ]
    }
  };
  await bot.sendMessage(chatId, '🔧 Menu Trade:', tradeMenu);
});



// Command connect ke exchange
bot.onText(/\/connect_(binance|bybit) (\S+) (\S+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  let allowed = false;
  await ensurePro(chatId, bot, async () => { allowed = true; });
  if (!allowed) return;
  const [, ex, apiKey, secret] = match;
  try {
    await saveApiCredentials(chatId, ex, { apiKey, secret });
    await bot.sendMessage(chatId, `✅ ${ex.toUpperCase()} connected!`);
  } catch (e) {
    console.error(e);
    await bot.sendMessage(chatId, `⚠️ Gagal menyimpan kredensial: ${e.message}`);
  }
});




// Command /cancelinvoice – cancel a pending invoice
bot.onText(/\/cancelinvoice/, async (msg) => {
  const chatId = msg.chat.id;
  let allowed = false;
  await ensurePro(chatId, bot, async () => { allowed = true; });
  if (!allowed) return;
  const sub = await getSubscription(chatId);
  if (!sub || sub.status !== 'pending') {
    return bot.sendMessage(chatId, '⚠️ Tidak ada invoice pending untuk dibatalkan.');
  }
  const invoiceId = sub.invoiceId;
  const cancelUrl = `${MAYAR_BASE}/invoice/${invoiceId}`;
  try {
    await axios.delete(cancelUrl, {
      headers: { Authorization: `Bearer ${process.env.MAYAR_API_KEY}` }
    });
    await saveSubscription({ chatId, invoiceId, status: 'cancelled' });
    return bot.sendMessage(chatId,
      `✅ Invoice ${invoiceId} berhasil dibatalkan. Silakan /subscribe ulang jika ingin berlangganan.`
    );
  } catch (e) {
    console.error('Cancel invoice error:', e.response?.data || e.message);
    return bot.sendMessage(chatId,
      `⚠️ Gagal membatalkan invoice: ${e.response?.data.messages || e.message}`
    );
  }
});


// Wizard state for API key/secret input per user
const apiWizard = {}; // key: chatId, value: { stage: 'await_api_key' | 'await_api_secret', apiKey: string }

// Handler foto chart: detect simbol & prompt timeframe
bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  let allowedPhoto = false;
  await ensurePro(chatId, bot, async () => { allowedPhoto = true; });
  if (!allowedPhoto) return;
  const fileId = msg.photo[msg.photo.length - 1].file_id;
  const caption = msg.caption?.trim() || '';
  let symbol;

  // Extract via caption
  const capMatch = caption.match(/\b([A-Z0-9]{2,6}\/[A-Z0-9]{2,6})\b/);
  if (capMatch) {
    symbol = capMatch[1].toUpperCase();
  } else {
    // OCR fallback
    const fileUrl = await bot.getFileLink(fileId);
    const resp = await axios.get(fileUrl, { responseType: 'arraybuffer' });
    const buf = Buffer.from(resp.data);
    try {
      symbol = await detectSymbolFromImage(buf);
    } catch (e) {
      console.warn('OCR failed:', e.message);
      await bot.sendMessage(chatId,
  '😕 Ups, saya kesulitan mengenali simbol dari gambar. ' +
  'Coba kirim ulang atau tambahkan caption seperti "ETH/USDT".'
);
      return;
    }
  }

  tempStore[chatId] = { fileId, symbol };
  await bot.sendMessage(chatId,
    `🎯 Chart ${symbol} diterima! Pilih timeframe:`,
    { reply_markup: { inline_keyboard: [
      [{ text: '15m', callback_data: 'tf|15m' }, { text: '1h', callback_data: 'tf|1h' }],
      [{ text: '4h', callback_data: 'tf|4h' }, { text: '1d', callback_data: 'tf|1d' }]
    ] } }
  );
});

// Manual symbol entry after OCR failure
bot.onText(/\b([A-Z0-9]{2,6}\/[A-Z0-9]{2,6})\b/, async (msg, match) => {
  const chatId = msg.chat.id;
  let allowedText = false;
  await ensurePro(chatId, bot, async () => { allowedText = true; });
  if (!allowedText) return;
  const symbol = match[1].toUpperCase();
  tempStore[chatId] = { symbol };
  await bot.sendMessage(chatId,
    `🎯 Pair ${symbol} diterima! Pilih timeframe:`,
    { reply_markup: { inline_keyboard: [
      [{ text: '15m', callback_data: 'tf|15m' }, { text: '1h', callback_data: 'tf|1h' }],
      [{ text: '4h', callback_data: 'tf|4h' }, { text: '1d', callback_data: 'tf|1d' }]
    ] } }
  );
});

// Callback: handle timeframe selection, detailed analysis, and execution buttons
bot.on('callback_query', async (query) => {
  console.log('Received callback_query:', query.data);
  try {
    const chatId = query.message.chat.id;
    // Guard callback-based features for Pro subscribers
    let allowedCb = false;
    await ensurePro(chatId, bot, async () => { allowedCb = true; });
    await bot.answerCallbackQuery(query.id);
    // Handle history pagination
    // Handle history pagination
    if (query.data.startsWith('history|page|')) {
      const [ , , pageStr, period ] = query.data.split('|');
      const page = parseInt(pageStr);
      const chatId = query.message.chat.id;

      let trades;
      if (['daily','weekly','monthly'].includes(period)) {
        trades = await getTradeHistoryByPeriod(chatId, period, page, HISTORY_PAGE_SIZE);
      } else {
        trades = await getTradeHistoryPaged(chatId, page, HISTORY_PAGE_SIZE);
      }

      if (!trades || trades.length === 0) {
        return bot.editMessageText('📊 Tidak ada riwayat untuk halaman ini.', {
          chat_id: chatId,
          message_id: query.message.message_id
        });
      }

      // Compute PnL groups (same as above)
      const periods = { daily: {}, weekly: {}, monthly: {} };
      trades.forEach(trade => {
        const entry = new Date(trade.entryAt);
        const pnl   = trade.pnl;
        const dayKey   = entry.toISOString().slice(0,10);
        const weekKey  = `${entry.getUTCFullYear()}-W${Math.ceil((entry.getUTCDate()+6-entry.getUTCDay())/7)}`;
        const monthKey = entry.toISOString().slice(0,7);
        [['daily', dayKey], ['weekly', weekKey], ['monthly', monthKey]]
          .forEach(([p, key]) => { periods[p][key] = (periods[p][key] || 0) + pnl; });
      });

      let text = '📈 *Riwayat Trade & Statistik*\n\n';
      for (let p of ['daily','weekly','monthly']) {
        text += `*${p.charAt(0).toUpperCase() + p.slice(1)}:*\n`;
        Object.entries(periods[p]).slice(-HISTORY_PAGE_SIZE).forEach(([k,v]) => {
          text += `• ${k}: ${v.toFixed(2)} USDT\n`;
        });
        text += '\n';
      }

      // Rebuild pagination buttons
      const buttons = [];
      if (page > 0) {
        buttons.push({ text: '⬅️ Prev', callback_data: `history|page|${page-1}|${period||''}` });
      }
      if (trades.length === HISTORY_PAGE_SIZE) {
        buttons.push({ text: '➡️ Next', callback_data: `history|page|${page+1}|${period||''}` });
      }

      return bot.editMessageText(text, {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [ buttons ] }
      });
    }
    // Handle inline History button directly
    if (query.data === 'history') {
      const period = undefined; // or default handling
      const chatId = query.message.chat.id;
      // Fetch first page
      const trades = await getTradeHistoryPaged(chatId, 0, HISTORY_PAGE_SIZE);
      if (!trades || trades.length === 0) {
        return bot.sendMessage(chatId, '📊 Belum ada riwayat trade untuk ditampilkan.');
      }
      // Compute PnL groups
      const periods = { daily: {}, weekly: {}, monthly: {} };
      trades.forEach(trade => {
        const entry = new Date(trade.entryAt);
        const pnl   = trade.pnl;
        const dayKey   = entry.toISOString().slice(0,10);
        const weekKey  = `${entry.getUTCFullYear()}-W${Math.ceil((entry.getUTCDate()+6-entry.getUTCDay())/7)}`;
        const monthKey = entry.toISOString().slice(0,7);
        [['daily', dayKey], ['weekly', weekKey], ['monthly', monthKey]]
          .forEach(([p, key]) => { periods[p][key] = (periods[p][key] || 0) + pnl; });
      });
      let text = '📈 *Riwayat Trade & Statistik*\n\n';
      for (let p of ['daily','weekly','monthly']) {
        text += `*${p.charAt(0).toUpperCase() + p.slice(1)}:*\n`;
        Object.entries(periods[p]).slice(-HISTORY_PAGE_SIZE)
          .forEach(([k,v]) => { text += `• ${k}: ${v.toFixed(2)} USDT\n`; });
        text += '\n';
      }
      // Pagination buttons for first page
      const buttons = [];
      if (trades.length === HISTORY_PAGE_SIZE) {
        buttons.push({ text: '➡️ Next', callback_data: `history|page|1|` });
      }
      return bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [ buttons ] } });
    }
    if (!allowedCb) return;
    const data = query.data;


    // Timeframe selection
    if (data.startsWith('tf|')) {
      const store     = tempStore[chatId];
      const symbol = store?.symbol;
      console.log('Handling timeframe callback for', symbol, 'with data', data);
      if (!store?.symbol) return bot.sendMessage(chatId, '⚠️ Kirim chart terlebih dahulu.');
      const timeframe = data.split('|')[1];

      // Send loading indicator
      const loadingMsg = await bot.sendMessage(chatId,
        `⏳ Sedang menganalisis ${symbol} (${timeframe})...`
      );

      try {
        console.log('Starting analysis inner try block for', symbol);
        const creds = await getApiCredentials(chatId);
        const useCex = creds.settings.defaultCex || 'bybit';
        // Per-user sentiment setting
        const useSentiment = creds.settings.useSentimentFilter === true;
        let analysis;
        try {
          console.log('Calling analyzeChartData...');
          analysis = await analyzeChartData(useCex, symbol, timeframe, chatId);
        } catch (errAnalysis) {
          console.error('analyzeChartData failed:', errAnalysis);
                    return bot.editMessageText(
                        formatHeader('warn', 'Error Analisa Chart') +
                        `${errAnalysis.message}` +
                        formatFooter('info', 'Coba lagi nanti atau pilih timeframe lain.'),
                        {
                            chat_id: chatId,
                            message_id: loadingMsg.message_id
                        }
        );
        }
        let { trend, entry, sl, tp, atr, resistance, support, vwap, rsi, stochastic } = analysis;

        // Override entry/SL/TP with real-time price from selected CEX
      // Untuk analisa/chart: gunakan client tanpa kredensial
      const clientRT = useCex === 'binance'
        ? new ccxt.binance()
        : new ccxt.bybit({ options: { defaultType: 'swap', defaultSettle: 'USDT' } });
      const ticker   = await clientRT.fetchTicker(symbol);
        const realEntry = ticker.last;
        const slOffset  = entry - sl;
        const tpOffset  = tp - entry;
        const realSL    = realEntry - slOffset;
        const realTP    = realEntry + tpOffset;
        entry = realEntry; sl = realSL; tp = realTP;

        // Guard against mixed trends
        if (trend === 'mixed') {
          return bot.editMessageText(
            `🤔 Ups, tren belum jelas untuk ${symbol}. ` +
            `Silakan pilih timeframe lain atau tunggu hingga sinyal lebih kuat.`, {
              chat_id: chatId,
              message_id: loadingMsg.message_id
            }
          );
        }

        // Volatility filter
        if (atr / entry > 0.02) {
          return bot.editMessageText(
            `😬 Pasar sedang terlalu bergejolak. ` +
            `Mungkin tunda dulu atau pilih timeframe lain.`, {
              chat_id: chatId,
              message_id: loadingMsg.message_id
            }
          );
        }

        // Fetch top 2 RSS news titles
        let newsItems = [];
        for (let feed of RSS_FEEDS) {
          try {
            const parsed = await rssParser.parseURL(feed.url);
            newsItems.push(...parsed.items.slice(0, 2).map(item => item.title));
          } catch (e) {
            console.error(`RSS fetch error (${feed.name}):`, e.message);
          }
        }
        newsItems = newsItems.slice(0, 2);
        const combinedNewsText = newsItems.join('. ');
        const { comparative: newsScore } = sentiment.analyze(combinedNewsText);

        // Sentiment filter per-user
        if (useSentiment) {
          if (trend === 'bullish' && newsScore < 0) {
            return bot.editMessageText(
              `⚠️ Sinyal *LONG* positif secara teknikal, tapi sentimen berita negatif (score ${newsScore.toFixed(2)}).\n` +
              `Tunggu konfirmasi berita membaik sebelum entry.`, {
                chat_id: chatId,
                message_id: loadingMsg.message_id,
                parse_mode: 'Markdown'
              }
            );
          }
          if (trend === 'bearish' && newsScore > 0) {
            return bot.editMessageText(
              `⚠️ Sinyal *SHORT* positif secara teknikal, tapi sentimen berita positif (score ${newsScore.toFixed(2)}).\n` +
              `Tunggu sentimen memburuk sebelum entry.`, {
                chat_id: chatId,
                message_id: loadingMsg.message_id,
                parse_mode: 'Markdown'
              }
            );
          }
        }

        // Generate full detailed analysis message
        const detailedMsg = await generateDetailedAnalysis(
          useCex,             // exchangeId
          symbol,
          timeframe,
          trend,
          entry,
          sl,
          tp,
          atr,
          resistance,
          support,
          newsItems,
          newsScore,
          vwap,
          rsi,
          stochastic,
          chatId             // chatId for per-user settings
        );

        // Generate a short execution ID and store context
        const execId = `${chatId}_${Date.now()}`;
        // Initialize execContext map if needed
        tempStore[chatId].execContext = tempStore[chatId].execContext || {};
        tempStore[chatId].execContext[execId] = {
          useCex,
          side: trend === 'bullish' ? 'long' : 'short',
          symbol,
          entry: entry.toFixed(2),
          sl: sl.toFixed(2),
          tp: tp.toFixed(2)
        };
        const platform = useCex.charAt(0).toUpperCase() + useCex.slice(1);
        const execButtons = [[{
          text: `🚀 Execute ${trend === 'bullish' ? 'Long' : 'Short'} @${platform}`,
          callback_data: `execute_direct|${execId}`
        }]];

        // Store detailed context for toggle
        const store = tempStore[chatId] || {};
        store.analysisContext = {
          detailedMsg,
          execButtons: creds[useCex]?.apiKey ? execButtons : null
        };
        tempStore[chatId] = store;

        // Estimasi eksekusi
        let balanceEt = 0, marginEt = 0, positionEt = 0, profitEt = 0, lossEt = 0;
        try {
          const estClient = new ccxt[useCex]({
            apiKey: creds[useCex].apiKey,
            secret: creds[useCex].secret,
            timeout: 30000,
            enableRateLimit: true,
            defaultType: useCex === 'bybit' ? 'swap' : 'future',
            options: useCex === 'bybit' ? { defaultSettle: 'USDT' } : {}
          });
          const balInfo = await estClient.fetchBalance({ type: 'future' });
          balanceEt = balInfo.free.USDT;
          const riskPctEt = (creds.settings.defaultRisk !== undefined ? creds.settings.defaultRisk : 1) / 100;
          const leverageEt = creds.settings.leverage || 10;
          marginEt = balanceEt * riskPctEt;
          positionEt = marginEt * leverageEt;
          profitEt = positionEt * ((tp - entry) / entry);
          lossEt = positionEt * ((entry - sl) / entry);
        } catch (err) {
          console.warn('Estimasi eksekusi gagal:', err.message);
        }
        // Build a simple summary
        const summaryMsg =
          formatHeader('signal', `Analisis ${symbol} (${timeframe})`) +
          `• Trend: *${trend}*\n` +
          `• Entry: ${entry.toFixed(2)}\n` +
          `• SL: ${sl.toFixed(2)}\n` +
          `• TP: ${tp.toFixed(2)}\n\n` +
          `*Estimasi Eksekusi:*\n` +
          `• Saldo: ${balanceEt.toFixed(2)} USDT\n` +
          `• Order (Margin): ${marginEt.toFixed(2)} USDT\n` +
          `• Leverage: ${creds.settings.leverage || 10}×\n` +
          `• Total Posisi: ${positionEt.toFixed(2)} USDT\n` +
          `• Profit @TP: ${profitEt.toFixed(2)} USDT\n` +
          `• Loss @SL: ${lossEt.toFixed(2)} USDT` +
          formatFooter('info', 'Gunakan “Lihat Detail” untuk info lengkap.');

        // Show summary with "Lihat Detail" button
            await bot.editMessageText(summaryMsg, {
            chat_id: chatId,
            message_id: loadingMsg.message_id,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '🔍 Lihat Detail', callback_data: 'view_detail' }]] }
            });

      } catch (e) {
        console.error('Analysis error:', e);
        return bot.editMessageText(`⚠️ Analisa gagal: ${e.message}`, {
          chat_id: chatId,
          message_id: loadingMsg.message_id
        });
      }
    }

    // Execution handler
    if (data.startsWith('execute|')) {
      console.log('Handling execute callback:', data);
      const [ , ex, side, symbol, entryStr, slStr, tpStr, trend, timeframe ] = data.split('|');
      const entry = parseFloat(entryStr);
      const creds = await getApiCredentials(chatId);
      const useCex = creds.settings.defaultCex || 'bybit';
      const client = new ccxt[useCex]({
        apiKey: creds[useCex].apiKey,
        secret: creds[useCex].secret,
        timeout: 30000,
        enableRateLimit: true,
        defaultType: useCex === 'bybit' ? 'swap' : 'future',
        options: useCex === 'bybit' ? { defaultSettle: 'USDT' } : {}
      });

      // Calculate qty and confirm signal
      let qty;
      let stopLoss, takeProfit;
      try {
        const ohlcv = await client.fetchOHLCV(symbol, timeframe, undefined, 20);
        const high = ohlcv.map(c => c[2]);
        const low = ohlcv.map(c => c[3]);
        const close = ohlcv.map(c => c[4]);
        const volume = ohlcv.map(c => c[5]);
        // Recalculate ATR for order execution
        const atrArray = calcATR(high, low, close);
        const atr = Array.isArray(atrArray) ? atrArray.at(-1) : atrArray;
        // Ensemble ML confirmation with error handling, conditional on useMlIntervention
        const useMl = creds.settings.useMlIntervention === true;
        let isValid = true;
        if (useMl) {
          isValid = false;
          try {
            isValid = ensembleConfirm(high, low, close, volume, side, 0.8);
          } catch (e) {
            console.error('Ensemble ML error:', e);
            await bot.sendMessage(chatId,
              `${EMOJI.warn} Warning: ML ensemble error: ${e.message}. Melanjutkan tanpa konfirmasi ML.`,
              { parse_mode: 'Markdown' }
            );
            isValid = true; // fallback to allow execution
          }
          if (!isValid) {
            return bot.sendMessage(chatId,
              `${EMOJI.warn} Sinyal tidak cukup kuat menurut Ensemble ML. Trade dibatalkan.`);
          }
        }
        if (!confirmSignal(trend, close)) {
          return bot.sendMessage(chatId,
            `${EMOJI.warn} Konfirmasi teknikal gagal. Trade dibatalkan.`);
        }
        // SL/TP calculation with fallback
        try {
          const sltp = calcSLTP(entry, side, atr);
          stopLoss = sltp.stopLoss;
          takeProfit = sltp.takeProfit;
        } catch (e) {
          console.error('SLTP calculation error:', e);
          // fallback: 1% offsets
          if (side === 'long') {
            stopLoss = entry * 0.99;
            takeProfit = entry * 1.01;
          } else {
            stopLoss = entry * 1.01;
            takeProfit = entry * 0.99;
          }
          await bot.sendMessage(chatId,
            `${EMOJI.warn} Warning: SL/TP calculation error: ${e.message}. Menggunakan SL/TP fallback.`,
            { parse_mode: 'Markdown' }
          );
        }
        const balance = (await client.fetchBalance({ type: 'future' })).free.USDT;
        // Use per-user risk percentage
        const riskPct = (creds.settings.defaultRisk !== undefined ? creds.settings.defaultRisk : 1) / 100;
        const leverage = (creds.settings.leverage) || 10;
        qty = calcQuantity(balance, entry, stopLoss, riskPct); // Patched: leverage per-user
        if ((takeProfit - entry) / Math.abs(entry - stopLoss) < 1.5) {
          throw new Error('Risk/reward < 1.5');
        }
      } catch (e) {
        return bot.sendMessage(chatId, `⚠️ ${e.message}. Trade dibatalkan.`);
      }

      try {
        const order = await client.createOrder(
          symbol,
          'market',
          side,
          qty,
          undefined,
          useCex === 'bybit'
            ? { category: 'linear', positionIdx: 0, timeInForce: 'ImmediateOrCancel', reduceOnly: false }
            : { timeInForce: 'ImmediateOrCancel', reduceOnly: false }
        );
        return bot.sendMessage(chatId, `✅ Order executed on ${ex}: ${order.id}`);
      } catch (e) {
        console.error('Order error:', e);
        return bot.sendMessage(chatId, `⚠️ Gagal eksekusi order: ${e.message}`);
      }
    }
    else if (data === 'view_detail') {
      console.log('🛠️ Entering view_detail handler for chatId=', chatId, 'tempStore=', tempStore[chatId]);
      try {
        const store = tempStore[chatId];
        if (!store || !store.analysisContext) {
          console.warn('⚠️ view_detail: no analysisContext found for', chatId);
          return bot.sendMessage(chatId,
            '⚠️ Detail tidak tersedia. Lakukan analisis chart terlebih dahulu.'
          );
        }
        const { detailedMsg, execButtons } = store.analysisContext;
        // Always send a fresh message to avoid edit crashes
        await bot.sendMessage(chatId, detailedMsg, {
          parse_mode: 'Markdown',
          reply_markup: execButtons ? { inline_keyboard: execButtons } : undefined
        });
        return;
      } catch (err) {
        console.error('Error in view_detail handler:', err);
        return bot.sendMessage(chatId,
          '⚠️ Kesalahan saat menampilkan detail. Silakan coba lagi.'
        );
      }
    }
    else if (data.startsWith('execute_direct|')) {
      console.log('Handling direct execute callback:', data);
      const chatId = query.message.chat.id;
      const execId = data.split('|')[1];
      const creds = await getApiCredentials(chatId);
      const ctx = tempStore[chatId]?.execContext?.[execId];
      if (!ctx) return bot.sendMessage(chatId, '⚠️ Context eksekusi tidak ditemukan.');

      // --- [EXECUTE_DIRECT] LOGGING ---
      console.log('--- [EXECUTE_DIRECT] ---');
      console.log('DEFAULT_CEX:', creds.settings.defaultCex);
      console.log('Binance creds:', creds.binance);
      console.log('Bybit creds:', creds.bybit);
      console.log('Current context:', ctx);
      // --- END LOGGING ---

      // Branch by defaultCex
      if (creds.settings.defaultCex === 'binance') {
        try {
          const { side, symbol } = ctx;
          // Pastikan simbol tanpa slash untuk Binance
          const symbolNoSlash = symbol.replace('/', '');
          const client = new ccxt.binance({
            apiKey: creds.binance.apiKey,
            secret: creds.binance.secret,
            defaultType: 'future',
            enableRateLimit: true,
          });
          await client.loadMarkets();
          const market = client.market(symbolNoSlash);
          const ticker = await client.fetchTicker(market.symbol);
          const price = ticker.last;
          // Perhitungan quantity mirip Bybit
          const balance = (await client.fetchBalance({ type: 'future' })).free.USDT;
          const riskPct = (creds.settings.defaultRisk || 1) / 100;
          const leverage = creds.settings.leverage || 10;
          const riskAmount = balance * riskPct;
          const notional = riskAmount * leverage;
          let qty = notional / price;
          const minQty = market.limits.amount.min || 0.001;
          const step = market.precision.amount || 0.001;
          qty = Math.floor(qty / step) * step;
          if (qty < minQty) qty = minQty;
          qty = parseFloat(qty.toFixed(3)); // biar nggak error precision

          // 1. Order market entry
          const order = await client.createOrder(
            market.symbol,
            'MARKET',
            side === 'long' ? 'buy' : 'sell',
            qty
            // Tidak pakai params (hapus reduceOnly dan timeInForce)
          );
          const posUSD = qty * price;
          await bot.sendMessage(chatId,
            `✅ Order futures ${side.toUpperCase()} di Binance berhasil!\n` +
            `• Symbol: ${market.symbol}\n` +
            `• Qty: ${qty}\n` +
            `• Total Posisi: ${posUSD.toFixed(2)} USDT\n` +
            `• Order ID: ${order.id}`
          );
          console.log('[Binance Order] Entry:', { symbol: market.symbol, side, qty, price });

          // 2. Auto set SL/TP jika ada ctx.sl/tp
          if (ctx.sl) {
            try {
              const params = {
                stopPrice: parseFloat(ctx.sl),
                reduceOnly: true,
                timeInForce: 'GTC'
              };
              await client.createOrder(
                market.symbol,
                'STOP_MARKET',
                side === 'long' ? 'sell' : 'buy',
                qty,
                undefined,
                params
              );
              await bot.sendMessage(chatId, `🛡️ Stop Loss set at ${ctx.sl}`);
              console.log('[Binance Order] SL params:', { ...params, side: side === 'long' ? 'sell' : 'buy' });
            } catch (err) {
              console.error('Binance SL error:', err);
              await bot.sendMessage(chatId, `⚠️ Gagal set Stop Loss Binance: ${err.message}`);
            }
          }
          if (ctx.tp) {
            try {
              const params = {
                stopPrice: parseFloat(ctx.tp),
                reduceOnly: true,
                timeInForce: 'GTC'
              };
              await client.createOrder(
                market.symbol,
                'TAKE_PROFIT_MARKET',
                side === 'long' ? 'sell' : 'buy',
                qty,
                undefined,
                params
              );
              await bot.sendMessage(chatId, `🎯 Take Profit set at ${ctx.tp}`);
              console.log('[Binance Order] TP params:', { ...params, side: side === 'long' ? 'sell' : 'buy' });
            } catch (err) {
              console.error('Binance TP error:', err);
              await bot.sendMessage(chatId, `⚠️ Gagal set Take Profit Binance: ${err.message}`);
            }
          }
          return;
        } catch (err) {
          console.error('Binance order error:', err);
          await bot.sendMessage(chatId, `⚠️ Gagal eksekusi order futures Binance: ${err.message}`);
          return;
        }
      } else {
        // Bybit order logic (existing code)
        const { side, symbol } = ctx;
        // Normalize symbol for Bybit futures
        const symbolNoSlash = symbol.replace('/', '');
        // Initialize Bybit futures client
        const client = new ccxt.bybit({
          apiKey: creds.bybit.apiKey,
          secret: creds.bybit.secret,
          defaultType: 'swap',
          enableRateLimit: true,
          options: { defaultSettle: 'USDT' },
        });
        await client.loadMarkets();
        // Set margin mode & leverage
        try {
          await client.setMarginMode('isolated', symbolNoSlash);
          await client.setLeverage(creds.settings.leverage || 10, symbolNoSlash);
        } catch {}

        // Dynamically handle contract size, precision, and minimum quantity per market
        const balance = (await client.fetchBalance({ type: 'future' })).free.USDT;
        const riskPct = (creds.settings.defaultRisk || 1) / 100;
        const leverage = creds.settings.leverage || 10;
        const riskAmount = balance * riskPct;
        const notional = riskAmount * leverage;
        const market = client.market(symbolNoSlash);
        const ticker = await client.fetchTicker(symbolNoSlash);
        const price = ticker.last;
        let rawQty = notional / (price * (market.contractSize || 1));
        // Enforce quantity in contracts, not underlying units
        const { limits } = market;
        const contractSize = market.contractSize || 1;
        // Determine step and min in contract units
        const stepUnderlying = limits.amount?.step || market.precision?.amount || 1;
        const minUnderlying = limits.amount.min;
        const stepContracts = stepUnderlying / contractSize;
        const minContracts = Math.ceil(minUnderlying / contractSize);
        // rawQty is in contract units already
        let qtyContracts = Math.floor(rawQty / stepContracts) * stepContracts;
        if (isNaN(qtyContracts) || qtyContracts < minContracts) {
          qtyContracts = minContracts;
        }
        // Optionally clamp maxContracts if needed
        console.log(`[Order Debug] contractSize=${contractSize}, stepContracts=${stepContracts}, minContracts=${minContracts}, qtyContracts=${qtyContracts}`);
        // Round to integer contract count
        const qty = Math.round(qtyContracts);
        console.log(`[Order Debug] finalQtyContracts=${qty}`);
        if (!qty || qty < minContracts) {
          await bot.sendMessage(chatId,
            `⚠️ Gagal eksekusi: qty tidak valid atau di bawah minimum (${qty}). ` +
            `Pastikan risiko, leverage, dan saldo mencukupi.`
          );
          return;
        }
        const finalQty = qty;
        console.log(`[Order Debug] finalQty after contract enforcement=${finalQty}`);

        // Detect swap/future/contract type for param handling
        const isSwap = market.type === 'swap' || market.future || market.contract;

        // Place market order using qty (contracts)
        const sideParam = side === 'long' ? 'buy' : 'sell';
        try {
          const order = await client.createOrder(
            symbolNoSlash,
            'market',
            sideParam,
            finalQty,
            undefined,
            { timeInForce: 'ImmediateOrCancel', reduceOnly: false, category: 'linear', positionIdx: 0 }
          );
          // Calculate and display total position size in USDT
          const positionUsd = finalQty * contractSize * price;
          console.log('[Order Info] Total position in USDT:', positionUsd);
          await bot.sendMessage(chatId,
            `✅ Order futures ${side.toUpperCase()} di Bybit berhasil!\n` +
            `• Symbol: ${symbol}\n` +
            `• Qty (contracts): ${finalQty}\n` +
            `• Total Posisi: ${positionUsd.toFixed(2)} USDT\n` +
            `• Order ID: ${order.id}`
          );
          // Place separate conditional orders for SL and TP using stop and takeProfit types
          const slPrice = ctx.sl ? parseFloat(ctx.sl) : null;
          const tpPrice = ctx.tp ? parseFloat(ctx.tp) : null;
          if (slPrice) {
            try {
              // Construct params for SL
              const params = {
                stopPrice: slPrice,
                reduceOnly: true,
                triggerBy: 'LastPrice',
                category: 'linear',
                positionIdx: 0,
              };
              if (isSwap) {
                params.triggerDirection = side === 'long' ? 2 : 1; // 2: price falls below for long, 1: price rises above for short
              }
              await client.createOrder(
                symbolNoSlash,
                'stop',
                side === 'long' ? 'sell' : 'buy',
                finalQty,
                undefined,
                {
                  ...params,
                  triggerPrice: slPrice,
                  stopPrice: undefined
                }
              );
              await bot.sendMessage(chatId, `🛡️ Stop Loss set at ${slPrice}`);
            } catch (err) {
              console.error('Stop Loss error:', err);
              await bot.sendMessage(chatId, `⚠️ Gagal set Stop Loss: ${err.message}`);
            }
          }
          if (tpPrice) {
            try {
              // Construct params for TP
              const params = {
                stopPrice: tpPrice,
                reduceOnly: true,
                triggerBy: 'LastPrice',
                category: 'linear',
                positionIdx: 0,
              };
              if (isSwap) {
                params.triggerDirection = side === 'long' ? 1 : 2; // 1: price rises above for long, 2: price falls below for short
              }
              await client.createOrder(
                symbolNoSlash,
                'takeProfit',
                side === 'long' ? 'sell' : 'buy',
                finalQty,
                undefined,
                {
                  ...params,
                  triggerPrice: tpPrice,
                  stopPrice: undefined
                }
              );
              await bot.sendMessage(chatId, `🎯 Take Profit set at ${tpPrice}`);
            } catch (err) {
              console.error('Take Profit error:', err);
              await bot.sendMessage(chatId, `⚠️ Gagal set Take Profit: ${err.message}`);
            }
          }
        } catch (err) {
          console.error('Futures order error:', err);
          await bot.sendMessage(chatId,
            `⚠️ Gagal eksekusi order futures: ${err.message}`
          );
        }
        return;
      }
    }
    // Handle basic trade menu actions
    if (data === 'trade|view_positions') {
      const creds = await getApiCredentials(chatId);
      const useCex = creds.settings.defaultCex || 'bybit';
      const client = new ccxt[useCex]({
        apiKey: creds[useCex].apiKey,
        secret: creds[useCex].secret,
        enableRateLimit: true,
        defaultType: 'future',
      });
      try {
        await client.loadMarkets();
      } catch (e) {
        console.warn('⚠️ Warning: gagal loadMarkets, melanjutkan tanpa loadMarkets:', e.message);
      }
      // Fetch open positions from exchange
      let allPositions = [];
      try {
        allPositions = await client.fetchPositions(); // for futures
      } catch (err) {
        console.warn('⚠️ Warning: gagal fetchPositions, melanjutkan tanpa posisi:', err.message);
        // fallback: no positions
        allPositions = [];
      }
      // Filter only positions with non-zero contracts
      const openPositions = allPositions.filter(p => p.contracts && parseFloat(p.contracts) > 0);
      if (!openPositions.length) {
        liveTrades[chatId] = [];
        return bot.sendMessage(chatId, `${EMOJI.info} Tidak ada posisi aktif saat ini.`);
      }
      // Update liveTrades for tracking
      liveTrades[chatId] = openPositions.map(p => ({
        symbol: p.symbol,
        side: p.side,
        qty: parseFloat(p.contracts),
        entry: parseFloat(p.entryPrice || p.averagePrice),
        platform: useCex
      }));
      // Build message
      let msg = formatHeader('info', 'Posisi Aktif');
      openPositions.forEach((p, idx) => {
        const entryPrice = parseFloat(p.entryPrice || p.averagePrice);
        const markPrice = parseFloat(p.markPrice || p.price || 0);
        const qty = parseFloat(p.contracts);
        const pnl = p.side === 'long'
          ? ((markPrice - entryPrice) * qty).toFixed(2)
          : ((entryPrice - markPrice) * qty).toFixed(2);
        const pct = p.side === 'long'
          ? ((markPrice - entryPrice) / entryPrice * 100).toFixed(2)
          : ((entryPrice - markPrice) / entryPrice * 100).toFixed(2);
        msg += `\n${idx + 1}. ${p.symbol} | ${p.side.toUpperCase()} | Qty: ${qty} | PnL: ${pnl} USDT (${pct}%)`;
      });
      // Buttons to refresh or close
      const keyboard = [
        [{ text: '🔄 Refresh', callback_data: 'trade|view_positions' }],
        ...openPositions.map(p => ([{
          text: `❌ Close ${p.symbol}`,
          callback_data: `trade|close|${p.symbol}`
        }]))
      ];
      return bot.sendMessage(chatId, msg, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
      });
    }
    // Prompt confirmation before closing all positions
    if (data === 'trade|close_all') {
      return bot.sendMessage(chatId,
        `${EMOJI.warn} ⚠️ Yakin tutup semua posisi?`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✅ Ya', callback_data: 'trade|confirm_close_all' },
                { text: '❌ Batal', callback_data: 'trade|cancel_close_all' }
              ]
            ]
          }
        }
      );
    }

    // Confirm closing all positions
    if (data === 'trade|confirm_close_all') {
      const positions = liveTrades[chatId] || [];
      if (!positions.length) {
        return bot.sendMessage(chatId, `${EMOJI.info} Tidak ada posisi untuk ditutup.`);
      }
      const creds = await getApiCredentials(chatId);
      const useCex = creds.settings.defaultCex || 'bybit';
      const client = new ccxt[useCex]({ apiKey: creds[useCex].apiKey, secret: creds[useCex].secret, enableRateLimit: true, defaultType: 'future' });
      try {
        for (const open of positions) {
          await client.createOrder(open.symbol, 'market', open.side === 'long' ? 'Sell' : 'Buy', open.qty);
        }
        delete liveTrades[chatId];
        return bot.sendMessage(chatId, `${EMOJI.success} Semua posisi berhasil ditutup.`);
      } catch (e) {
        console.error('Confirm close all error:', e);
        const isRateLimitAll = e.message.toLowerCase().includes('rate limit') || e.message.toLowerCase().includes('timeout');
        const errMsgAll = isRateLimitAll
          ? '⏳ Terjadi gangguan jaringan atau rate limit. Coba lagi beberapa detik.'
          : `Gagal menutup posisi: ${e.message}`;
        return bot.sendMessage(chatId, `${EMOJI.warn} ${errMsgAll}`);
      }
    }

    // Cancel close all action
    if (data === 'trade|cancel_close_all') {
      return bot.sendMessage(chatId, `${EMOJI.info} Penutupan posisi batal.`);
    }
    // Handle closing individual positions
    if (data.startsWith('trade|close|')) {
      const symbolToClose = data.split('|')[2];
      const positions = liveTrades[chatId] || [];
      const positionIndex = positions.findIndex(p => p.symbol === symbolToClose);
      if (positionIndex === -1) {
        return bot.sendMessage(chatId, `${EMOJI.warn} Posisi ${symbolToClose} tidak ditemukan.`);
      }
      const position = positions[positionIndex];
      const creds = await getApiCredentials(chatId);
      const useCex = creds.settings.defaultCex || 'bybit';
      const client = new ccxt[useCex]({
        apiKey: creds[useCex].apiKey,
        secret: creds[useCex].secret,
        enableRateLimit: true,
        defaultType: 'future'
      });
      try {
        const sideOpp = position.side === 'long' ? 'Sell' : 'Buy';
        await client.createOrder(position.symbol, 'market', sideOpp, position.qty);
        positions.splice(positionIndex, 1);
        if (positions.length === 0) delete liveTrades[chatId];
        return bot.sendMessage(chatId, `${EMOJI.success} Posisi ${symbolToClose} berhasil ditutup.`);
      } catch (e) {
        console.error('Close individual error:', e);
        const isRateLimit = e.message.toLowerCase().includes('rate limit') || e.message.toLowerCase().includes('timeout');
        const errMsg = isRateLimit
          ? '⏳ Terjadi gangguan jaringan atau rate limit. Coba lagi beberapa detik.'
          : `Gagal menutup posisi ${symbolToClose}: ${e.message}`;
        return bot.sendMessage(chatId, `${EMOJI.warn} ${errMsg}`);
      }
    }
    // Close position handler
    else if (data.startsWith('close_direct|')) {
      console.log('Handling close callback:', data);
      const [, ex, orderId] = data.split('|');
      const creds = await getApiCredentials(chatId);
      if (!creds[ex]?.apiKey) {
        return bot.sendMessage(chatId, `⚠️ ${ex.toUpperCase()} belum terkoneksi.`);
      }
      const client = new ccxt[ex]({
        apiKey: creds[ex].apiKey,
        secret: creds[ex].secret,
        timeout: 30000,
        enableRateLimit: true,
        defaultType: 'future'
      });
      try {
        await client.cancelOrder(orderId);
        delete liveTrades[chatId];
        return bot.sendMessage(chatId, `✅ Posisi ${orderId} di ${ex} berhasil ditutup.`);
      } catch (err) {
        console.error('Close position error:', err);
        return bot.sendMessage(chatId, `⚠️ Gagal menutup posisi: ${err.message}`);
      }
    }
    // Settings handler
    else if (data.startsWith('setting|')) {
      console.log('Handling settings callback:', data);
      const parts = data.split('|');
      const key = parts[1]; // e.g. 'api_bybit', 'news', 'risk', etc.

      let newVal;
      const creds = await getApiCredentials(chatId);
      switch (key) {
        case 'api_bybit':
          apiWizard[chatId] = { stage: 'await_api_key' };
          return bot.sendMessage(chatId,
            '🔑 Silakan masukkan *API Key* Bybit kamu:',
            { parse_mode: 'Markdown' }
          );
        case 'api_binance':
          apiWizard[chatId] = { stage: 'await_api_key_binance' };
          return bot.sendMessage(chatId,
            '🔑 Silakan masukkan *API Key* Binance kamu:',
            { parse_mode: 'Markdown' }
          );
        case 'disconnect_bybit':
          await saveApiCredentials(chatId, 'bybit', {});
          await bot.sendMessage(chatId, '❌ Bybit API dihapus.');
          break;
        case 'disconnect_binance':
          await saveApiCredentials(chatId, 'binance', {});
          await bot.sendMessage(chatId, '❌ Binance API dihapus.');
          break;
        case 'default_cex':
          newVal = creds.settings.defaultCex === 'binance' ? 'bybit' : 'binance';
          await saveApiCredentials(chatId, 'settings', { ...creds, defaultCex: newVal });
          await bot.sendMessage(chatId, `💠 Default CEX diubah ke ${newVal.toUpperCase()}.`);
          break;
        case 'news':
          newVal = !creds.settings.useNews;
          await saveApiCredentials(chatId, 'settings', { ...creds, useNews: newVal });
          await bot.sendMessage(chatId, `📰 News ${newVal ? 'diaktifkan' : 'dinonaktifkan'}.`);
          break;
        case 'sentiment':
          newVal = !creds.settings.useSentimentFilter;
          await saveApiCredentials(chatId, 'settings', { ...creds, useSentimentFilter: newVal });
          await bot.sendMessage(chatId, `🔔 Sentiment Filter ${newVal ? 'diaktifkan' : 'dinonaktifkan'}.`);
          break;
        case 'multitf':
          newVal = !creds.settings.useMultiTf;
          await saveApiCredentials(chatId, 'settings', { ...creds, useMultiTf: newVal });
          await bot.sendMessage(chatId, `🔄 Multi-TF ${newVal ? 'diaktifkan' : 'dinonaktifkan'}.`);
          break;

        case 'ml_intervention':
          // Toggle ML intervention flag
          const newMl = !creds.settings.useMlIntervention;
          await saveApiCredentials(chatId, 'settings', { ...creds.settings, useMlIntervention: newMl });
          await bot.sendMessage(chatId, `🤖 ML Intervention ${newMl ? 'diaktifkan' : 'dinonaktifkan'}.`);
          // Let the inlineKeyboard update below handle UI refresh
          break;

        case 'leverage':
          apiWizard[chatId] = { stage: 'await_leverage' };
          return bot.sendMessage(chatId,
              '⚡ Masukkan nilai leverage (angka, misal 10 untuk 10×):',
              { parse_mode: 'Markdown' }
          );
        case 'threshold':
          apiWizard[chatId] = { stage: 'await_threshold' };
          return bot.sendMessage(chatId,
            '🔔 Masukkan persentase *Threshold Alert PnL* (%) (misal 5 untuk 5%):',
            { parse_mode: 'Markdown' }
          );

        case 'risk':
          apiWizard[chatId] = { stage: 'await_risk' };
          return bot.sendMessage(chatId,
            '🔧 Silakan masukkan persentase risiko per trade (angka, misal 1 untuk 1%):',
            { parse_mode: 'Markdown' }
          );
        default:
          return;
      }

      // Rebuild and update inline keyboard using nested settings
      const updated = await getApiCredentials(chatId);
      const hasBybit   = Boolean(updated.bybit?.apiKey);
      const hasBinance = Boolean(updated.binance?.apiKey);
      const useNews    = updated.settings.useNews;
      const useSent   = updated.settings.useSentimentFilter;
      const useMtf     = updated.settings.useMultiTf;
      const defCex     = updated.settings.defaultCex || 'bybit';
      const rpct       = updated.settings.defaultRisk !== undefined ? updated.settings.defaultRisk : 1;
      const leverage   = updated.settings.leverage || 10;
      const tf         = updated.settings.defaultTimeframe || '1h';
      const thresholdPct = updated.settings.thresholdPct !== undefined ? updated.settings.thresholdPct : 5;

      const inlineKeyboard = {
        reply_markup: {
          inline_keyboard: [
            [
              { text: hasBybit   ? '✅ Bybit API'   : '🔑 Set Bybit API',   callback_data: 'setting|api_bybit' },
              { text: hasBinance ? '✅ Binance API' : '🔑 Set Binance API', callback_data: 'setting|api_binance' }
            ],
            [{ text: `💠 Default CEX: ${defCex.toUpperCase()}`, callback_data: 'setting|default_cex' }],
            // Additional toggles can be added here as needed
            //[{ text: `⚙️ Risk %: ${rpct}%`,                         callback_data: 'setting|risk' }],
            //[{ text: `📰 News: ${useNews ? 'On' : 'Off'}`,             callback_data: 'setting|news' }],
            //[{ text: `🔔 Sentiment Filter: ${useSent ? 'On' : 'Off'}`, callback_data: 'setting|sentiment' }],
            [{ text: `🔄 Multi-TF: ${useMtf ? 'On' : 'Off'}`, callback_data: 'setting|multitf' }],
            [{ text: `🤖 ML Intervention: ${updated.settings.useMlIntervention ? 'On' : 'Off'}`, callback_data: 'setting|ml_intervention' }],
            // Add more settings rows as needed here
            ...(hasBybit
              ? [[{ text: '❌ Disconnect Bybit',   callback_data: 'setting|disconnect_bybit'   }]]
              : []
            ),
            ...(hasBinance
              ? [[{ text: '❌ Disconnect Binance', callback_data: 'setting|disconnect_binance' }]]
              : []
            )
          ]
        }
      };

      await bot.editMessageReplyMarkup(inlineKeyboard.reply_markup, {
        chat_id: chatId,
        message_id: query.message.message_id
      });
      return;
    }
  } catch (e) {
    console.error('Unhandled callback_query error:', e);
    await bot.sendMessage(query.message.chat.id, `⚠️ Terjadi kesalahan internal: ${e.message}`);
  }
});

// Handle main menu reply keyboard selections
bot.on('message', async (msg) => {
  // Skip subscription guard for slash commands
  if (msg.text && msg.text.startsWith('/')) return;
  const chatId = msg.chat.id;
  // Guard all message-based features for Pro subscribers
  let allowed = false;
  await ensurePro(chatId, bot, async () => { allowed = true; });
  if (!allowed) return;
  if (!msg.text) return;

  if (apiWizard[chatId]?.stage === 'await_leverage') {
    const val = parseInt(msg.text.trim());
    if (isNaN(val) || val < 1 || val > 100) {
      return bot.sendMessage(chatId,
        '⚠️ Masukkan leverage valid antara 1 hingga 100. Coba lagi.',
        { parse_mode: 'Markdown' }
      );
    }
    delete apiWizard[chatId];
    const creds = await getApiCredentials(chatId);
    await saveApiCredentials(chatId, 'settings', { ...creds, leverage: val });
    return bot.sendMessage(chatId, `✅ Leverage berhasil diatur ke ${val}×.`);
  }

  // Wizard for user-defined Threshold PnL alert
  if (apiWizard[chatId]?.stage === 'await_threshold') {
    const input = msg.text.trim();
    const val = parseFloat(input);
    if (isNaN(val) || val <= 0 || val > 100) {
      return bot.sendMessage(chatId,
        '⚠️ Masukkan angka valid untuk *Threshold Alert PnL* (0.1–100):',
        { parse_mode: 'Markdown' }
      );
    }
    delete apiWizard[chatId];
    const creds = await getApiCredentials(chatId);
    await saveApiCredentials(chatId, 'settings', { ...creds, thresholdPct: val });
    return bot.sendMessage(chatId,
      `✅ Threshold Alert PnL berhasil diatur ke ${val}%`,
      { parse_mode: 'Markdown' }
    );
  }

  // Wizard for user-defined risk percentage
  if (apiWizard[chatId]?.stage === 'await_risk') {
    const input = msg.text.trim();
    const val = parseFloat(input);
    if (isNaN(val) || val <= 0 || val > 100) {
      return bot.sendMessage(chatId,
        '⚠️ Masukkan angka valid antara 0.01 hingga 100. Coba lagi:',
        { parse_mode: 'Markdown' }
      );
    }
    delete apiWizard[chatId];
    const creds = await getApiCredentials(chatId);
    await saveApiCredentials(chatId, 'settings', { ...creds, defaultRisk: val });
    return bot.sendMessage(chatId,
      `✅ Risiko per trade berhasil diatur ke ${val}%`,
      { parse_mode: 'Markdown' }
    );
  }

  // Handle API Key/Secret wizard steps
  if (apiWizard[chatId]?.stage === 'await_api_key') {
    apiWizard[chatId].apiKey = msg.text.trim();
    apiWizard[chatId].stage = 'await_api_secret';
    return bot.sendMessage(chatId,
      '🔒 Terima kasih. Sekarang silakan masukkan *API Secret* Bybit kamu:',
      { parse_mode: 'Markdown' }
    );
  }
  if (apiWizard[chatId]?.stage === 'await_api_secret') {
    const secret = msg.text.trim();
    const { apiKey } = apiWizard[chatId];
    // validate Bybit credentials
    try {
      const client = new ccxt.bybit({ apiKey, secret, defaultType: 'swap' });
      await client.loadMarkets();
    } catch (err) {
      console.error('Bybit credential validation failed:', err.message);
      apiWizard[chatId].stage = 'await_api_key';
      return bot.sendMessage(chatId,
        `⚠️ Kredensial Bybit tidak valid: ${err.message}\n` +
        `Silakan masukkan *API Key* Bybit kamu kembali:`,
        { parse_mode: 'Markdown' }
      );
    }
    delete apiWizard[chatId];
    try {
      await saveApiCredentials(chatId, 'bybit', { apiKey, secret });
      return bot.sendMessage(chatId, '✅ Bybit API Key & Secret berhasil disimpan!');
    } catch (e) {
      console.error(e);
      return bot.sendMessage(chatId, `⚠️ Gagal menyimpan kredensial: ${e.message}`);
    }
  }
  // Binance API wizard steps
  if (apiWizard[chatId]?.stage === 'await_api_key_binance') {
    apiWizard[chatId].apiKey = msg.text.trim();
    apiWizard[chatId].stage = 'await_api_secret_binance';
    return bot.sendMessage(chatId,
      '🔒 Terima kasih. Sekarang silakan masukkan *API Secret* Binance kamu:',
      { parse_mode: 'Markdown' }
    );
  }
  if (apiWizard[chatId]?.stage === 'await_api_secret_binance') {
    const secret = msg.text.trim();
    const { apiKey } = apiWizard[chatId];
    // validate Binance credentials
    try {
      const client = new ccxt.binance({ apiKey, secret, defaultType: 'future' });
      await client.loadMarkets();
    } catch (err) {
      console.error('Binance credential validation failed:', err.message);
      apiWizard[chatId].stage = 'await_api_key_binance';
      return bot.sendMessage(chatId,
        `⚠️ Kredensial Binance tidak valid: ${err.message}\n` +
        `Silakan masukkan *API Key* Binance kamu kembali:`,
        { parse_mode: 'Markdown' }
      );
    }
    delete apiWizard[chatId];
    try {
      await saveApiCredentials(chatId, 'binance', { apiKey, secret });
      return bot.sendMessage(chatId, '✅ Binance API Key & Secret berhasil disimpan!');
    } catch (e) {
      console.error(e);
      return bot.sendMessage(chatId, `⚠️ Gagal menyimpan kredensial Binance: ${e.message}`);
    }
  }

  switch (msg.text) {
    case '📈 Analisis Chart':
      return bot.sendMessage(chatId,
        '🎯 Kirim chart kamu dengan caption "ETH/USDT" atau biarkan bot deteksi otomatis.'
      );
    case '⚙️ Settings': {
      const creds = await getApiCredentials(chatId);
      const riskPct = creds.settings.defaultRisk !== undefined ? creds.settings.defaultRisk : 1;
      const useNews    = creds.settings.useNews === true;
      const useSent    = creds.settings.useSentimentFilter === true;
      const useMtf     = creds.settings.useMultiTf === true;
      const leverage   = creds.settings.leverage || 10;
      const hasBybit   = Boolean(creds.bybit?.apiKey);
      const hasBinance = Boolean(creds.binance?.apiKey);
      const defaultCex = creds.settings.defaultCex || 'bybit';
      const useMl      = creds.settings.useMlIntervention === true;
      const thresholdPct = creds.settings.thresholdPct !== undefined ? creds.settings.thresholdPct : 5;
      const inlineSettings = {
        reply_markup: {
          inline_keyboard: [
            [
              { text: hasBybit ? '✅ Bybit API' : '🔑 Set Bybit API',   callback_data: 'setting|api_bybit' },
              { text: hasBinance ? '✅ Binance API' : '🔑 Set Binance API', callback_data: 'setting|api_binance' }
            ],
            [
              { text: `💠 Default CEX: ${defaultCex.toUpperCase()}`, callback_data: 'setting|default_cex' }
            ],
            [{ text: `⚙️ Risk %: ${riskPct}%`, callback_data: 'setting|risk' }],
            [{ text: `📰 News: ${useNews ? 'On' : 'Off'}`, callback_data: 'setting|news' }],
            [{ text: `🔔 Sentiment Filter: ${useSent ? 'On' : 'Off'}`, callback_data: 'setting|sentiment' }],
            [{ text: `🔄 Multi-TF: ${useMtf ? 'On' : 'Off'}`, callback_data: 'setting|multitf' }],
            [{ text: `🤖 Machine Learning Intervention: ${useMl ? 'On' : 'Off'}`, callback_data: 'setting|ml_intervention' }],
            [{ text: `🔔 Threshold PnL: ${thresholdPct}%`, callback_data: 'setting|threshold' }],
            [{ text: `⚡ Leverage: ${leverage}×`, callback_data: 'setting|leverage' }]
          ]
        }
      };

      return bot.sendMessage(
        chatId,
        '🔧 Pengaturan trading-mu:\n' +
        '_Atur preferensi risiko, filter berita, dan strategi otomatis di bawah ini._\n\n' +
        '⚠️ _Trading berisiko tinggi. Pastikan setting sudah sesuai profil kamu._',
        {
          parse_mode: 'Markdown',
          reply_markup: inlineSettings.reply_markup
        }
      );
    }
    case '❔ Help':
      return bot.emit('message', { chat: msg.chat, text: '/help' });
    case '📌 Dashboard':
      return bot.emit('message', { chat: msg.chat, text: '/dashboard' });
    default:
      return;
  }
});

// Live PnL updater

// Command /history - show trade history summary and cumulative PnL chart (paged/period)
bot.onText(/\/history(?:\s+(\w+))?(?:\s+(\d+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  let allowed = false;
  await ensurePro(chatId, bot, async () => { allowed = true; });
  if (!allowed) return;

  const period = match[1]?.toLowerCase();
  const page   = parseInt(match[2]) || 0;

  let trades;
  if (['daily','weekly','monthly'].includes(period)) {
    trades = await getTradeHistoryByPeriod(chatId, period, page, HISTORY_PAGE_SIZE);
  } else {
    trades = await getTradeHistoryPaged(chatId, page, HISTORY_PAGE_SIZE);
  }

  if (!trades || trades.length === 0) {
    return bot.sendMessage(chatId, '📊 Belum ada riwayat trade untuk ditampilkan.');
  }

  // Compute PnL groups
  const periods = { daily: {}, weekly: {}, monthly: {} };
  trades.forEach(trade => {
    const entry = new Date(trade.entryAt);
    const pnl   = trade.pnl;
    const dayKey   = entry.toISOString().slice(0,10);
    const weekKey  = `${entry.getUTCFullYear()}-W${Math.ceil((entry.getUTCDate()+6-entry.getUTCDay())/7)}`;
    const monthKey = entry.toISOString().slice(0,7);
    [['daily', dayKey], ['weekly', weekKey], ['monthly', monthKey]]
      .forEach(([p, key]) => { periods[p][key] = (periods[p][key] || 0) + pnl; });
  });

  // Build summary text
  let text = '📈 *Riwayat Trade & Statistik*\n\n';
  for (let p of ['daily','weekly','monthly']) {
    text += `*${p.charAt(0).toUpperCase() + p.slice(1)}:*\n`;
    Object.entries(periods[p]).slice(-HISTORY_PAGE_SIZE).forEach(([k,v]) => {
      text += `• ${k}: ${v.toFixed(2)} USDT\n`;
    });
    text += '\n';
  }

  // Build pagination buttons
  const buttons = [];
  if (page > 0) {
    buttons.push({ text: '⬅️ Prev', callback_data: `history|page|${page-1}|${period||''}` });
  }
  if (trades.length === HISTORY_PAGE_SIZE) {
    buttons.push({ text: '➡️ Next', callback_data: `history|page|${page+1}|${period||''}` });
  }

  return bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [ buttons ] }
  });
});


