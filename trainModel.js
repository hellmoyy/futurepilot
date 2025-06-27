// trainModel.js
import ccxt from 'ccxt';
import fs from 'fs';
import { RandomForestClassifier } from 'ml-random-forest';
import { ATR, EMA, RSI } from 'technicalindicators';

async function fetchFeaturesAndLabels(exchangeId, symbol, timeframe) {
  const client = new ccxt[exchangeId]();
  const ohlcv = await client.fetchOHLCV(symbol, timeframe, undefined, 500);

  const high  = ohlcv.map(c => c[2]);
  const low   = ohlcv.map(c => c[3]);
  const close = ohlcv.map(c => c[4]);
  const volume= ohlcv.map(c => c[5]);

  // Hitung indikator
  const atr   = ATR.calculate({ period: 14, high, low, close });
  const ema50 = EMA.calculate({ period: 50, values: close });
  const ema200= EMA.calculate({ period: 200, values: close });
  const rsi14 = RSI.calculate({ period: 14, values: close });

  const X = [];
  const y = [];

  // Untuk tiap bar, buat fitur dan label (next bar direction)
  for (let i = 200; i < close.length - 1; i++) {
    X.push([
      atr[i - 14],
      ema50[i - 50] - ema200[i - 200],  // gap EMA as feature
      rsi14[i - 14],
      volume[i]
    ]);
    // Label: 1 = harga naik next bar, 0 = turun
    y.push(close[i + 1] > close[i] ? 1 : 0);
  }

  return { X, y };
}

async function train() {
  const { X, y } = await fetchFeaturesAndLabels('binance', 'BTC/USDT', '1h');
  const rf = new RandomForestClassifier({
    nEstimators: 100,
    maxFeatures: 2
  });
  rf.train(X, y);
  // Simpan model
  fs.writeFileSync('rf_model.json', JSON.stringify(rf.toJSON()));
  console.log('Model trained and saved.');
}

train();