// utils/tradeFeatures.js

import ccxt from 'ccxt';
import { RSI, ATR } from 'technicalindicators';

// Simple in-memory cache for OHLCV data to avoid redundant fetches
const OHLCV_CACHE_TTL = 60 * 60 * 1000; // 1 hour
const ohlcvCache = new Map(); // key -> { timestamp, data }
async function fetchOhlcvWithCache(client, symbol, timeframe, since, limit = undefined) {
  const key = `${symbol}|${timeframe}|${since}|${limit}`;
  const now = Date.now();
  if (ohlcvCache.has(key)) {
    const { timestamp, data } = ohlcvCache.get(key);
    if (now - timestamp < OHLCV_CACHE_TTL) {
      return data;
    }
    ohlcvCache.delete(key);
  }
  const data = await client.fetchOHLCV(symbol, timeframe, since, limit);
  ohlcvCache.set(key, { timestamp: now, data });
  return data;
}

// Normalization utilities
export function normalizeArray(arr) {
  const vals = arr.filter(v => v != null);
  if (vals.length === 0) return arr;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  return arr.map(v => (v == null ? null : (v - min) / (max - min)));
}
export function zScore(arr) {
  const vals = arr.filter(v => v != null);
  if (vals.length === 0) return arr;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const std = Math.sqrt(vals.reduce((sum, v) => sum + (v - mean) ** 2, 0) / vals.length);
  return arr.map(v => (v == null ? null : std ? (v - mean) / std : 0));
}

// Cache CCXT clients per exchange
const clients = {};
async function getClient(exchangeId, apiKey, secret) {
  const key = `${exchangeId}`;
  if (clients[key]) return clients[key];
  try {
    const client = new ccxt[exchangeId]({
      apiKey,
      secret,
      enableRateLimit: true,
      defaultType: 'future',
    });
    clients[key] = client;
    return client;
  } catch (e) {
    console.error(`getClient error for ${exchangeId}:`, e.message);
    throw e;
  }
}


/**
 * Hitung RSI 14 period pada saat entry.
 * @param {object} trade  posisi trade (harus ada trade.symbol, trade.entryTimestamp)
 * @param {object} creds  kredensial user (creds.settings.defaultCex, creds.bybit/apiKey, secret)
 * @param {object} [options] - options object, may contain period
 * @param {number} [options.period=creds.settings.rsiPeriod || 14] - RSI period
 * @returns {Promise<number>} RSI value
 */
export async function computeRsi(trade, creds, { period = creds?.settings?.rsiPeriod ?? 14 } = {}) {
  try {
    const client = await getClient(
      creds.settings.defaultCex,
      creds[creds.settings.defaultCex].apiKey,
      creds[creds.settings.defaultCex].secret
    );
    const timeframe = creds.settings.ohlcvTimeframe || '1h';
    const since = trade.entryTimestamp - (period + 1) * 60 * 60 * 1000;
    const ohlc = await fetchOhlcvWithCache(client, trade.symbol, timeframe, since, period + 1);
    const closes = ohlc.map(c => c[4]);
    const rsiArr = RSI.calculate({ period, values: closes });
    const rsiValue = rsiArr.length ? rsiArr[rsiArr.length - 1] : 50;
    return Number(rsiValue) || 0;
  } catch (e) {
    console.error('computeRsi error:', e.message);
    return 50;
  }
}

/**
 * Hitung ATR dibagi entry price (ATR%).
 * @param {object} trade
 * @param {object} creds
 * @param {object} [options] - options object, may contain period
 * @param {number} [options.period=creds.settings.atrPeriod || 14] - ATR period
 * @returns {Promise<number>} ATR percentage
 */
export async function computeAtrPct(trade, creds, { period = creds?.settings?.atrPeriod ?? 14 } = {}) {
  try {
    const client = await getClient(
      creds.settings.defaultCex,
      creds[creds.settings.defaultCex].apiKey,
      creds[creds.settings.defaultCex].secret
    );
    const timeframe = creds.settings.ohlcvTimeframe || '1h';
    const since = trade.entryTimestamp - (period + 1) * 60 * 60 * 1000;
    const ohlc = await fetchOhlcvWithCache(client, trade.symbol, timeframe, since, period + 1);
    const high = ohlc.map(c => c[2]);
    const low  = ohlc.map(c => c[3]);
    const close= ohlc.map(c => c[4]);
    const atrArr = ATR.calculate({ period, high, low, close });
    const atr = atrArr.length ? atrArr[atrArr.length - 1] : 0;
    const atrPctValue = trade.entryPrice ? atr / trade.entryPrice : 0;
    return Number(atrPctValue) || 0;
  } catch (e) {
    console.error('computeAtrPct error:', e.message);
    return 0;
  }
}

/**
 * Hitung return 1 jam setelah entry (%).
 * @param {object} trade
 * @param {object} creds
 * @returns {Promise<number>} Return percentage after 1 hour
 */
export async function computeReturn1h(trade, creds) {
  try {
    const client = await getClient(
      creds.settings.defaultCex,
      creds[creds.settings.defaultCex].apiKey,
      creds[creds.settings.defaultCex].secret
    );
    const timeframe = creds.settings.ohlcvTimeframe || '1h';
    const ohlc = await fetchOhlcvWithCache(client, trade.symbol, timeframe, trade.entryTimestamp, 2);
    if (ohlc.length < 2) return 0;
    const entryClose = ohlc[0][4];
    const nextClose  = ohlc[1][4];
    const returnValue = entryClose ? (nextClose - entryClose) / entryClose : 0;
    return Number(returnValue) || 0;
  } catch (e) {
    console.error('computeReturn1h error:', e.message);
    return 0;
  }
}

/**
 * Hitung momentum harga pada saat entry trade.
 * @param {object} trade - trade object (harus ada trade.symbol, trade.entryTimestamp)
 * @param {object} creds - user credentials
 * @param {number} period - periode (default 10)
 * @returns {Promise<number>} - nilai momentum (close_now - close_[t-period])
 */
export async function computeMomentumFeature(trade, creds, period = 10) {
  try {
    const client = await getClient(
      creds.settings.defaultCex,
      creds[creds.settings.defaultCex].apiKey,
      creds[creds.settings.defaultCex].secret
    );
    const timeframe = creds.settings.ohlcvTimeframe || '1h';
    const since = trade.entryTimestamp - (period + 1) * 60 * 60 * 1000;
    const ohlc = await fetchOhlcvWithCache(client, trade.symbol, timeframe, since, period + 1);
    const closes = ohlc.map(c => c[4]);
    if (closes.length <= period) return 0;
    const momentum = closes[closes.length - 1] - closes[closes.length - 1 - period];
    return Number(momentum) || 0;
  } catch (e) {
    console.error('computeMomentumFeature error:', e.message);
    return 0;
  }
}

/**
 * Volatility Spike Feature: rasio ATR short/ATR long saat entry trade.
 * @param {object} trade - trade object
 * @param {object} creds
 * @param {number} shortPeriod - short ATR period (default 14)
 * @param {number} longPeriod - long ATR period (default 50)
 * @returns {Promise<number>} - rasio ATR short / ATR long
 */
export async function computeVolatilitySpikeFeature(trade, creds, shortPeriod = 14, longPeriod = 50) {
  try {
    const client = await getClient(
      creds.settings.defaultCex,
      creds[creds.settings.defaultCex].apiKey,
      creds[creds.settings.defaultCex].secret
    );
    const timeframe = creds.settings.ohlcvTimeframe || '1h';
    const since = trade.entryTimestamp - (longPeriod + 1) * 60 * 60 * 1000;
    const ohlc = await fetchOhlcvWithCache(client, trade.symbol, timeframe, since, longPeriod + 1);
    const high = ohlc.map(c => c[2]);
    const low  = ohlc.map(c => c[3]);
    const close= ohlc.map(c => c[4]);
    const atrShortArr = ATR.calculate({ period: shortPeriod, high, low, close });
    const atrLongArr  = ATR.calculate({ period: longPeriod, high, low, close });
    const atrShort = atrShortArr.length ? atrShortArr[atrShortArr.length - 1] : 0;
    const atrLong  = atrLongArr.length ? atrLongArr[atrLongArr.length - 1] : 0;
    const ratio = atrLong ? atrShort / atrLong : 0;
    return Number(ratio) || 0;
  } catch (e) {
    console.error('computeVolatilitySpikeFeature error:', e.message);
    return 0;
  }
}

// Contoh pemakaian (async):
// const mom = await computeMomentumFeature(trade, creds, 10);
// const volSpike = await computeVolatilitySpikeFeature(trade, creds, 14, 50);


/**
 * Order Book Imbalance: (sumBidVol - sumAskVol) / (sumBidVol + sumAskVol)
 * @param {Array} bids - array of [price, volume]
 * @param {Array} asks - array of [price, volume]
 * @returns {number}
 */
export function computeOrderBookImbalance(bids, asks) {
  const sumBid = bids.reduce((sum, lvl) => sum + lvl[1], 0);
  const sumAsk = asks.reduce((sum, lvl) => sum + lvl[1], 0);
  const denom = sumBid + sumAsk;
  const imbalance = denom === 0 ? 0 : (sumBid - sumAsk) / denom;
  return Number(imbalance) || 0;
}

/**
 * Volatility Spike: ratio of ATR(short) / ATR(long)
 * @param {object} trade
 * @param {object} creds
 * @param {number} [shortPeriod=14]
 * @param {number} [longPeriod=50]
 * @returns {Promise<number>}
 */
export async function computeVolatilitySpike(trade, creds, shortPeriod = 14, longPeriod = 50) {
  try {
    // reuse computeAtrPct for two periods
    const shortPct = await computeAtrPct(trade, creds, { period: shortPeriod });
    const longPct  = await computeAtrPct(trade, creds, { period: longPeriod });
    const ratio = longPct ? shortPct / longPct : 0;
    return Number(ratio) || 0;
  } catch (e) {
    console.error('computeVolatilitySpike error:', e.message);
    return 0;
  }
}

/**
 * Compute returns over n bars ahead as percentage.
 * @param {number[]} closes
 * @param {number} period - number of bars ahead (default 1)
 * @returns {number[]} - array of return percentages, null for last `period` entries
 */
export function computeReturns(closes, period = 1) {
  const ret = Array(closes.length).fill(null);
  for (let i = 0; i + period < closes.length; i++) {
    ret[i] = ((closes[i + period] - closes[i]) / closes[i]) * 100;
  }
  return ret;
}

/**
 * Compute momentum over n bars: close[t] - close[t-period]
 * @param {number[]} closes
 * @param {number} period - default 10
 * @returns {number[]} - array of momentum values, null for first `period` entries
 */
export function computeMomentum(closes, period = 10) {
  const mom = Array(closes.length).fill(null);
  for (let i = period; i < closes.length; i++) {
    mom[i] = closes[i] - closes[i - period];
  }
  return mom;
}

/**
 * Compute average news sentiment score.
 * @param {number[]} scores - array of sentiment scores per news item
 * @returns {number} - average score, or 0 if none
 */
export function computeNewsSentimentScore(scores) {
  if (!Array.isArray(scores) || scores.length === 0) return 0;
  const sum = scores.reduce((total, s) => total + s, 0);
  return sum / scores.length;
}

/**
 * Simple Moving Average (SMA)
 * @param {number[]} closes - array of close prices
 * @param {number} period - period for SMA (default 20)
 * @returns {Array<number|null>} SMA values, null for first period-1 entries
 */
export function computeSma(closes, period = 20) {
  const sma = Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1);
    sma[i] = slice.reduce((a, b) => a + b, 0) / period;
  }
  return sma;
}

/**
 * Exponential Moving Average (EMA)
 * @param {number[]} closes - array of close prices
 * @param {number} period - period for EMA (default 20)
 * @returns {Array<number|null>} EMA values, null for first period-1 entries
 */
export function computeEma(closes, period = 20) {
  const ema = Array(closes.length).fill(null);
  const k = 2 / (period + 1);
  let prev;
  for (let i = 0; i < closes.length; i++) {
    if (i === period - 1) {
      const sum = closes.slice(0, period).reduce((a, b) => a + b, 0);
      prev = sum / period;
      ema[i] = prev;
    } else if (i >= period) {
      prev = closes[i] * k + prev * (1 - k);
      ema[i] = prev;
    }
  }
  return ema;
}

/**
 * Bollinger Bands (upper, middle, lower)
 * @param {number[]} closes - array of close prices
 * @param {number} period - period for Bollinger Bands (default 20)
 * @param {number} stdDevMult - standard deviation multiplier (default 2)
 * @returns {Array<{upper: number|null, middle: number|null, lower: number|null}>}
 */
export function computeBollingerBands(closes, period = 20, stdDevMult = 2) {
  const bands = closes.map(() => ({ upper: null, middle: null, lower: null }));
  for (let i = period - 1; i < closes.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((sum, v) => sum + (v - mean) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    bands[i] = {
      middle: mean,
      upper: mean + stdDevMult * sd,
      lower: mean - stdDevMult * sd,
    };
  }
  return bands;
}

/**
 * On-Balance Volume (OBV)
 * @param {number[]} closes - array of close prices
 * @param {number[]} volumes - array of volumes
 * @returns {Array<number|null>} OBV values, null for first entry
 */
export function computeObv(closes, volumes) {
  const obv = Array(closes.length).fill(null);
  let prev = 0;
  for (let i = 1; i < closes.length; i++) {
    prev += closes[i] > closes[i - 1] ? volumes[i] : closes[i] < closes[i - 1] ? -volumes[i] : 0;
    obv[i] = prev;
  }
  return obv;
}

/**
 * Volume-Weighted Average Price (VWAP)
 * @param {number[]} highs - array of high prices
 * @param {number[]} lows - array of low prices
 * @param {number[]} closes - array of close prices
 * @param {number[]} volumes - array of volumes
 * @returns {Array<number|null>} VWAP values
 */
export function computeVwap(highs, lows, closes, volumes) {
  const vwap = Array(closes.length).fill(null);
  for (let i = 0; i < closes.length; i++) {
    const tp = (highs[i] + lows[i] + closes[i]) / 3;
    vwap[i] = volumes[i] * tp;
  }
  // convert cumulative to VWAP
  let cumTpVol = 0;
  let cumVol = 0;
  for (let i = 0; i < vwap.length; i++) {
    cumTpVol += vwap[i] || 0;
    cumVol += volumes[i] || 0;
    vwap[i] = cumVol ? cumTpVol / cumVol : null;
  }
  return vwap;
}

/**
 * Compute Pearson correlation coefficient between two arrays.
 * @param {number[]} x
 * @param {number[]} y
 * @returns {number} correlation in [-1,1] or 0 if invalid
 */
export function computeCorrelation(x, y) {
  const n = Math.min(x.length, y.length);
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0, count = 0;
  for (let i = 0; i < n; i++) {
    const xi = x[i], yi = y[i];
    if (xi == null || yi == null) continue;
    sumX += xi; sumY += yi;
    sumXY += xi * yi;
    sumX2 += xi * xi;
    sumY2 += yi * yi;
    count++;
  }
  if (count === 0) return 0;
  const numerator = sumXY - (sumX * sumY) / count;
  const denom = Math.sqrt((sumX2 - (sumX**2)/count) * (sumY2 - (sumY**2)/count));
  return denom ? numerator / denom : 0;
}

/**
 * Compute time-decayed average sentiment.
 * @param {number[]} scores
 * @param {number[]} timestamps - matching UNIX ms timestamps
 * @param {number} halfLifeMs - half-life in ms for decay (default 1h)
 * @returns {number} weighted sentiment
 */
export function computeSentimentDecay(scores, timestamps, halfLifeMs = 3600000) {
  const now = Date.now();
  let weightedSum = 0, weightSum = 0;
  for (let i = 0; i < scores.length; i++) {
    const score = scores[i], ts = timestamps[i];
    if (score == null || ts == null) continue;
    const age = now - ts;
    const weight = Math.exp(-Math.LN2 * age / halfLifeMs);
    weightedSum += score * weight;
    weightSum += weight;
  }
  return weightSum ? weightedSum / weightSum : 0;
}

/**
 * Fetch funding rate from Binance for a given trade.
 * Uses Binance futures API via ccxt.
 * @param {object} trade - trade object with symbol property
 * @param {object} creds - user credentials (not used here)
 * @returns {Promise<number>} funding rate or 0 if error
 */
export async function fetchFundingRate(trade, creds) {
  try {
    const client = await getClient(
      'binance',
      process.env.BINANCE_API_KEY,
      process.env.BINANCE_SECRET
    );
    // Binance uses symbols like BTCUSDT for futures, map if needed
    let symbol = trade.symbol.replace('/', '');
    // Ensure symbol ends with USDT for Binance futures if needed
    if (!symbol.endsWith('USDT') && !symbol.endsWith('BUSD')) {
      symbol = symbol + 'USDT';
    }
    // Fetch funding rate
    const fundingRates = await client.fapiPublicGetFundingRate({ symbol, limit: 1 });
    if (fundingRates && fundingRates.length > 0) {
      const rate = parseFloat(fundingRates[0].fundingRate) || 0;
      return Number(rate) || 0;
    }
    return 0;
  } catch (e) {
    console.error('fetchFundingRate error:', e.message);
    return 0;
  }
}

/**
 * Fetch open interest from Binance for a given trade.
 * Uses Binance futures API via ccxt.
 * @param {object} trade - trade object with symbol property
 * @param {object} creds - user credentials (not used here)
 * @returns {Promise<number>} open interest or 0 if error
 */
export async function fetchOpenInterest(trade, creds) {
  try {
    const client = await getClient(
      'binance',
      process.env.BINANCE_API_KEY,
      process.env.BINANCE_SECRET
    );
    let symbol = trade.symbol.replace('/', '');
    if (!symbol.endsWith('USDT') && !symbol.endsWith('BUSD')) {
      symbol = symbol + 'USDT';
    }
    const oiData = await client.fapiPublicGetOpenInterest({ symbol });
    if (oiData && oiData.openInterest) {
      const rate = parseFloat(oiData.openInterest) || 0;
      return Number(rate) || 0;
    }
    return 0;
  } catch (e) {
    console.error('fetchOpenInterest error:', e.message);
    return 0;
  }
}



/**
 * Fetch funding rate from Bybit for a given trade.
 */
export async function fetchFundingRateBybit(trade, creds) {
  try {
    const client = await getClient(
      'bybit',
      process.env.BYBIT_API_KEY || creds?.bybit?.apiKey,
      process.env.BYBIT_SECRET || creds?.bybit?.secret
    );
    let symbol = trade.symbol.replace('/', '');
    if (!symbol.endsWith('USDT')) symbol += 'USDT';
    // Cek endpoint funding rate yang tersedia di ccxt bybit
    if (client.fapiPublicGetFundingRate) {
      const res = await client.fapiPublicGetFundingRate({ symbol, limit: 1 });
      if (Array.isArray(res) && res.length > 0 && res[0].fundingRate) {
        const rate = parseFloat(res[0].fundingRate) || 0;
        return Number(rate) || 0;
      }
    } else if (client.publicGetV2PublicFundingPrevFundRate) {
      const res = await client.publicGetV2PublicFundingPrevFundRate({ symbol });
      if (res?.result?.length > 0 && res.result[0].last_funding_rate) {
        const rate = parseFloat(res.result[0].last_funding_rate) || 0;
        return Number(rate) || 0;
      }
    }
    return 0;
  } catch (e) {
    console.error('fetchFundingRateBybit error:', e.message);
    return 0;
  }
}

/**
 * Fetch open interest from Bybit for a given trade.
 */
export async function fetchOpenInterestBybit(trade, creds) {
  try {
    const client = await getClient(
      'bybit',
      process.env.BYBIT_API_KEY || creds?.bybit?.apiKey,
      process.env.BYBIT_SECRET || creds?.bybit?.secret
    );
    let symbol = trade.symbol.replace('/', '');
    if (!symbol.endsWith('USDT')) symbol += 'USDT';
    // Cek endpoint open interest yang tersedia di ccxt bybit
    if (client.fapiPublicGetOpenInterest) {
      const res = await client.fapiPublicGetOpenInterest({ symbol });
      if (res?.openInterest) {
        const rate = parseFloat(res.openInterest) || 0;
        return Number(rate) || 0;
      }
      if (res?.result?.openInterest) {
        const rate = parseFloat(res.result.openInterest) || 0;
        return Number(rate) || 0;
      }
    } else if (client.publicGetV2PublicOpenInterest) {
      const res = await client.publicGetV2PublicOpenInterest({ symbol });
      if (res?.result?.length > 0 && res.result[0].open_interest) {
        const rate = parseFloat(res.result[0].open_interest) || 0;
        return Number(rate) || 0;
      }
    }
    return 0;
  } catch (e) {
    console.error('fetchOpenInterestBybit error:', e.message);
    return 0;
  }
}

/**
 * Universal fetcher: Binance → fallback ke Bybit jika gagal
 */
export async function fetchFundingRateAny(trade, creds) {
  let rate = await fetchFundingRate(trade, creds);
  if (!rate) rate = await fetchFundingRateBybit(trade, creds);
  return Number(rate) || 0;
}

export async function fetchOpenInterestAny(trade, creds) {
  let oi = await fetchOpenInterest(trade, creds);
  if (!oi) oi = await fetchOpenInterestBybit(trade, creds);
  return Number(oi) || 0;
}