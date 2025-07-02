// ml/trainModel.js
import * as tf from '@tensorflow/tfjs-node';
import fs from 'fs';
import path from 'path';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

// Emulate __dirname in ES module
const __dirname = dirname(fileURLToPath(import.meta.url));

// Load training data
const dataPath = path.resolve(__dirname, 'data', 'training-data.json');
if (!fs.existsSync(dataPath)) {
  console.error('❌ training-data.json not found at', dataPath);
  process.exit(1);
}
let raw;
try {
  raw = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
} catch (err) {
  console.error('❌ Failed to parse training-data.json:', err.message);
  process.exit(1);
}
if (!Array.isArray(raw) || raw.length === 0) {
  console.error('❌ training-data.json is empty or not an array');
  process.exit(1);
}
const features = raw.map(d => [d.rsi, d.atrPct, d.ret1h]);
const labels   = raw.map(d => d.label);

// Create tensors
const xs = tf.tensor2d(features);
const ys = tf.tensor2d(labels, [labels.length, 1]);

// Build model
const model = tf.sequential();
model.add(tf.layers.dense({ units: 8, activation: 'relu', inputShape: [3] }));
model.add(tf.layers.dense({ units: 4, activation: 'relu' }));
model.add(tf.layers.dense({ units: 1, activation: 'sigmoid' }));

model.compile({ optimizer: 'adam', loss: 'binaryCrossentropy', metrics: ['accuracy'] });

(async () => {
  console.log('🔄 Starting training...');
  await model.fit(xs, ys, { epochs: 50, batchSize: 16, validationSplit: 0.2 });
  const outDir = path.resolve(__dirname, 'model');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  await model.save(`file://${outDir}`);
  console.log('✅ Model trained and saved to', outDir);
})();
