import fs from 'fs';
import { RandomForestClassifier } from 'ml-random-forest';
import { ATR, RSI, MACD, EMA } from 'technicalindicators';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
import pkgSVM from 'libsvm-js';
const { SVM } = pkgSVM;
import { Matrix } from 'ml-matrix';

export function calcATR(high, low, close, period = 14) {
  const result = ATR.calculate({ high, low, close, period });
  return result[result.length - 1];
}

export function calcRSI(close, period = 14) {
  const result = RSI.calculate({ values: close, period });
  return result[result.length - 1];
}

export function calcMACD(close, opts = { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 }) {
  const result = MACD.calculate({ values: close, ...opts });
  return result[result.length - 1].histogram;
}

export function calcSLTP(entry, side, atr) {
  const slBuffer = 1.5 * atr;
  const tpBuffer = 2.5 * atr;
  return side === 'buy'
    ? { stopLoss: entry - slBuffer, takeProfit: entry + tpBuffer }
    : { stopLoss: entry + slBuffer, takeProfit: entry - tpBuffer };
}

/**
 * Calculate position size for futures USDT-perpetual based on risk and leverage.
 * @param {number} balance   Free balance USDT
 * @param {number} entry     Entry price (not used in futures calculation)
 * @param {number} stopLoss  Stop loss price (not used in futures calculation)
 * @param {number} riskPct   Risk percentage per trade (e.g. 0.01 for 1%)
 * @param {number} leverage  Leverage multiplier (e.g. 10 for 10x). Defaults to 1.
 * @returns {number}         Position size in contracts (integer)
 */
export function calcQuantity(balance, entry, stopLoss, riskPct, leverage = 1) {
  // futures (USDT perpetual): contracts = (balance * riskPct * leverage) / contractSize
  const riskAmount   = balance * riskPct;        // USDT at risk
  const notional     = riskAmount * leverage;    // USDT notional
  const contractSize = 1;                        // USD per contract
  let qtyContracts   = notional / contractSize;  // number of contracts
  // round down to nearest whole contract
  qtyContracts = Math.floor(qtyContracts);
  return qtyContracts;
}

export function confirmSignal(trend, high, low, close, atrValue) {
  if (isMarketUnfavorable(close, atrValue)) return false;
  const rsi = calcRSI(close);
  const macdHist = calcMACD(close);
  if (trend === 'bullish') {
    return rsi < 70 && macdHist > 0;
  } else if (trend === 'bearish') {
    return rsi > 30 && macdHist < 0;
  }
  return false;
}


/**
 * Cek apakah kondisi pasar terlalu volatil atau tidak jelas
 * @param {number[]} closePrices
 * @param {number} atrValue
 * @param {number} thresholdVolatility - contoh 0.02 artinya ATR > 2% harga
 */
export function isMarketUnfavorable(closePrices, atrValue, thresholdVolatility = 0.02) {
  const lastClose = closePrices.at(-1);
  // Jika ATR > thresholdVolatility * harga, terlalu volatil
  if (atrValue / lastClose > thresholdVolatility) return true;
  // Cek spread EMA gap terlalu kecil (tren kurang tegas)
  // Anda bisa hitung gap = |EMA50 - EMA200| / EMA200 < threshold
  return false;
}

// Load ML model from serialized file
let rfModel = null;
try {
  const modelJson = JSON.parse(fs.readFileSync(path.join(__dirname, 'rf_model.json')));
  rfModel = RandomForestClassifier.load(modelJson);
} catch (e) {
  console.error('RF model load failed; ML will be disabled:', e);
}

// Load SVM model (optional)
let svmModel = null;
try {
  const svmPath = path.join(__dirname, 'svm_model.json');
  const svmJson = fs.readFileSync(svmPath, 'utf-8');
  const svmModelJson = JSON.parse(svmJson);
  svmModel = new SVM();
  svmModel.fromJSON(svmModelJson);
  console.log('✅ Loaded SVM model from', svmPath);
} catch (err) {
  console.warn('⚠️ SVM model not found or failed to load; falling back to RF only.', err);
}

/**
 * Confirm signal using ML model probability
 * @param {number[]} high
 * @param {number[]} low
 * @param {number[]} close
 * @param {number[]} volume
 * @param {'buy'|'sell'} side
 * @param {number} threshold
 * @returns {boolean}
 */
export function confirmSignalWithML(high, low, close, volume, side, threshold = 0.6) {
  // map 'long'/'short' to 'buy'/'sell' for ML models
  const mlSide = side === 'long' ? 'buy' : side === 'short' ? 'sell' : side;
  try {
    const atrValue = calcATR(high, low, close);
    const ema50 = EMA.calculate({ period: 50, values: close }).at(-1);
    const ema200 = EMA.calculate({ period: 200, values: close }).at(-1);
    const rsi14 = calcRSI(close);
    const features = [
      atrValue,
      ema50 - ema200,
      rsi14,
      volume.at(-1)
    ];
    let probUp = null;
    if (rfModel) {
      const probs = rfModel.predictProbabilities([features])[0];
      probUp = probs[1];
    } else {
      probUp = 0.5;
    }
    if (mlSide === 'buy') {
      return probUp >= threshold;
    } else {
      return (1 - probUp) >= threshold;
    }
  } catch (err) {
    console.error('ML confirmation failed, falling back to technical confirm:', err);
    // fallback to basic technical confirm (trend-based)
    const trend = mlSide === 'buy' ? 'bullish' : 'bearish';
    return confirmSignal(trend, high, low, close, calcATR(high, low, close));
  }
}

/**
 * Ensemble confirmation using Random Forest, SVM, and Neural Net
 * @returns {boolean}
 */
export function ensembleConfirm(high, low, close, volume, side, threshold = 0.6) {
  try {
    // Extract features
    const atrValue = calcATR(high, low, close);
    const ema50 = EMA.calculate({ period: 50, values: close }).at(-1);
    const ema200 = EMA.calculate({ period: 200, values: close }).at(-1);
    const rsi14 = calcRSI(close);
    const feature = [atrValue, ema50 - ema200, rsi14, volume.at(-1)];

    // Predict probabilities
    const pRf = rfModel
      ? rfModel.predictProbabilities([feature])[0][1]
      : 0.5;
    let pSvm = pRf;
    if (svmModel) {
      try {
        pSvm = svmModel.predictProbabilities(Matrix.rowVector([feature]))[0][1];
      } catch (e) {
        console.error('SVM probability failed, using RF only:', e);
        pSvm = pRf;
      }
    }

    // Average probability (RF + SVM)
    const pAvg = svmModel ? (pRf + pSvm) / 2 : pRf;

    // Decision
    if (side === 'buy') {
      return pAvg >= threshold;
    } else {
      return (1 - pAvg) >= threshold;
    }
  } catch (e) {
    console.error('Ensemble confirm failed, falling back to RF confirm:', e);
    // Extract features for fallback
    const atrValue = calcATR(high, low, close);
    const ema50 = EMA.calculate({ period: 50, values: close }).at(-1);
    const ema200 = EMA.calculate({ period: 200, values: close }).at(-1);
    const rsi14 = calcRSI(close);
    const feature = [atrValue, ema50 - ema200, rsi14, volume.at(-1)];
    // Ensure rfModel exists before fallback prediction
    if (rfModel && typeof rfModel.predict === 'function') {
      return rfModel.predict([feature])[0] === 1;
    } else {
      console.warn('No RF model available for fallback ensemble confirm, defaulting to false');
      return false;
    }
  }
}