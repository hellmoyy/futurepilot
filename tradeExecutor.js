import ccxt from 'ccxt';

/**
 * Template trade executor: places an order (with optional SL/TP) on Binance/Bybit using ccxt.
 * 
 * @param {Object} opts
 * @param {string} opts.cex - 'binance' or 'bybit'
 * @param {string} opts.symbol - e.g. 'BTC/USDT'
 * @param {string} opts.side - 'long' or 'short'
 * @param {number} opts.riskPercent - percentage of balance to risk
 * @param {number} opts.leverage - leverage to use
 * @param {string|number} opts.chatId - user chat ID (for logging/notif)
 * @param {Object} opts.bot - TelegramBot instance (optional, for notif)
 * @param {string} opts.apiKey - User's API key for the exchange
 * @param {string} opts.apiSecret - User's API secret for the exchange
 * @returns {Promise<Object>} - Result/order info
 */
export async function placeOrderWithSlTp({
  cex = 'binance',
  symbol,
  side,
  riskPercent = 1,
  leverage = 10,
  chatId,
  bot,
  apiKey,
  apiSecret,
}) {
  if (!apiKey || !apiSecret) throw new Error(`API key for ${cex} not set`);

  // Instantiate exchange
  const exchangeClass = ccxt[cex];
  if (!exchangeClass) throw new Error(`Exchange "${cex}" not supported`);
  const exchange = new exchangeClass({
    apiKey,
    secret: apiSecret,
    enableRateLimit: true,
    defaultType: cex === 'binance' ? 'future' : 'swap',
    ...(cex === 'bybit' ? { options: { defaultSettle: 'USDT' } } : {})
  });

  await exchange.loadMarkets();

  const symbolFinal = cex === 'binance' ? symbol.replace('/', '') : symbol;

  // Fetch balance (USDT as margin)
  const balance = await exchange.fetchBalance({ type: 'future' });
  const usdtBal = balance.total.USDT || balance.free.USDT || 0;

  // Calculate order size based on risk and leverage
  const margin = usdtBal * (riskPercent / 100);
  const market = exchange.market(symbolFinal);
  // Fetch ticker for last price
  const ticker = await exchange.fetchTicker(symbolFinal);
  const lastPrice = ticker.last;

  // For long: buy; for short: sell
  const isLong = side === 'long';
  const orderSide = isLong ? 'buy' : 'sell';

  // Position notional
  const notional = margin * leverage;
  let amount = notional / lastPrice;

  // Enforce min/max (check market.precision.amount)
  if (market.precision && market.precision.amount)
    amount = exchange.amountToPrecision(symbolFinal, amount);

  console.log(`[TradeExecutor] ${side.toUpperCase()} ${symbol} | Risk%: ${riskPercent} | Leverage: ${leverage} | Margin: ${margin} | Notional: ${notional} | Qty: ${amount} | Price: ${lastPrice}`);

  // Place order (market order)
  const params = {};
  if (cex === 'binance') {
    params.positionSide = isLong ? 'LONG' : 'SHORT';
    params.reduceOnly = false;
  }

  // --- PLACE ORDER ---
  const order = await exchange.createOrder(symbolFinal, 'market', orderSide, amount, undefined, params);

  // Return result
  return {
    orderId: order.id,
    amount,
    price: order.price || lastPrice,
    symbol,
    side,
    info: order.info,
  };
}