#!/usr/bin/env node

/**
 * scripts/generateSyntheticTrades.js
 *
 * Mengisi database Trade dengan synthetic trades hasil backtest strategi crossover SMA.
 * Usage:
 *   node scripts/generateSyntheticTrades.js [symbol] [timeframe] [sinceISO] [exitBars]
 * Example:
 *   node scripts/generateSyntheticTrades.js BTC/USDT 1h 2024-01-01T00:00:00Z 10
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import ccxt from 'ccxt';
import { computeSma } from '../utils/tradeFeatures.js';
import Trade from '../models/Trade.js'; // ensure this file exists

async function main() {
  const [symbol = 'BTC/USDT', timeframe = '1h', sinceISO = '2024-01-01T00:00:00Z', exitBarsArg = '10'] = process.argv.slice(2);
  const exitBars = parseInt(exitBarsArg, 10);
  const since = new Date(sinceISO).getTime();

  // 1. Connect MongoDB
  await mongoose.connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  console.log(`🔌 Connected to MongoDB (${process.env.MONGODB_URI})`);

  // 2. Fetch historical OHLCV
  const exchange = new ccxt.binance({ enableRateLimit: true });
  console.log(`📡 Fetching OHLCV for ${symbol}, since ${sinceISO}, timeframe ${timeframe}...`);
  const ohlc = await exchange.fetchOHLCV(symbol, timeframe, since);
  const closes = ohlc.map(c => c[4]);

  // 3. Compute SMAs
  const smaFast = computeSma(closes, 20);
  const smaSlow = computeSma(closes, 50);

  const syntheticTrades = [];

  // 4. Generate trades on SMA crossover
  for (let i = 51; i < closes.length - exitBars; i++) {
    if (smaFast[i-1] < smaSlow[i-1] && smaFast[i] > smaSlow[i]) {
      const entryAt = new Date(ohlc[i][0]);
      const exitAt  = new Date(ohlc[i + exitBars][0]);
      syntheticTrades.push({ symbol, entryAt, exitAt });
    }
  }

  console.log(`🔄 Generated ${syntheticTrades.length} synthetic trades via SMA crossover.`);

  // 5. Save to DB
  for (const t of syntheticTrades) {
    try {
      await Trade.create(t);
    } catch (e) {
      console.warn(`⚠️ Skipping duplicate: ${t.symbol} @ ${t.entryAt.toISOString()}`);
    }
  }

  console.log(`✅ Saved synthetic trades to database.`);
  process.exit(0);
}

main().catch(err => {
  console.error('❌ Error generating synthetic trades:', err);
  process.exit(1);
});