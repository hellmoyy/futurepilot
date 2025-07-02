import mongoose from 'mongoose';
const { Schema, model, models } = mongoose;

const UserSchema = new Schema({
  chatId: { type: Number, required: true, unique: true },
  binance: { apiKey: String, secret: String },
  bybit: { apiKey: String, secret: String },
  settings: {
    defaultCex: { type: String, default: 'bybit' },
    defaultRisk: { type: Number, default: 1 },              // 1%
    useNews: { type: Boolean, default: false },             // News off
    useSentimentFilter: { type: Boolean, default: false },  // Sentiment off
    useMultiTf: { type: Boolean, default: false },          // Multi-TF off
    leverage: { type: Number, default: 10 },                 // default 10× leverage
    defaultTimeframe: { type: String, default: '1h' },
    useMlIntervention: { type: Boolean, default: false },
    mlThreshold:       { type: Number,  default: 0.8 }
  }
});

export default models.User || model('User', UserSchema);
