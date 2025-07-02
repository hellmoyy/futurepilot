// test-binance-order.js
import ccxt from 'ccxt';

const apiKey = 'mybBALdqZ6taThJKFsGEnnIxQC6SxBkBYHi72h1pHmzs8Jd9J4IrtqbjtTl2W8cr';
const secret = 'nlsTont9OCLUjpOjpkUJQnu50DXtuE4Wl2Lq1eCbAYGN8Fd0lgh0hS8g95PXuaEk';

const client = new ccxt.binance({
  apiKey,
  secret,
  enableRateLimit: true,
  options: { defaultType: 'future' } // futures
});

async function testOrder() {
  try {
    await client.loadMarkets();
    const symbol = 'BTCUSDT'; // harus tanpa slash
    const market = client.market(symbol);

    // Ambil saldo futures
    const balance = await client.fetchBalance({ type: 'future' });
    console.log('Futures Balance:', balance.free.USDT);

    // Test order, qty minimum (cek market.limits)
    const qty = 0.002; // bisa diganti sesuai saldo dan minQty pair
    const order = await client.createOrder(
      symbol,
      'MARKET',
      'BUY',
      qty
    );
    console.log('Order Result:', order);
  } catch (e) {
    console.error('Order error:', e);
  }
}

testOrder();