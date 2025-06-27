// db.js
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB connection error:', err));

// Define User schema for storing chat IDs and credentials
const userSchema = new mongoose.Schema({
  chatId: { type: Number, unique: true, required: true },
  binance: {
    apiKey: String,
    secret: String,
  },
  bybit: {
    apiKey: String,
    secret: String,
  },
  useNews:            { type: Boolean, default: false },
  useSentimentFilter: { type: Boolean, default: false },
  useMultiTf:         { type: Boolean, default: false },
  defaultCex:         { type: String,  default: 'bybit' },
  defaultRisk:        { type: Number,  default: 1     },
  defaultTimeframe:   { type: String,  default: '1h' },
  leverage:           { type: Number,  default: 10 },
});

// Prevent model overwrite on reload
const User = mongoose.models.User || mongoose.model('User', userSchema);

/** Save API creds or user settings */
export async function saveApiCredentials(chatId, exchange, creds) {
  const update = {};
  if (exchange === 'settings') {
    // creds is an object of settings flags
    Object.assign(update, creds);
  } else {
    // exchange is 'binance' or 'bybit'
    update[exchange] = creds;
  }
  await User.updateOne(
    { chatId },
    { $set: update },
    { upsert: true }
  );
}

/** Get stored API credentials and chat record */
export async function getApiCredentials(chatId) {
  let user = await User.findOne({ chatId }).lean();
  if (!user) {
    user = await User.create({ chatId });
    user = user.toObject();
  }
  return {
    binance: user.binance || {},
    bybit: user.bybit || {},
    settings: {
      useNews:            user.useNews || false,
      useSentimentFilter: user.useSentimentFilter || false,
      useMultiTf:         user.useMultiTf || false,
      leverage:           user.leverage || 10,
      defaultCex:         user.defaultCex || 'bybit',
      defaultRisk:        user.defaultRisk || 1,
      defaultTimeframe:   user.defaultTimeframe || '1h',
    },
  };
}

/** Add chatId to users collection */
export async function addChatId(chatId) {
  await User.updateOne(
    { chatId },
    { $setOnInsert: { chatId } },
    { upsert: true }
  );
}

/** Get all chat IDs for broadcasting */
export async function getAllChatIds() {
  const users = await User.find({}, 'chatId').lean();
  return users.map(u => u.chatId);
}