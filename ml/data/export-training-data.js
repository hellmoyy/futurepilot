/**
 * export-training-data.js
 *
 * Connects to MongoDB, reads past trades, computes features (RSI, ATR%, 1h return),
 * labels whether the trade was closed within 1 hour (label=1) or not (label=0),
 * and writes out to training-data.json under ml/data/.
 */

import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { RSI, ATR } from 'technicalindicators';
import ccxt from 'ccxt';
// Public CCXT client for fetching historical OHLCV data
const client = new ccxt.bybit({ enableRateLimit: true });

import { getTradeHistoryPaged } from '../../db.server.js';
// ML feature engineering helpers
import {
  computeMomentum,
  computeSma,
  computeEma,
  computeBollingerBands,
  computeObv,
  computeVwap,
  computeOrderBookImbalance,
  computeVolatilitySpike,
  fetchFundingRateAny,
  fetchOpenInterestAny
} from '../../utils/tradeFeatures.js';

// Emulate __dirname for ES module
const __dirname = dirname(fileURLToPath(import.meta.url));

// MongoDB connection URI (allow both MONGO_URI and MONGODB_URI)
const MONGO_URI = process.env.MONGODB_URI || 'mongodb+srv://hellmoyy:pisanggoreng1933@cluster0.kob5ynh.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0';

async function main() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log('🔌 Connected to MongoDB');
  } catch (err) {
    console.error('❌ Gagal terhubung ke MongoDB:', err.message);
    console.error(`   Pastikan instance MongoDB berjalan dan variabel MONGO_URI benar (sekarang: ${MONGO_URI})`);
    process.exit(1);
  }

  // Fetch all trades (page by page)
  const pageSize = 500;
  let page = 0;
  let allRecords = [];

  while (true) {
    const trades = await getTradeHistoryPaged(null, page, pageSize);
    if (!trades || trades.length === 0) break;

    for (const t of trades) {
      try {
        const entryTime = new Date(t.entryAt);
        const exitTime  = t.exitAt ? new Date(t.exitAt) : null;

        // --- Compute real features ---
        // RSI over last 14 hourly bars
        const rsiPeriod = 14;
        const sinceRsi = entryTime.getTime() - (rsiPeriod + 1) * 60 * 60 * 1000;
        const ohlcRsi = await client.fetchOHLCV(t.symbol, '1h', sinceRsi, rsiPeriod + 1);
        const closesRsi = ohlcRsi.map(c => c[4]);
        const rsiArr = RSI.calculate({ period: rsiPeriod, values: closesRsi });
        const rsi = rsiArr.length ? rsiArr[rsiArr.length - 1] : 50;

        // ATR percentage over same period
        const highsRsi = ohlcRsi.map(c => c[2]);
        const lowsRsi  = ohlcRsi.map(c => c[3]);
        const atrArr = ATR.calculate({ period: rsiPeriod, high: highsRsi, low: lowsRsi, close: closesRsi });
        const atr = atrArr.length ? atrArr[atrArr.length - 1] : 0;
        const atrPct = closesRsi.length ? atr / closesRsi[closesRsi.length - 1] : 0;

        // 1h future return
        const ohlc2 = await client.fetchOHLCV(t.symbol, '1h', entryTime.getTime(), 2);
        let ret1h = 0;
        if (ohlc2.length >= 2) {
          const entryClose = ohlc2[0][4];
          const futureClose = ohlc2[1][4];
          ret1h = entryClose ? (futureClose - entryClose) / entryClose : 0;
        }

        // --- Additional features ---
        // Prepare arrays from ohlcRsi
        const volumesRsi = ohlcRsi.map(c => c[5]);
        // Momentum (10-bar)
        const momentumArr = computeMomentum(closesRsi, 10);
        const momentum = momentumArr[momentumArr.length - 1] || 0;
        // Moving Averages
        const smaArr = computeSma(closesRsi, 20);
        const sma = smaArr[smaArr.length - 1] || closesRsi[closesRsi.length - 1];
        const emaArr = computeEma(closesRsi, 20);
        const ema = emaArr[emaArr.length - 1] || closesRsi[closesRsi.length - 1];
        // Bollinger Bands
        const bbArr = computeBollingerBands(closesRsi, 20, 2);
        const { upper: bbUpper, middle: bbMiddle, lower: bbLower } = bbArr[bbArr.length - 1] || {};
        // OBV & VWAP
        const obvArr = computeObv(closesRsi, volumesRsi);
        const obv = obvArr[obvArr.length - 1] || 0;
        const vwapArr = computeVwap(highsRsi, lowsRsi, closesRsi, volumesRsi);
        const vwap = vwapArr[vwapArr.length - 1] || closesRsi[closesRsi.length - 1];
        // Volatility Spike
        const volSpike = computeVolatilitySpike(highsRsi, lowsRsi, closesRsi, 14, 50);
        // Orderbook Imbalance
        const orderbook = await client.fetchOrderBook(t.symbol, 10);
        const obImbalance = computeOrderBookImbalance(orderbook.bids, orderbook.asks);
        // Funding rate & Open Interest features
        const fundingRate = await fetchFundingRateAny(t, {});
        const openInterest = await fetchOpenInterestAny(t, {});

        // Time features
        const hourOfDay = entryTime.getUTCHours();
        const dayOfWeek = entryTime.getUTCDay();

        // Label: closed within 1 hour?
        const label = exitTime && (exitTime - entryTime) <= 3600 * 1000 ? 1 : 0;

        // Skip if any feature is not a finite number
        const featureValues = [
          rsi, atrPct, ret1h, momentum,
          sma, ema, bbUpper, bbMiddle,
          bbLower, obv, vwap, volSpike,
          obImbalance, fundingRate, openInterest,
          hourOfDay, dayOfWeek
        ];
        if (featureValues.some(v => typeof v !== 'number' || !isFinite(v))) {
          console.warn(`⚠️ Skipping trade ${t._id} due to invalid feature values:`, featureValues);
          continue;
        }

        allRecords.push({
          entryAt: entryTime.toISOString(),
          rsi,
          atrPct,
          ret1h,
          momentum,
          sma,
          ema,
          bbUpper,
          bbMiddle,
          bbLower,
          obv,
          vwap,
          volSpike,
          obImbalance,
          // new features from funding rate and open interest
          fundingRate,
          openInterest,
          hourOfDay,
          dayOfWeek,
          label
        });
      } catch (err) {
        console.error(`❌ Skipping trade ${t._id} due to error:`, err.message);
        continue;
      }
    }

    page++;
  }

  const outPath = path.resolve(__dirname, 'training-data.json');
  fs.writeFileSync(outPath, JSON.stringify(allRecords, null, 2));
  console.log(`💾 Wrote ${allRecords.length} records to ${outPath}`);

  process.exit(0);
}

main().catch(err => {
  console.error('Error di ekspor data:', err);
  console.error('Setelah memperbaiki koneksi MongoDB, jalankan ulang: node ml/data/export-training-data.js');
  process.exit(1);
});
