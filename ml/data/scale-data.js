

// ml/data/scale-data.js

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Emulate __dirname in ES module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Paths
const trainPath = path.resolve(__dirname, 'training-data.train.json');
const valPath   = path.resolve(__dirname, 'training-data.val.json');
const statsPath = path.resolve(__dirname, 'scaling-stats.json');
const outTrainPath = path.resolve(__dirname, 'training-data.train.scaled.json');
const outValPath   = path.resolve(__dirname, 'training-data.val.scaled.json');

// Load data
const trainData = JSON.parse(fs.readFileSync(trainPath, 'utf-8'));
const valData   = JSON.parse(fs.readFileSync(valPath, 'utf-8'));

if (!Array.isArray(trainData) || trainData.length === 0) {
  console.error('No training data found to scale.');
  process.exit(1);
}

// Identify numeric feature keys (exclude metadata fields)
const sample = trainData[0];
const featureKeys = Object.keys(sample).filter(key => {
  // Exclude metadata or non-feature fields
  if (['label', 'entryAt', 'exitAt', 'symbol'].includes(key)) return false;
  // Include only numeric fields
  return typeof sample[key] === 'number';
});

if (featureKeys.length === 0) {
  console.error('❌ Tidak ada fitur numeric yang ditemukan pada trainData.');
  process.exit(1);
}

// Compute mean and standard deviation for each feature on train set
const stats = {};
featureKeys.forEach(key => {
  const values = trainData.map(rec => rec[key]).filter(v => typeof v === 'number');
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  const std = Math.sqrt(variance);
  stats[key] = { mean, std: std || 1 };
});

// Save stats
fs.writeFileSync(statsPath, JSON.stringify(stats, null, 2));
console.log(`✅ Saved scaling stats to ${statsPath}`);

// Function to apply z-score normalization
function normalizeRecord(rec) {
  const out = { ...rec };
  featureKeys.forEach(key => {
    const v = rec[key];
    if (typeof v === 'number') {
      out[key] = (v - stats[key].mean) / stats[key].std;
    } else {
      out[key] = rec[key];
    }
  });
  return out;
}

// Normalize train and validation sets
const trainScaled = trainData.map(normalizeRecord);
// Pastikan valData ada dan bukan kosong
if (!Array.isArray(valData)) {
  console.error('❌ valData tidak ditemukan atau bukan array.');
  process.exit(1);
}
const valScaled   = valData.map(normalizeRecord);

// Write scaled data
fs.writeFileSync(outTrainPath, JSON.stringify(trainScaled, null, 2));
fs.writeFileSync(outValPath,   JSON.stringify(valScaled,   null, 2));

console.log(`✅ Wrote scaled training data to ${outTrainPath}`);
console.log(`✅ Wrote scaled validation data to ${outValPath}`);