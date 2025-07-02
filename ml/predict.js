import * as tf from '@tensorflow/tfjs-node';
import path from 'path';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

// Emulate __dirname in ES modules
const __dirname = dirname(fileURLToPath(import.meta.url));
const statsPath = path.resolve(__dirname, 'data', 'scaling-stats.json');
const scaler = JSON.parse(fs.readFileSync(statsPath, 'utf-8'));
let model;

// Build absolute file:// path to the model.json
const MODEL_PATH = `file://${path.resolve(__dirname, 'model', 'model.json')}`;

// Automatically initialize model on module load
(async function init() {
  try {
    model = await tf.loadLayersModel(MODEL_PATH);
    console.log('✅ ML model loaded from', MODEL_PATH);
  } catch (err) {
    console.error('❌ Failed to load ML model:', err);
  }
})();

/**
 * Predict whether to close a position.
 * @param {object} features - { rsi, atrPct, ret1h, threshold }
 * @returns {Promise<{action: 'close'|'hold', confidence: number}>}
 */
export async function predictClose(features) {
  if (!model) {
    throw new Error('ML model is not loaded yet');
  }
  // Prepare input tensor with z-score normalization
  const featureOrder = ['rsi','atrPct','ret1h']; // adjust if more features
  const values = featureOrder.map(key => {
    const raw = features[key];
    const { mean, std } = scaler[key] || { mean: 0, std: 1 };
    return std ? (raw - mean) / std : 0;
  });
  const input = tf.tensor2d([values]);
  // Run inference
  const output = model.predict(input);
  const score = (await output.array())[0][0];
  // Determine action based on threshold
  const action = score > features.threshold ? 'close' : 'hold';
  return { action, confidence: score };
}
