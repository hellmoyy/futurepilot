async function notifyUser(chatId, message) {
  const token = process.env.BOT_TOKEN;
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML'
      })
    });
    return res.ok;
  } catch (err) {
    console.log(`❌ [${chatId}] Gagal kirim notifikasi Telegram: ${err.message}`);
    return false;
  }
}

import dotenv from 'dotenv';
import ccxt from 'ccxt';
import mongoose from 'mongoose';
import { getApiCredentials, getAllChatIds } from './db.server.js';

dotenv.config();

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
  });
  console.log('✅ MongoDB connected');

  const chatIds = await getAllChatIds();
  if (!chatIds.length) {
    console.log('❌ Tidak ada user terdaftar.');
    return;
  }

  for (const chatId of chatIds) {
    try {
      const creds = await getApiCredentials(chatId);
      let cex = creds.settings?.defaultCex || (creds.bybit?.apiKey ? 'bybit' : (creds.binance?.apiKey ? 'binance' : null));
      if (!cex) {
        console.log(`❌ [${chatId}] Tidak ada API key Binance/Bybit.`);
        continue;
      }
      if (!creds[cex]?.apiKey) {
        console.log(`❌ [${chatId}] API key untuk ${cex} belum diset.`);
        continue;
      }

      const riskPct = creds.settings?.defaultRisk !== undefined ? creds.settings.defaultRisk : 1;
      const leverage = creds.settings?.leverage || 10;

      // Init client
      const client = new ccxt[cex]({
        apiKey: creds[cex].apiKey,
        secret: creds[cex].secret,
        enableRateLimit: true,
        defaultType: 'future',
        ...(cex === 'bybit' ? { options: { defaultSettle: 'USDT' } } : {})
      });

      await client.loadMarkets();
      // Cari symbol USDT futures contract pertama yang ditemukan (quarterly/perpetual)
      const allFuturesMarkets = Object.values(client.markets).filter(m => m.future && m.id.includes('USDT'));
      const symbol = cex === 'binance'
        ? (allFuturesMarkets[0]?.id || 'XRPUSD_250926')
        : (allFuturesMarkets[0]?.symbol || 'XRP/USD');
      // DEBUG: Tampilkan semua futures market yang ditemukan
      console.log(`[${chatId}] Futures markets found:`, Object.values(client.markets).filter(m => m.future).map(m => m.id));
      // Smart base/quote extract untuk symbol apa saja
      let base, quote;
      // allFuturesMarkets sudah dideklarasi sebelum ini
      let futuresMarket = allFuturesMarkets.find(
        m => m.id === symbol || m.symbol === symbol
      );

      if (!futuresMarket) {
        // Fallback: temukan market dengan id/symbol tanpa slash
        futuresMarket = allFuturesMarkets.find(
          m => m.id.replace('/', '') === symbol.replace('/', '')
        );
      }

      if (!futuresMarket) {
        // Fallback: coba cari pakai akhir USDT/USDC/BTC/ETH/BNB/TRY/FDUSD...
        const knownQuotes = ['USDT','USDC','BUSD','BTC','ETH','BNB','TRY','FDUSD'];
        const match = knownQuotes.find(q => symbol.endsWith(q));
        if (match) {
          base = symbol.replace(match, '');
          quote = match;
          futuresMarket = allFuturesMarkets.find(
            m => m.base.toUpperCase() === base.toUpperCase() && m.quote.toUpperCase() === quote.toUpperCase()
          );
        }
      }

      const market = futuresMarket;
      if (!market) {
        console.log(`❌ [${chatId}] Symbol ${symbol} bukan futures atau tidak ditemukan. Market info:`, symbol);
        continue;
      }
      
      // Fetch balance
      let balance = 0;
      try {
        const bal = await client.fetchBalance({ type: 'future' });
        balance = bal.free.USDT;
      } catch (e) {
        console.log(`❌ [${chatId}] Gagal fetch saldo: ${e.message}`);
        continue;
      }
      if (!balance || balance < 1) {
        console.log(`❌ [${chatId}] Saldo futures USDT kosong.`);
        await notifyUser(chatId, `⚠️ Saldo futures kamu kurang untuk order di <b>${symbol}</b>.`);
        continue;
      }
      // Ambil harga terkini
      const ticker = await client.fetchTicker(market.id);
      const price = ticker.last;

      // Perhitungan qty sesuai bot.js
      // margin = balance * riskPct
      // notional = margin * leverage
      // qty = notional / price
      const margin = balance * (riskPct / 100);
      const notional = margin * leverage;
      let qty = notional / price;

      console.log(`[${chatId}] Price: ${price}, Margin: ${margin}, Notional: ${notional}, Qty: ${qty}`);

      // Perbaiki precision dan minQty/minNotional
      let minQty = market.limits.amount?.min || market.precision.amount || 0.001;
      if (cex === 'binance') {
        qty = Math.floor(qty / market.precision.amount) * market.precision.amount;
        if (qty < minQty) qty = minQty;
      } else if (cex === 'bybit') {
        qty = Math.round(qty / (market.precision.amount || 1)) * (market.precision.amount || 1);
        if (qty < minQty) qty = minQty;
      }

      // Set leverage & margin mode
      try {
        if (cex === 'binance') await client.setLeverage(leverage, market.id);
        else await client.setLeverage(leverage, market.id);
        if (cex === 'binance') await client.setMarginMode('cross', market.id);
        else await client.setMarginMode('isolated', market.id);
      } catch (e) {
        // optional
      }

      // Check minimum notional
      const minNotional = market.limits.cost?.min || 5;
      if (qty * price < minNotional) {
        console.log(`⚠️ [${chatId}] Order < minimum ${minNotional} USDT. Qty: ${qty}, Notional: ${qty * price}`);
        continue;
      }

      // Market order LONG
      try {
        console.log(`[${chatId}] createOrder Binance FUTURES: symbol=${symbol}, qty=${qty}, price=${price}, leverage=${leverage}`);
        const order = await client.createOrder(
          market.id,
          'market',
          'buy',
          qty
        );
        console.log(`✅ [${chatId}] Order LONG ${symbol} sukses! Qty: ${qty}, Price: ${price}, OrderID: ${order.id}`);
        await notifyUser(chatId, `✅ Order <b>LONG ${symbol}</b> sukses!\nQty: ${qty}\nPrice: ${price}\nOrderID: ${order.id}`);
      } catch (e) {
        console.log(`❌ [${chatId}] Gagal order: ${e.message}`);
        await notifyUser(chatId, `❌ Gagal order <b>${symbol}</b>:\n${e.message}`);
      }

    } catch (err) {
      console.error(`❌ [${chatId}] Error:`, err.message);
    }
  }

  await mongoose.disconnect();
  console.log('✅ Selesai.');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});