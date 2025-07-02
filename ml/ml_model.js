import * as tf from '@tensorflow/tfjs-node';
import path from 'path';
import fs from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

// Emulate __dirname in ES modules
const __dirname = dirname(fileURLToPath(import.meta.url));
let model;

// Build absolute file:// path to the model.json
const MODEL_PATH = `file://${path.resolve(__dirname, 'model', 'model.json')}`;

// Automatically initialize model on module load
(async function init() {
  const filePath = path.resolve(__dirname, 'model', 'model.json');
  try {
    const stats = fs.statSync(filePath);
    if (stats.size < 10) {
      throw new Error('model.json is too small or empty');
    }
    model = await tf.loadLayersModel(`file://${filePath}`);
    console.log('✅ ML model loaded from', filePath);
  } catch (err) {
    console.error('❌ Failed to load ML model:', err.message);
    model = null;
  }
})();

/**
 * Predict whether to close a position.
 * @param {object} features - { rsi, atrPct, ret1h, threshold }
 */
export async function predictClose(features) {
  if (!model) {
    throw new Error('ML model is not loaded yet');
  }
  // Prepare input tensor
  const input = tf.tensor2d([[features.rsi, features.atrPct, features.ret1h]]);
  // Run inference
  const output = model.predict(input);
  const score = (await output.array())[0][0];
  // Determine action based on threshold
  const action = score > features.threshold ? 'close' : 'hold';
  return { action, confidence: score };
}