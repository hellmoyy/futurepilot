// ml/data/train-model.js

import fs from 'fs';
import path from 'path';
import { RandomForestClassifier } from 'ml-random-forest';
import { performance } from 'perf_hooks';
import { fileURLToPath } from 'url';
// emulate __dirname in ES module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Generate K-fold train/test indices for cross-validation.
 * @param {number} n - total number of samples
 * @param {number} k - number of folds
 * @returns {Array<{trainIndex: number[], testIndex: number[]}>}
 */
function getKFolds(n, k) {
  const indices = Array.from({ length: n }, (_, i) => i);
  const foldSize = Math.floor(n / k);
  const folds = [];
  for (let i = 0; i < k; i++) {
    const testStart = i * foldSize;
    const testEnd = (i === k - 1) ? n : testStart + foldSize;
    const testIndex = indices.slice(testStart, testEnd);
    const trainIndex = [
      ...indices.slice(0, testStart),
      ...indices.slice(testEnd)
    ];
    folds.push({ trainIndex, testIndex });
  }
  return folds;
}

// Paths
const trainPath = path.resolve(__dirname, 'training-data.train.scaled.json');
const valPath   = path.resolve(__dirname, 'training-data.val.scaled.json');
const modelOut  = path.resolve(__dirname, 'best-model.json');

async function main() {
  // Load scaled training data
  const trainData = JSON.parse(fs.readFileSync(trainPath, 'utf-8'));
  if (!Array.isArray(trainData) || trainData.length === 0) {
    console.error('No training data available.');
    process.exit(1);
  }

  // Automatically pick numeric-only feature columns
  let featureKeys = Object.keys(trainData[0]).filter(k => k !== 'label' && k !== 'entryAt');
  featureKeys = featureKeys.filter(key =>
    trainData.every(r => typeof r[key] === 'number' && !isNaN(r[key]))
  );
  const nFeatures = featureKeys.length;
  // Log feature info and guard against empty feature set
  console.log(`Detected ${nFeatures} numeric feature(s): [${featureKeys.join(', ')}]`);
  if (nFeatures === 0) {
    console.error('❌ No feature columns found. Aborting training. Please ensure export-training-data includes feature fields.');
    process.exit(1);
  }
  const X = trainData.map(r => featureKeys.map(k => r[k]));
  const y = trainData.map(r => r.label);

  // VALIDASI & FILTER DATA
  const sanitized = [];
  for (let i = 0; i < X.length; i++) {
    const row = X[i];
    if (row.every(v => typeof v === 'number' && !isNaN(v)) && typeof y[i] === 'number' && !isNaN(y[i])) {
      sanitized.push({ x: row, y: y[i] });
    } else {
      console.warn(`⚠️ Drop row ${i} (ada nilai bukan number/NaN):`, row, y[i]);
    }
  }
  if (sanitized.length === 0) {
    console.error('❌ Semua data training tidak valid. Cek input!');
    process.exit(1);
  }
  const Xclean = sanitized.map(r => r.x);
  const yclean = sanitized.map(r => r.y);
  console.log(`Training dengan ${Xclean.length} records (setelah filtering)...`);

  // Train with hyperparameters (maxFeatures based on sqrt rule)
  const maxFeaturesCount = Math.max(1, Math.floor(Math.sqrt(nFeatures)));
  console.log(`→ Using maxFeatures per tree: ${maxFeaturesCount}`);
  const rf = new RandomForestClassifier({
    nEstimators: 100,
    maxFeatures: maxFeaturesCount,
    seed: 42
  });
  rf.train(Xclean, yclean);
  // Save model JSON
  const modelJson = rf.toJSON();
  fs.writeFileSync(modelOut, JSON.stringify({ model: modelJson }, null, 2));
  console.log(`✅ Saved model to ${modelOut}`);
}

main().catch(err => {
  console.error('Error in training:', err);
  process.exit(1);
});