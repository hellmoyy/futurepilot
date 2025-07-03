import dotenv from 'dotenv';
import mongoose from 'mongoose';

// Load environment variables
dotenv.config();

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => {
  console.log('✅ MongoDB connected for AutoTrade service');
})
.catch(err => {
  console.error('❌ MongoDB connection error for AutoTrade service:', err);
});

import ccxt from 'ccxt';
import cron from 'node-cron';
import { getApiCredentialsForAllUsers } from './db.server.js';
import { analyzeChartData } from './analysis.js';
import TelegramBot from 'node-telegram-bot-api';

const POLL_CRON_SCHEDULE = '*/1 * * * *'; // every 1 minute

// Initialize Telegram client (reuse your BOT_TOKEN)
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: false });

export async function runAutoTradingPass() {
  try {
    // Fetch all users with autoTradingEnabled = true
    const users = await getApiCredentialsForAllUsers({ autoTradingEnabled: true });
    for (const user of users) {
      const { chatId, settings } = user;
      const { autoTradingPairs, defaultCex, defaultRisk, leverage } = settings;
      for (const symbol of autoTradingPairs) {
        try {
          // Analyze chart data (choose timeframe as needed, e.g., '1m')
          const analysis = await analyzeChartData(defaultCex, symbol, '1m', chatId);
          // If analysis returns a actionable signal, execute a trade
          if (analysis && analysis.signal === 'LONG') {
            // Create a market order long, using your existing order function
            await executeTrade(defaultCex, symbol, 'long', defaultRisk, leverage, chatId, bot);
          } else if (analysis && analysis.signal === 'SHORT') {
            await executeTrade(defaultCex, symbol, 'short', defaultRisk, leverage, chatId, bot);
          }
        } catch (e) {
          console.error(`AutoTrade error for user ${chatId}, symbol ${symbol}:`, e);
        }
      }
    }
  } catch (e) {
    console.error('AutoTrade engine failure:', e);
  }
}

// Schedule the auto‐trading pass
cron.schedule(POLL_CRON_SCHEDULE, () => {
  console.log('Running auto‐trading scheduler...');
  runAutoTradingPass();
});

console.log('AutoTrade service started, polling schedule:', POLL_CRON_SCHEDULE);

// Helper: wrap your existing order logic into executeTrade
async function executeTrade(cex, symbol, side, riskPercent, leverage, chatId, botInstance) {
  // Import your order placement function
  const { placeOrderWithSlTp } = await import('./tradeExecutor.js');
  try {
    console.log(`[AutoTrade] ${side.toUpperCase()} ${symbol} | Risk%: ${riskPercent} | Leverage: ${leverage} | ChatId: ${chatId}`);
    // Execute the trade and capture the returned order details
    const orderResult = await placeOrderWithSlTp({
      cex,
      symbol,
      side,
      riskPercent,
      leverage,
      chatId,
      bot: botInstance
    });
    // Send notification to user about the executed trade
    const qty   = orderResult?.amount ?? orderResult?.qty ?? 'N/A';
    const price = orderResult?.price  ?? 'market';
    await botInstance.sendMessage(
      chatId,
      `🚀 Auto Trade executed: ${side.toUpperCase()} ${symbol}\n` +
      `Qty: ${qty} at Price: ${price}`
    );
  } catch (err) {
    console.error(`AutoTrade execution error for ${symbol}:`, err);
    // Notify user of failure
    await botInstance.sendMessage(
      chatId,
      `⚠️ Auto Trade failed for ${symbol}: ${err.message}`
    );
  }
}
