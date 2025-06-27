// bot.js
import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
import axios from 'axios';
import Sentiment from 'sentiment';
const sentiment = new Sentiment();
import { detectSymbolFromImage } from './ocr.js';
import { analyzeChartData, generateDetailedAnalysis } from './analysis.js';
import { saveApiCredentials, getApiCredentials } from './db.js';
import { calcATR, calcSLTP, calcQuantity, confirmSignal } from './riskManager.js';
import ccxt from 'ccxt';
// Tambahkan di bagian atas bot.js
import cron from 'node-cron';
import { getAllChatIds } from './db.js';
import Parser from 'rss-parser';
import { ensembleConfirm } from './riskManager.js';

// Store active trades for live PnL updates
const liveTrades = {}; // key: chatId, value: { symbol, side, entry, qty }
// Temporary store for mapping user to file, symbols, and execution contexts
const tempStore = {};

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

// Setelah console.log('🚀 Bot jalan pakai long-polling');
bot.setMyCommands([
  { command: 'trade',     description: 'Execute trade on connected CEX' },
  { command: 'dashboard', description: 'Show and pin your dashboard summary' }
]);
// Command to start PnL tracking
bot.onText(/\/track/, (msg) => {
  const chatId = msg.chat.id;
  if (!liveTrades[chatId]) {
    return bot.sendMessage(chatId, '⚠️ Belum ada trade aktif untuk dilacak. Eksekusi order dulu.');
  }
  return bot.sendMessage(chatId, '✅ Mulai memantau live PnL untuk trade aktif.');
});

// Command to stop PnL tracking
bot.onText(/\/stoptrack/, (msg) => {
  const chatId = msg.chat.id;
  delete liveTrades[chatId];
  return bot.sendMessage(chatId, '✅ Live PnL tracking dihentikan.');
});

bot.onText(/\/trade/, async (msg) => {
  const chatId = msg.chat.id;
  const creds = await getApiCredentials(chatId);
  const useCex = creds.settings.defaultCex || 'bybit';
  if (!creds[useCex]?.apiKey) {
    return bot.sendMessage(
      chatId,
      `⚠️ ${useCex.toUpperCase()} belum terkoneksi. Gunakan /connect_${useCex} <API_KEY> <SECRET>.`
    );
  }
  // Prepare contexts for buy and sell
  tempStore[chatId] = tempStore[chatId] || {};
  tempStore[chatId].execContext = tempStore[chatId].execContext || {};
  const setupActionData = [
    { label: 'Buy Market', side: 'long', trend: 'bullish' },
    { label: 'Sell Market', side: 'short', trend: 'bearish' }
  ];
  const buttons = setupActionData.map(({ label, side, trend }) => {
    const execId = `${chatId}_${Date.now()}_${side}`;
    tempStore[chatId].execContext[execId] = {
      useCex,
      side,
      symbol: creds.defaultSymbol || '',
      entry: creds.defaultEntry || '',
      sl: creds.defaultSL || '',
      tp: creds.defaultTP || '',
      trend,
      timeframe: creds.settings.defaultTimeframe || '1h'
    };
    return {
      text: label,
      callback_data: `execute_direct|${execId}`
    };
  });
  return bot.sendMessage(chatId,
    `⚙️ Pilih aksi trading di ${useCex.toUpperCase()}:`, {
      reply_markup: {
        inline_keyboard: [buttons]
      }
    }
  );
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
  const creds = await getApiCredentials(chatId);
  const hasBybit = Boolean(creds.bybit?.apiKey);
 const useNews = creds.settings.useNews === true;
 const useSentiment = creds.settings.useSentimentFilter === true;
 const useMultiTf = creds.settings.useMultiTf === true;
 const defaultCex = creds.settings.defaultCex || 'bybit';
 const riskPct = creds.settings.defaultRisk !== undefined ? creds.settings.defaultRisk : 1;
  const hasBinance = Boolean(creds.binance?.apiKey);
  // Per-user risk percentage setting (default 1%)


  // Main menu reply keyboard
  const replyKeyboard = {
    reply_markup: {
      keyboard: [
        ['📈 Analisis Chart', '🚀 Trade'],
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

// Command /help
bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  const helpMsg = `
📖 *Daftar Command*:
/help – Tampilkan bantuan
/connect_bybit <API_KEY> <SECRET> – Sambung Bybit
Kirim chart dengan caption "ETH/USDT" atau biarkan bot deteksi otomatis.
  `;
  bot.sendMessage(chatId, helpMsg, { parse_mode: 'Markdown' });
});


// Command /dashboard - show and pin user dashboard summary
bot.onText(/\/dashboard/, async (msg) => {
  const chatId = msg.chat.id;
  const creds = await getApiCredentials(chatId);
  const hasBybit = Boolean(creds.bybit?.apiKey);
 const riskPct = creds.settings.defaultRisk !== undefined ? creds.settings.defaultRisk : 1;
 const timeframe = creds.settings.defaultTimeframe || '1h';
 const newsStatus = creds.settings.useNews ? 'On' : 'Off';
 const sentimentStatus = creds.settings.useSentimentFilter ? 'On' : 'Off';
 const multiTfStatus = creds.settings.useMultiTf ? 'On' : 'Off';
 const leverage = creds.settings.leverage || 10;
  const dashboardText =
    `📌 *Dashboard Summary*\n\n` +
    `🔑 Bybit API: ${hasBybit ? '✅ Connected' : '❌ Not Connected'}\n` +
    `⚙️ Risk %: ${riskPct}%\n` +
    `⏱ Default Timeframe: ${timeframe}\n` +
    `📰 News: ${newsStatus}\n` +
    `🔄 Multi-TF: ${multiTfStatus}\n` +
    `⚡ Leverage: ${leverage}×\n` +
    `🔔 Sentiment Filter: ${sentimentStatus}`;
  const dashMsg = await bot.sendMessage(chatId, dashboardText, { parse_mode: 'Markdown' });
  await bot.pinChatMessage(chatId, dashMsg.message_id);
});

// Command connect ke exchange
bot.onText(/\/connect_(binance|bybit) (\S+) (\S+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const [, ex, apiKey, secret] = match;
  try {
    await saveApiCredentials(chatId, ex, { apiKey, secret });
    await bot.sendMessage(chatId, `✅ ${ex.toUpperCase()} connected!`);
  } catch (e) {
    console.error(e);
    await bot.sendMessage(chatId, `⚠️ Gagal menyimpan kredensial: ${e.message}`);
  }
});


// Wizard state for API key/secret input per user
const apiWizard = {}; // key: chatId, value: { stage: 'await_api_key' | 'await_api_secret', apiKey: string }

// Handler foto chart: detect simbol & prompt timeframe
bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
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
    const data = query.data;
    await bot.answerCallbackQuery(query.id);

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
          return bot.editMessageText(`⚠️ Error analisa chart: ${errAnalysis.message}`, {
            chat_id: chatId,
            message_id: loadingMsg.message_id
          });
        }
        let { trend, entry, sl, tp, atr, resistance, support, vwap, rsi, stochastic } = analysis;

        // Override entry/SL/TP with real-time price from selected CEX
        const clientRT = new ccxt[useCex]({
          apiKey: creds[useCex].apiKey,
          secret: creds[useCex].secret,
          timeout: 30000,            // increase request timeout to 30s
          enableRateLimit: true,     // respect rate limits
          options: { defaultType: 'swap' }
        });
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

        // Build a simple summary
        const setupAction = trend === 'bullish' ? 'Buy' : 'Sell';
        const summaryMsg =
          `🎯 Analisis ${symbol} (${timeframe})\n\n` +
          `📈 Trend: *${trend}*\n` +
          `🛠️ Setup: ${setupAction} @${entry.toFixed(2)}, SL @${sl.toFixed(2)}, TP @${tp.toFixed(2)}`;

        // Show summary with "Lihat Detail" button
        return bot.editMessageText(summaryMsg, {
          chat_id: chatId,
          message_id: loadingMsg.message_id,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔍 Lihat Detail', callback_data: 'view_detail' }]
            ]
          }
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
        options: { defaultType: 'swap' }
      });

      // Calculate qty and confirm signal
      let qty;
      try {
        const ohlcv = await client.fetchOHLCV(symbol, timeframe, undefined, 20);
        const high = ohlcv.map(c => c[2]);
        const low = ohlcv.map(c => c[3]);
        const close = ohlcv.map(c => c[4]);
        const volume = ohlcv.map(c => c[5]);
        // Recalculate ATR for order execution
        const atrArray = calcATR(high, low, close);
        const atr = Array.isArray(atrArray) ? atrArray.at(-1) : atrArray;
        // Ensemble ML confirmation
        const isValid = ensembleConfirm(high, low, close, volume, side, 0.6);
        if (!isValid) {
          return bot.sendMessage(chatId, '⚠️ Sinyal tidak cukup kuat menurut Ensemble ML. Trade dibatalkan.');
        }
        if (!confirmSignal(trend, close)) {
          return bot.sendMessage(chatId, '⚠️ Konfirmasi teknikal gagal. Trade dibatalkan.');
        }
        const { stopLoss, takeProfit } = calcSLTP(entry, side, atr);
        const balance = (await client.fetchBalance()).total.USDT;
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
        const order = await client.createOrder(symbol, 'market', side, qty);
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
      // Retrieve user credentials and context
      const creds = await getApiCredentials(chatId);
      const ctx = tempStore[chatId]?.execContext?.[execId];
      if (!ctx) {
        return bot.sendMessage(chatId, '⚠️ Eksekusi gagal: context tidak ditemukan.');
      }
      const { useCex: ex, side, symbol, entry, sl, tp } = ctx;
      // Ensure API connection
      if (!creds[ex]?.apiKey) {
        return bot.sendMessage(chatId, `⚠️ ${ex.toUpperCase()} belum terkoneksi.`);
      }
      // Initialize client
      const client = new ccxt[ex]({
        apiKey: creds[ex].apiKey,
        secret: creds[ex].secret,
        timeout: 30000,
        enableRateLimit: true,
        options: { defaultType: 'swap' }
      });
      let leverage = (creds.settings.leverage) || 10;
      let mkt;
      try {
        await client.loadMarkets();
        mkt = client.market(symbol);
        // Ensure isolated margin mode for futures
        try {
          await client.setMarginMode('isolated', symbol);
        } catch (_) {
          // some exchanges may not support margin mode change
        }
        if (ex === 'bybit' && mkt.linear) {
          await client.setLeverage(leverage, symbol);
        }
      } catch (e) {
        console.warn('setLeverage/margin skip/error:', e.message);
        // lanjutkan tanpa setLeverage jika memang tidak support
      }
      // Fetch futures balance (swap)
      let balance;
      try {
        const balanceResponse = await client.fetchBalance({ type: 'swap' });
        balance = balanceResponse.free.USDT;
      } catch (e) {
        // fallback to default if needed
        const fallback = await client.fetchBalance();
        balance = fallback.free.USDT;
      }
      const riskPct = (creds.settings.defaultRisk !== undefined ? creds.settings.defaultRisk : 1) / 100;
      // [Order Debug] log before qty calculation
      console.log(`[Order Debug] symbol=${symbol}, entry=${entry}, sl=${sl}, tp=${tp}, side=${side}, leverage=${leverage}, balance=${balance}, riskPct=${riskPct}`);
      let qty = calcQuantity(balance, parseFloat(entry), parseFloat(sl), riskPct, leverage);
      console.log(`[Order Debug] calculated raw qty=${qty.toFixed(6)}`);
      // Robust rounding to market limits
      const limits = mkt.limits?.amount || {};
      const minQty = typeof limits.min === 'number' ? limits.min : 0;
      const step   = typeof limits.step === 'number' && limits.step > 0 ? limits.step : minQty || 1;
      let roundedQty;
      if (step > 0) {
        roundedQty = Math.floor(qty / step) * step;
        if (roundedQty < minQty) roundedQty = minQty;
      } else {
        roundedQty = qty;
      }
      let orderQty = roundedQty;
      // Compute maximum quantity based on balance and leverage
      // Configurable safety buffer for order sizing (e.g., 0.5 for 50%)
      const SAFETY_FACTOR = 0.1;
      // Max contracts = balance * leverage (1 contract = $1 notional)
      const maxQtyRaw = balance * leverage;
      let maxQty = Math.floor(maxQtyRaw / step) * step;
      if (maxQty < minQty) maxQty = minQty;
      // Account for exchange taker fee to ensure sufficient margin
      const feeRate = (mkt.taker || 0.00075);  // fallback to 0.075% if not provided
      const adjustedFactor = SAFETY_FACTOR * (1 - feeRate);
      const safeMaxQtyRaw = maxQtyRaw * adjustedFactor;
      let safeMaxQty = Math.floor(safeMaxQtyRaw / step) * step;
      if (safeMaxQty < minQty) safeMaxQty = minQty;
      // Debug log
      console.log(`[Order Debug] maxQtyRaw=${maxQtyRaw.toFixed(6)}, maxQty=${maxQty.toFixed(6)}, safeMaxQty=${safeMaxQty.toFixed(6)}`);
      // Use safeMaxQty for comparison
      if (orderQty > safeMaxQty) {
        orderQty = safeMaxQty;
        await bot.sendMessage(chatId,
          `⚠️ Jumlah order telah disesuaikan ke maksimal aman yang tersedia: ${orderQty.toFixed(6)} ${symbol}. ` +
          `Silakan turunkan risiko, tambah leverage, atau top up saldo jika ingin qty lebih besar.`);
      }
      console.log(`[Order Debug] final orderQty after clamp=${orderQty.toFixed(6)}`);
      // Ensure that orderQty is a valid number before placing the order
      if (!Number.isFinite(orderQty) || orderQty <= 0) {
        return bot.sendMessage(chatId, `⚠️ Gagal eksekusi order: qty tidak valid (${orderQty}). Cek pengaturan risk/leverage atau saldo anda.`);
      }
      const sideParam = side === 'long' ? 'Buy' : 'Sell';
      let order;
      let attemptQty = orderQty;
      while (attemptQty >= minQty) {
        // Required initial margin in USDT = notional contracts / leverage
        const requiredMargin = attemptQty / leverage;
        console.log(`[Order Debug] attemptQty=${attemptQty.toFixed(6)}, requiredMargin=${requiredMargin.toFixed(2)}, balance=${balance.toFixed(2)}`);
        if (requiredMargin > balance) {
          console.log(`[Order Debug] requiredMargin (${requiredMargin.toFixed(2)}) exceeds balance (${balance.toFixed(2)}), decrementing qty`);
          attemptQty = attemptQty - step;
          continue;
        }
        try {
          order = await client.createOrder(symbol, 'market', sideParam, attemptQty);
          break; // success
        } catch (err) {
          console.error('Direct execute order error:', err);
          const isInsufficient = err.message.includes('Insufficient') 
            || (err?.retMsg && err.retMsg.includes('Insufficient'));
          if (!isInsufficient) {
            // other error, stop retrying
            return bot.sendMessage(chatId, `⚠️ Gagal eksekusi order: ${err.message}`);
          }
          // insufficient funds, decrement qty and retry
          attemptQty = attemptQty - step;
          console.log(`[Order Retry] reducing qty to ${attemptQty.toFixed(6)} and retrying`);
        }
      }
      if (!order) {
        return bot.sendMessage(chatId,
          `⚠️ Gagal eksekusi order: tidak ada kuantitas yang cukup setelah mencoba dari ${orderQty.toFixed(6)} hingga minimum ${minQty}`);
      }
      // Step 4A: Simpan live trade untuk PnL updater
      liveTrades[chatId] = {
        symbol,
        side,
        entry: parseFloat(entry),
        qty: orderQty,
        platform: ex.charAt(0).toUpperCase() + ex.slice(1),
        pnlMessageId: null, // akan di-set saat pertama update
        thresholdPct: creds.settings.thresholdPct !== undefined ? creds.settings.thresholdPct : 5,
        lastAlert: null
      };
      // Step 4B: Siapkan pesan PnL pertama dan simpan message_id
      const execMsg = await bot.sendMessage(chatId,
        `✅ Order executed on ${ex}: ${order.id}\n` +
        `🔔 Live PnL tracking dimulai. Tunggu beberapa detik untuk update pertama.`
      );
      // Simpan message_id untuk edit PnL update
      liveTrades[chatId].pnlMessageId = execMsg.message_id;
      return;
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
        options: { defaultType: 'swap' }
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
            [{ text: `⚙️ Risk %: ${rpct}%`,                         callback_data: 'setting|risk' }],
            [{ text: `📰 News: ${useNews ? 'On' : 'Off'}`,             callback_data: 'setting|news' }],
            [{ text: `🔔 Sentiment Filter: ${useSent ? 'On' : 'Off'}`, callback_data: 'setting|sentiment' }],
            [{ text: `🔄 Multi-TF: ${useMtf ? 'On' : 'Off'}`,          callback_data: 'setting|multitf' }],
            [{ text: `⏱ TF: ${tf}`,                                   callback_data: 'setting|default_timeframe' }],
            [{ text: `⚡ Leverage: ${leverage}×`,                       callback_data: 'setting|leverage' }],
            [{ text: `🔔 Threshold PnL: ${thresholdPct}%`,              callback_data: 'setting|threshold' }],
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
  const chatId = msg.chat.id;
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
      const client = new ccxt.bybit({ apiKey, secret, options: { defaultType: 'swap' } });
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
      const client = new ccxt.binance({ apiKey, secret, options: { defaultType: 'future' } });
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
    case '🚀 Trade':
      return bot.emit('text', { chat: msg.chat, text: '/trade' });
    case '⚙️ Settings': {
      const creds = await getApiCredentials(chatId);
      const riskPct = creds.settings.defaultRisk !== undefined ? creds.settings.defaultRisk : 1;
      const useNews    = creds.settings.useNews === true;
      const useSent    = creds.settings.useSentimentFilter === true;
      const useMtf     = creds.settings.useMultiTf === true;
      const leverage   = creds.settings.leverage || 10;
      const inlineSettings = {
        reply_markup: {
          inline_keyboard: [
            [{ text: `⚙️ Risk %: ${riskPct}%`,                         callback_data: 'setting|risk' }],
            [{ text: `📰 News: ${useNews ? 'On' : 'Off'}`,               callback_data: 'setting|news' }],
            [{ text: `🔔 Sentiment Filter: ${useSent ? 'On' : 'Off'}`,  callback_data: 'setting|sentiment' }],
            [{ text: `🔄 Multi-TF: ${useMtf ? 'On' : 'Off'}`,            callback_data: 'setting|multitf' }],
            [{ text: `⚡ Leverage: ${leverage}×`,                        callback_data: 'setting|leverage' }]
          ]
        }
      };
      return bot.sendMessage(chatId, '🔧 Pengaturan:', inlineSettings);
    }
    case '❔ Help':
      return bot.emit('text', { chat: msg.chat, text: '/help' });
    default:
      return;
  }
});

// Live PnL updater

setInterval(async () => {
  try {
    for (const [chatIdStr, trade] of Object.entries(liveTrades)) {
      const chatId = parseInt(chatIdStr);
      try {
        const creds = await getApiCredentials(chatId);
        const useCex = creds.settings.defaultCex || 'bybit';
        const client = new ccxt[useCex]({
          apiKey: creds[useCex].apiKey,
          secret: creds[useCex].secret,
          options: { defaultType: 'swap' }
        });
        // Step 4C: thresholdPct fallback
        const thresholdPct = trade.thresholdPct !== undefined ? trade.thresholdPct : 5;
        const ticker = await client.fetchTicker(trade.symbol);
        const mark = ticker.last;
        // Calculate PnL and percent...
        let pnl = trade.side === 'buy'
          ? (mark - trade.entry) * trade.qty
          : (trade.entry - mark) * trade.qty;
        pnl = pnl.toFixed(2);
        const percent = trade.side === 'buy'
          ? (mark - trade.entry) / trade.entry * 100
          : (trade.entry - mark) / trade.entry * 100;
        const absPct = Math.min(Math.abs(percent), 10);
        // Threshold alerts...
        if (percent >= thresholdPct && trade.lastAlert !== 'profit') {
          await bot.sendMessage(chatId,
            `🔔 *Alert:* PnL sudah mencapai ${percent.toFixed(2)}% profit!`, { parse_mode: 'Markdown' });
          trade.lastAlert = 'profit';
        } else if (percent <= -thresholdPct && trade.lastAlert !== 'loss') {
          await bot.sendMessage(chatId,
            `🔔 *Alert:* PnL sudah mencapai ${percent.toFixed(2)}% loss!`, { parse_mode: 'Markdown' });
          trade.lastAlert = 'loss';
        }
        const fillCount = Math.round((absPct / 10) * 10);
        const bar = (percent >= 0
          ? '🟩'.repeat(fillCount)
          : '🟥'.repeat(fillCount)
        ) + '⬜'.repeat(10 - fillCount);
        const pctText = `${percent >= 0 ? '+' : '-'}${Math.abs(percent).toFixed(2)}%`;
        try {
          await bot.editMessageText(
            `📊 Live PnL untuk *${trade.symbol}* (${trade.side.toUpperCase()}) on ${trade.platform}:\n` +
            `• Entry: ${trade.entry.toFixed(2)}\n` +
            `• Harga sekarang: ${mark.toFixed(2)}\n` +
            `• Qty: ${trade.qty.toFixed(4)}\n` +
            `• *PnL:* ${pnl} USDT\n` +
            `${bar} (${pctText})`,
            {
              chat_id: chatId,
              message_id: trade.pnlMessageId,
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [[
                  { text: trade.side === 'buy' ? 'Close Long' : 'Close Short', callback_data: trade.closeCallbackData }
                ]]
              }
            }
          );
        } catch (e) {
          console.error(`Failed to edit PnL message for chat ${chatId}:`, e);
        }
      } catch (e) {
        console.error(`Live PnL processing error for chat ${chatId}:`, e);
      }
    }
  } catch (err) {
    console.error('Live PnL updater entire loop error:', err);
  }
}, 30000);

