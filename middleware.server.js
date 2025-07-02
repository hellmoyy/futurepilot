import { getSubscription } from './db.server.js';

/**
 * Middleware to ensure only Pro subscribers can proceed.
 * @param {number} chatId
 * @param {object} bot - TelegramBot instance
 * @param {function} next - callback to invoke if access granted
 */
export async function ensurePro(chatId, bot, next) {
  const sub = await getSubscription(chatId);
  const now = new Date();
  // If no subscription or not paid or expired
  if (!sub || sub.status !== 'paid' || (sub.validUntil && new Date(sub.validUntil) < now)) {
    await bot.sendMessage(chatId,
      `⚠️ Akses terbatas untuk subscriber Pro.\n` +
      `Ketik /subscribe untuk berlangganan Pro seharga Rp 298.000/bulan.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }
  // Subscription is active; proceed with original handler
  return next();
}
