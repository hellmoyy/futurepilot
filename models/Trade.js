import mongoose from 'mongoose';

const tradeSchema = new mongoose.Schema({
  symbol: { type: String, required: true },
  entryAt: { type: Date, required: true },
  exitAt: { type: Date },
}, {
  timestamps: true,
});

// Avoid model overwrite upon module reloads
const Trade = mongoose.models.Trade || mongoose.model('Trade', tradeSchema);
export default Trade;
