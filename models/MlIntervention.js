const MlInterventionSchema = new mongoose.Schema({
  chatId:      Number,
  symbol:      String,
  side:        String,
  entryAt:     Date,
  closedAt:    Date,
  confidence:  Number,
  features:    { type: Object }, // { rsi, atrPct, ret1h, … }
  createdAt:   { type: Date, default: Date.now }
});
export default mongoose.model('MlIntervention', MlInterventionSchema);