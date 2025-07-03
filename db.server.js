import mongoose from 'mongoose';

// User schema & model
const userSchema = new mongoose.Schema({
  chatId:            { type: Number, unique: true, required: true },
  binance:           { apiKey: String, secret: String },
  bybit:             { apiKey: String, secret: String },
  useNews:           { type: Boolean, default: false },
  useSentimentFilter:{ type: Boolean, default: false },
  useMultiTf:        { type: Boolean, default: false },
  defaultCex:        { type: String,  default: 'bybit' },
  defaultRisk:       { type: Number,  default: 1 },
  defaultTimeframe:  { type: String,  default: '1h' },
  leverage:          { type: Number,  default: 10 },
  useMlIntervention: { type: Boolean, default: false },
  mlThreshold:       { type: Number,  default: 0.8 },
  autoTradingEnabled: { type: Boolean, default: false },
  autoTradingPairs:   { type: [String], default: [] }
});
const User = mongoose.models.User || mongoose.model('User', userSchema);

// Subscription schema & model
const subscriptionSchema = new mongoose.Schema({
  chatId:     { type: Number, required: true, unique: true },
  invoiceId:  { type: String, required: true, unique: true },
  transactionId: { type: String, unique: true, sparse: true },
  status:     { type: String, required: true, enum: ['pending','paid','expired'] },
  validUntil: { type: Date },
  paymentUrl: { type: String },
  createdAt:  { type: Date, default: Date.now }
});
const Subscription = mongoose.models.Subscription || mongoose.model('Subscription', subscriptionSchema);

// Trade schema & model+
const tradeSchema = new mongoose.Schema({
  chatId:    { type: Number, required: true },
  entryAt:   { type: Date,   required: true },
  exitAt:    { type: Date },
  symbol:    { type: String, required: true },
  side:      { type: String, required: true, enum: ['buy','sell'] },
  qty:       { type: Number, required: true },
  entryPrice:{ type: Number, required: true },
  exitPrice: { type: Number },
  pnl:       { type: Number },
});
const Trade = mongoose.models.Trade || mongoose.model('Trade', tradeSchema);

// Subscription helper functions
export async function getSubscription(chatId) {
  return Subscription.findOne({ chatId }).lean();
}

export async function getSubscriptionByInvoice(invoiceId) {
  return Subscription.findOne({ invoiceId }).lean();
}

/**
 * Find a subscription by Mayar transactionId (UUID from webhook)
 * @param {string} transactionId
 * @returns {Promise<Subscription|null>}
 */
export async function getSubscriptionByTransaction(transactionId) {
  return Subscription.findOne({ transactionId }).lean();
}

export async function saveSubscription({ chatId, invoiceId, transactionId, status, validUntil, paymentUrl }) {
  console.log('🔧 saveSubscription called with:', { chatId, invoiceId, status, validUntil, paymentUrl });
  return Subscription.findOneAndUpdate(
    { chatId },
    { invoiceId,transactionId, status, validUntil, paymentUrl },
    { upsert: true, new: true }
  );
}

// User credential & settings helper functions
export async function saveApiCredentials(chatId, exchange, creds) {
  const update = (exchange === 'settings') ? { ...creds } : { [exchange]: creds };
  await User.updateOne({ chatId }, { $set: update }, { upsert: true });
}

export async function getApiCredentials(chatId) {
  let user = await User.findOne({ chatId }).lean();
  if (!user) {
    user = (await User.create({ chatId })).toObject();
  }
  return {
    binance: user.binance || {},
    bybit: user.bybit   || {},
    settings: {
      useNews:           user.useNews ?? false,
      useSentimentFilter:user.useSentimentFilter ?? false,
      useMultiTf:        user.useMultiTf ?? false,
      leverage:          user.leverage ?? 10,
      defaultCex:        user.defaultCex ?? 'bybit',
      defaultRisk:       user.defaultRisk ?? 1,
      defaultTimeframe:  user.defaultTimeframe ?? '1h',
      useMlIntervention: user.useMlIntervention ?? false,
      mlThreshold:       user.mlThreshold   ?? 0.8,
      autoTradingEnabled: user.autoTradingEnabled ?? false,
      autoTradingPairs:   user.autoTradingPairs   ?? [],
    }
  };
}

export async function addChatId(chatId) {
  await User.updateOne({ chatId }, { $setOnInsert: { chatId } }, { upsert: true });
}

export async function getAllChatIds() {
  const users = await User.find({}, 'chatId').lean();
  return users.map(u => u.chatId);
}

/**
 * Get paged trade history
 * @param {number} chatId - user chat ID
 * @param {number} page - zero-based page index
 * @param {number} pageSize - number of records per page
 */
export async function getTradeHistoryPaged(chatId, page = 0, pageSize = 10) {
  return Trade.find({ chatId })
    .sort({ entryAt: -1 })
    .skip(page * pageSize)
    .limit(pageSize)
    .lean();
}

/**
 * Get trade history filtered by period
 * @param {number} chatId
 * @param {'day'|'week'|'month'} period
 * @param {number} page
 * @param {number} pageSize
 */
export async function getTradeHistoryByPeriod(chatId, period, page = 0, pageSize = 10) {
  const now = new Date();
  let start;
  if (period === 'day') {
    start = new Date(now.getTime() - 24*60*60*1000);
  } else if (period === 'week') {
    start = new Date(now.getTime() - 7*24*60*60*1000);
  } else if (period === 'month') {
    start = new Date(now.getTime() - 30*24*60*60*1000);
  } else {
    start = new Date(0);
  }
  return Trade.find({
    chatId,
    entryAt: { $gte: start }
  })
    .sort({ entryAt: -1 })
    .skip(page * pageSize)
    .limit(pageSize)
    .lean();
}

/**
 * Fetch all users with autoTradingEnabled setting, returning their chatId and settings.
 * @param {{ autoTradingEnabled?: boolean }} filter
 * @returns {Promise<Array<{ chatId: number, settings: Object }>>}
 */
export async function getApiCredentialsForAllUsers(filter) {
  const query = {};
  if (filter && typeof filter.autoTradingEnabled === 'boolean') {
    query['settings.autoTradingEnabled'] = filter.autoTradingEnabled;
  }
  // Use the User model to query chatId and settings
  const users = await User.find(query).select('chatId settings').lean();
  return users.map(u => ({
    chatId: u.chatId,
    settings: u.settings || {},
  }));
}


export async function getUserByChatId(chatId) {
  return await User.findOne({ chatId }).lean();
}