const { RSI, ATR } = require('technicalindicators');

/**
 * Compute RSI using Wilder smoothing.
 * @param {number[]} close
 * @param {number} period
 * @returns {number}
 */
function computeRsi(close, period = 14) {
  const values = close.slice(-period - 1);
  const result = RSI.calculate({ values, period });
  return result.length ? result[result.length - 1] : 50;
}

/**
 * Compute ATR percentage of last close.
 * @param {number[]} high
 * @param {number[]} low
 * @param {number[]} close
 * @param {number} period
 * @returns {number}
 */
function computeAtrPct(high, low, close, period = 14) {
  const input = { high, low, close, period };
  const atrArr = ATR.calculate(input);
  if (!atrArr.length) return 0;
  const atr = atrArr[atrArr.length - 1];
  const lastClose = close[close.length - 1] || 0;
  return lastClose ? atr / lastClose : 0;
}

/**
 * Compute simple momentum: difference between last price and price period bars ago.
 * @param {number[]} close
 * @param {number} period
 * @returns {number}
 */
function computeMomentum(close, period = 1) {
  const len = close.length;
  if (len < 2) return 0;
  const prev = close[Math.max(0, len - period - 1)];
  return close[len - 1] - prev;
}

module.exports = {
  computeRsi,
  computeAtrPct,
  computeMomentum,
};