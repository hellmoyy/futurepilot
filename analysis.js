// Note: generateDetailedAnalysis(exchangeId, symbol, timeframe, trend, entry, sl, tp, atr, resistance, support, newsItems, newsScore, vwap, rsi, stochastic, chatId)
import ccxt from 'ccxt';
import { ATR, EMA, RSI, Stochastic } from 'technicalindicators';
import { OpenAI } from 'openai';
import { getApiCredentials } from './db.js';

/**
 * Analyze chart data with OHLCV from exchange
 */
export async function analyzeChartData(exchangeId, symbol, timeframe, chatId) {
  console.log(`analyzeChartData called for ${exchangeId}, ${symbol}, ${timeframe}`);
  try {
    // Load per-user settings for feature flags
    const { settings: { useMultiTf } } = await getApiCredentials(chatId);

    const client = new ccxt[exchangeId]();
    const ohlcv = await client.fetchOHLCV(symbol, timeframe, undefined, 200);
    const high = ohlcv.map(c => c[2]);
    const low  = ohlcv.map(c => c[3]);
    const close = ohlcv.map(c => c[4]);
    const ticker = await client.fetchTicker(symbol);

    // Calculate ATR, resistance, and support early
    const atrValue = ATR.calculate({ period: 14, high, low, close }).at(-1);
    const uniqueHighs = Array.from(new Set(high)).sort((a, b) => b - a);
    const uniqueLows = Array.from(new Set(low)).sort((a, b) => a - b);
    const resistance = uniqueHighs.slice(0, 2);
    const support    = uniqueLows.slice(0, 2);

    const ema50  = EMA.calculate({ period: 50, values: close }).at(-1);
    const ema200 = EMA.calculate({ period: 200, values: close }).at(-1);
    const trend = ema50 > ema200 ? 'bullish' : 'bearish';

    // Multi-timeframe trend confirmation
    if (useMultiTf) {
      // Fetch 1h and 4h data
      const tf1h = await client.fetchOHLCV(symbol, '1h', undefined, 200);
      const closes1h = tf1h.map(c => c[4]);
      const ema50_1h  = EMA.calculate({ period: 50, values: closes1h }).at(-1);
      const ema200_1h = EMA.calculate({ period: 200, values: closes1h }).at(-1);
      const trend1h = ema50_1h > ema200_1h ? 'bullish' : 'bearish';

      const tf4h = await client.fetchOHLCV(symbol, '4h', undefined, 200);
      const closes4h = tf4h.map(c => c[4]);
      const ema50_4h  = EMA.calculate({ period: 50, values: closes4h }).at(-1);
      const ema200_4h = EMA.calculate({ period: 200, values: closes4h }).at(-1);
      const trend4h = ema50_4h > ema200_4h ? 'bullish' : 'bearish';

      if (trend !== trend1h || trend !== trend4h) {
        return { trend: 'mixed', entry: ticker.last, sl: null, tp: null, atr: atrValue, resistance, support };
      }
    }

    const entry = ticker.last; 

    // VWAP for intraday trend strength
    const volumes = ohlcv.map(c => c[5]);
    const typicalPrices = ohlcv.map(c => (c[2] + c[3] + c[4]) / 3);
    const vwap = typicalPrices.reduce((sum, p, i) => sum + p * volumes[i], 0)
                / volumes.reduce((sum, v) => sum + v, 0);

    // RSI and Stochastic
    const rsi14 = RSI.calculate({ period: 14, values: close }).at(-1);
    const stochastic = Stochastic.calculate({
      high,
      low,
      close,
      period: 14,
      signalPeriod: 3
    }).at(-1);

    let sl, tp;
    if (trend === 'bullish') {
      sl = entry - 1.5 * atrValue;
      tp = entry + 2.5 * atrValue;
    } else {
      sl = entry + 1.5 * atrValue;
      tp = entry - 2.5 * atrValue;
    }

    return {
      trend,
      entry,
      sl,
      tp,
      atr: atrValue,
      resistance,
      support,
      vwap,
      rsi: rsi14,
      stochastic: stochastic.k // use %K value
    };
  } catch (err) {
    console.error('Error in analyzeChartData:', err);
    throw err;
  }
}

/**
 * Generate concise structured analysis with scenario including real-time data
 */
export async function generateDetailedAnalysis(
  exchangeId,
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
  chatId
) {
  console.log(`generateDetailedAnalysis called for ${symbol} ${timeframe}`);
  try {
    // Guard undefined indicator values
    vwap = typeof vwap === 'number' ? vwap : 0;
    rsi = typeof rsi === 'number' ? rsi : 0;
    stochastic = typeof stochastic === 'number' ? stochastic : 0;

    // Load per-user CEX preference
    const { bybit, binance, settings: { defaultCex } } = await getApiCredentials(chatId);
    const cex = defaultCex || exchangeId;
    const apiCreds = cex === 'binance' ? binance : bybit;

    // Use dynamic CEX client for live price
    const clientX = new ccxt[cex]({
      apiKey: apiCreds.apiKey,
      secret: apiCreds.secret
    });
    const ticker = await clientX.fetchTicker(symbol);
    const current = ticker.last;
    let liveScenario = '';
    if (current >= tp) {
      liveScenario = `✅ TP sudah tercapai pada ${current}`;
    } else if (current <= sl) {
      liveScenario = `⚠️ SL sudah tercapai pada ${current}`;
    } else {
      liveScenario = `⌛ Harga saat ini ${current}, masih di antara SL dan TP`;
    }

    // Estimate time
    const tfMatch = timeframe.match(/(\d+)(m|h|d)/i);
    let tfHours = 1;
    if (tfMatch) {
      const num = Number(tfMatch[1]);
      const unit = tfMatch[2].toLowerCase();
      if (unit === 'm') tfHours = num / 60;
      if (unit === 'h') tfHours = num;
      if (unit === 'd') tfHours = num * 24;
    }
    const candlesNeeded = Math.abs((tp - entry) / atr);
    const estHours = (candlesNeeded * tfHours).toFixed(1);

    // Calculate success probability as a percentage
    let successProbability = 70;
    if (trend === 'bullish' && current > entry) {
      successProbability += 10;
    } else if (trend === 'bearish' && current < entry) {
      successProbability += 10;
    }
    if (successProbability > 95) successProbability = 95;

    // Build response matching desired format
    const lines = [];
    lines.push(`🎯 Analisis ${symbol} (${timeframe})`);
    lines.push('');
    // Sentimen Berita
    if (newsItems && newsItems.length > 0) {
      lines.push('📈 Sentimen Berita:');
      lines.push(`- ${newsScore > 0 ? 'Positif' : newsScore < 0 ? 'Negatif' : 'Netral'} (${newsScore.toFixed(2)})`);
      for (const item of newsItems) {
        lines.push(`  - ${item}`);
      }
    } else {
      lines.push('📈 Sentimen Berita:');
      lines.push('- (no news)');
    }
    lines.push('');
    // Trend & Indicators
    lines.push(`📈 Trend: ${trend}`);
    lines.push(`💹 VWAP: ${vwap.toFixed(2)}`);
    const rsiLabel = rsi < 30 ? 'Oversold' : rsi > 70 ? 'Overbought' : 'Neutral';
    lines.push(`🔄 RSI(14): ${rsi.toFixed(1)} (${rsiLabel})`);
    lines.push(`📊 Stoch %K: ${stochastic.toFixed(1)}`);
    lines.push('');
    // Resistance & Support
    lines.push('🛡️ Resistance & Support:');
    lines.push(`  • R1: ${resistance[0]}`);
    lines.push(`  • R2: ${resistance[1]}`);
    lines.push(`  • S1: ${support[0]}`);
    lines.push(`  • S2: ${support[1]}`);
    lines.push('');
    // Setup Trade
    lines.push('🛠️ Setup Trade:');
    lines.push(`  • Posisi: ${trend === 'bullish' ? 'Buy' : 'Sell'}`);
    lines.push(`  • Entry: ${entry.toFixed(2)}`);
    lines.push(`  • SL: ${sl.toFixed(2)}`);
    lines.push(`  • TP: ${tp.toFixed(2)}`);
    lines.push('');
    // Estimasi Waktu
    lines.push('⏱️ Estimasi Waktu:');
    lines.push(`Sekitar ${estHours} jam`);
    lines.push('');
    // Skenario
    lines.push('🎥 Skenario:');
    lines.push(`  1. Jika TP tercapai (@${tp.toFixed(2)}): pertimbangkan untuk mengambil profit`);
    lines.push(`  2. Jika SL tercapai (@${sl.toFixed(2)}): analisa ulang tren`);
    lines.push('');
    // Live price scenario
    lines.push(`⌛️ Harga saat ini ${current.toFixed(2)}, masih di antara SL dan TP`);
    lines.push('');
    // Peluang Keberhasilan
    lines.push('🔮 Peluang Keberhasilan:');
    lines.push(`${successProbability}% peluang analisa ini berhasil.`);
    return lines.join('\n');
  } catch (err) {
    console.error('Error in generateDetailedAnalysis:', err);
    throw err;
  }
}
