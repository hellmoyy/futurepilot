import ccxt from 'ccxt';
import { predictClose } from '../ml/predict.js';
import { getApiCredentials } from '../db.server.js';
import { computeRsi, computeAtrPct, computeReturn1h } from '../utils/tradeFeatures.js';
// Cache for ticker prices
const tickerCache = {};
// Default interval in ms
const DEFAULT_PNL_INTERVAL = 30000;

export async function startLivePnLTracking(bot, liveTrades) {
  // Dynamic live PnL updater
  async function runUpdater() {
    for (const chatId of Object.keys(liveTrades)) {
      const trades = liveTrades[chatId];
      if (!trades || trades.length === 0) {
        delete liveTrades[chatId];
        continue;
      }
      // Load user credentials
      const creds = await getApiCredentials(parseInt(chatId));
      if (!creds.settings.useMlIntervention) continue;
      // Extract ML threshold with default fallback
      const mlThreshold = typeof creds.settings.mlThreshold === 'number'
        ? creds.settings.mlThreshold
        : 0.5;
      // Initialize exchange client
      const useCex = creds.settings.defaultCex || 'bybit';
      const client = new ccxt[useCex]({
        apiKey: creds[useCex].apiKey,
        secret: creds[useCex].secret,
        enableRateLimit: true,
        defaultType: 'future'
      });
      for (const trade of trades.slice()) {
        try {
          // Skip ML close if trade just opened (minimum 1 minute delay)
          if (Date.now() - trade.openTime < 60_000) {
            continue;
          }
          // Fetch or get cached ticker
          let mark;
          const now = Date.now();
          if (tickerCache[trade.symbol] && now - tickerCache[trade.symbol].timestamp < 5000) {
            mark = tickerCache[trade.symbol].price;
          } else {
            const ticker = await client.fetchTicker(trade.symbol);
            mark = ticker.last;
            tickerCache[trade.symbol] = { price: mark, timestamp: now };
          }
          // Compute features
          const rsi    = await computeRsi(trade, creds);
          const atrPct = await computeAtrPct(trade, creds);
          const ret1h  = await computeReturn1h(trade, creds);
          // Predict using ML
          const { action, confidence } = await predictClose({
            rsi,
            atrPct,
            ret1h,
            threshold: mlThreshold
          });
          if (action === 'close') {
            const sideOpp = trade.side === 'long' ? 'sell' : 'buy';
            await client.createOrder(trade.symbol, 'market', sideOpp, trade.qty);
            await bot.sendMessage(parseInt(chatId),
              `🤖 ML Intervention: Closed ${trade.symbol} (${trade.side.toUpperCase()}) — Conf ${(confidence*100).toFixed(1)}%`,
              { parse_mode: 'Markdown' }
            );
            // Remove trade from tracking
            liveTrades[chatId] = liveTrades[chatId].filter(t => t !== trade);
          }
        } catch (e) {
          console.error(`ML PnL error for chat ${chatId}:`, e.message);
        }
      }
    }
  
  // Determine next interval per active chat settings
  const chatIds = Object.keys(liveTrades);
  if (chatIds.length === 0) {
    // No active trades, schedule a check later
    setTimeout(runUpdater, DEFAULT_PNL_INTERVAL);
    return;
  }
  try {
    // Fetch intervals in parallel
    const intervals = await Promise.all(
      chatIds.map(id => getApiCredentials(parseInt(id)).then(c => c.settings.pnlIntervalMs || DEFAULT_PNL_INTERVAL))
    );
    const nextInterval = Math.min(...intervals);
    setTimeout(runUpdater, nextInterval);
  } catch (e) {
    console.error('Error fetching intervals for scheduling:', e.message);
    setTimeout(runUpdater, DEFAULT_PNL_INTERVAL);
  }
  }
  // Kick off first run
  runUpdater();
}