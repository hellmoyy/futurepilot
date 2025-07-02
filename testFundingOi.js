import 'dotenv/config';
import { fetchFundingRateAny, fetchOpenInterestAny } from './utils/tradeFeatures.js';

async function main() {
  const fakeTrade = { symbol: 'BTC/USDT', entryTimestamp: Date.now() };
  console.log('Funding Rate →', await fetchFundingRateAny(fakeTrade, {}));
  console.log('Open Interest →', await fetchOpenInterestAny(fakeTrade, {}));
}

main().catch(console.error);