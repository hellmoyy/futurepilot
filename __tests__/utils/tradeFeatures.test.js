const { computeRsi, computeAtrPct, computeMomentum } = require('../../utils/tradeFeatures');

describe('tradeFeatures', () => {
  test('computeRsi returns a number between 0 and 100', () => {
    const close = [1, 2, 1.5, 1.8, 2.2, 2.1, 2.5, 2.7, 2.6, 2.9, 3.0, 2.8, 3.1, 3.2, 3.0];
    const rsi = computeRsi(close, 14);
    expect(typeof rsi).toBe('number');
    expect(rsi).toBeGreaterThanOrEqual(0);
    expect(rsi).toBeLessThanOrEqual(100);
  });

  test('computeAtrPct returns non-negative number', () => {
    const high = [2, 3, 2.5, 2.8, 3.2];
    const low  = [1.8, 2.8, 2.3, 3.0, 3.4];
    const close= [1.9, 2.9, 2.4, 3.1, 3.3];
    const atrPct = computeAtrPct(high, low, close, 5);
    expect(typeof atrPct).toBe('number');
    expect(atrPct).toBeGreaterThanOrEqual(0);
  });

  test('computeMomentum returns a number', () => {
    const close = [1, 1.1, 1.2, 1.15, 1.3, 1.4];
    const mom = computeMomentum(close, 3);
    expect(typeof mom).toBe('number');
  });
});