// app/api/webhook/route.js
import { NextResponse } from 'next/server';
import TelegramBot from 'node-telegram-bot-api';
// Gunakan Node.js runtime untuk mendukung library Node (mongoose, crypto, dll.)
export const runtime = 'nodejs';

import crypto from 'crypto';
import mongoose from 'mongoose';
import { getSubscriptionByTransaction, saveSubscription } from '../../../db.server.js';

const bot = new TelegramBot(process.env.BOT_TOKEN);

export async function POST(request) {
  // DEBUG: log raw body, signature, and parsed payload
  const rawBodyDebug = await request.text();
  console.log('🔔 Incoming webhook raw body:', rawBodyDebug);
  const signatureDebug = request.headers.get('x-mayar-signature');
  console.log('🔔 Incoming webhook signature header:', signatureDebug);
  let payloadDebug;
  try {
    payloadDebug = JSON.parse(rawBodyDebug);
    console.log('🔔 Parsed webhook payload:', JSON.stringify(payloadDebug, null, 2));
  } catch (err) {
    console.error('🔔 Failed to parse webhook JSON:', err);
  }
  // Rewind rawBody for existing logic
  const rawBody = rawBodyDebug;
  // Ensure MongoDB connection
  if (!mongoose.connection.readyState) {
    await mongoose.connect(process.env.MONGODB_URI);
  }
  const isDev = process.env.NODE_ENV === 'development';
  const signature = request.headers.get('x-mayar-signature');
  if (!isDev) {
    if (!signature) {
      console.error('Missing Mayar signature');
      return NextResponse.json({}, { status: 400 });
    }
    const expected = crypto
      .createHmac('sha256', process.env.MAYAR_API_SECRET)
      .update(rawBody)
      .digest('hex');
    if (signature !== expected) {
      console.error('Invalid Mayar signature', signature, expected);
      return NextResponse.json({}, { status: 403 });
    }
  } else {
    console.warn('⚠️ Development mode: skipping Mayar signature verification');
  }
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (e) {
    console.error('Invalid JSON payload', e);
    return NextResponse.json({}, { status: 400 });
  }
  const { event } = payload;
  // Only handle invoice events, payment.received, or payment.reminder for Headless API
  if (event !== 'invoice' && event !== 'payment.received' && event !== 'payment.reminder') {
    console.warn('Unhandled Mayar event:', event);
    return NextResponse.json({}, { status: 200 });
  }
  console.log('🔔 Handling webhook event:', event);

  if (event === 'payment.reminder') {
    // Reminder for pending payment
    const transactionId = payload.data.id;
    console.log('🔔 Payment reminder for transaction:', transactionId);
    // Lookup subscription by transactionId
    const sub = await getSubscriptionByTransaction(transactionId);
    if (sub) {
      await bot.sendMessage(sub.chatId,
        `⚠️ Pengingat: pembayaran kamu belum selesai. Klik link berikut untuk menyelesaikan pembayaran:\n${payload.data.paymentUrl}`
      );
    }
    return NextResponse.json({ ok: true });
  }

  // Webhook payload.data.id = transactionId
  const transactionId = payload.data.id;
  console.log('🔥 Webhook transactionId/status:', transactionId, payload.data.status);
  const sub = await getSubscriptionByTransaction(transactionId);
  if (!sub) {
    console.error(`Subscription not found for transaction ${transactionId}`);
    return NextResponse.json({}, { status: 404 });
  }
  const finalChatId = sub.chatId;
  const invoiceId = sub.invoiceId;

  try {
    let status;
    let paidAt;
    switch (payload.data.status) {
      case 'SUCCESS':
        status = 'paid';
        // Use createdAt if available, otherwise updatedAt, default to now
        paidAt = payload.data.createdAt || payload.data.updatedAt || Date.now();
        break;
      case 'EXPIRED':
        status = 'expired';
        // Use createdAt if available, otherwise updatedAt, default to now
        paidAt = payload.data.createdAt || payload.data.updatedAt || Date.now();
        break;
      case 'FAILED':
        status = 'failed';
        // Use createdAt if available, otherwise updatedAt, default to now
        paidAt = payload.data.createdAt || payload.data.updatedAt || Date.now();
        break;
      default:
        console.warn('Unhandled invoice status:', payload.data.status);
        return NextResponse.json({ ok: true });
    }
    // If paidAt is a timestamp number, convert to Date
    if (typeof paidAt === 'number') {
      paidAt = new Date(paidAt);
    }
    if (status === 'paid') {
      // Use expiredAt from payload if available
      const validUntil = payload.data.expiredAt
        ? new Date(payload.data.expiredAt)
        : (() => {
            const d = new Date(paidAt);
            d.setMonth(d.getMonth() + 1);
            return d;
          })();
      await saveSubscription({ chatId: sub.chatId, invoiceId, transactionId, status: 'paid', validUntil });
      await bot.sendMessage(finalChatId,
        `✅ Langganan *Pro* kamu sudah aktif hingga ${validUntil.toLocaleDateString()}!`,
        { parse_mode: 'Markdown' }
      );
    } else if (['expired', 'cancelled'].includes(status)) {
      await saveSubscription({ chatId: sub.chatId, invoiceId, transactionId, status, validUntil: sub.validUntil });
      await bot.sendMessage(finalChatId,
        `⚠️ Langganan Pro kamu telah berakhir atau dibatalkan.`,
        { parse_mode: 'Markdown' }
      );
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error('Webhook handler error:', e);
    return NextResponse.json({}, { status: 500 });
  }
}