// Suppress WebAssembly streaming compile warnings
console.warn = (msg, ...args) => {
  if (msg && msg.toString().includes('wasm streaming compile failed')) return;
  process.stdout.write(typeof msg === 'string' ? msg + '\n' : msg, ...args);
};
// Disable WebAssembly streaming compile to prevent warning from libsvm-js
if (typeof WebAssembly !== 'undefined') {
  WebAssembly.compileStreaming = undefined;
}
// trainEnsemble.js
import ccxt from 'ccxt';
import fs from 'fs';
import { RandomForestClassifier } from 'ml-random-forest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { SVM } = require('libsvm-js');
const { Matrix } = require('ml-matrix');
import { ATR, EMA, RSI } from 'technicalindicators';
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 1) Ambil fitur X, label y seperti sebelumnya...
//    X: [atr, ema50-ema200, rsi, volume], y: next‐bar direction

// ... kode fetchFeaturesAndLabels() sama seperti sebelumnya ...

async function trainAll() {
  const { X, y } = await fetchFeaturesAndLabels('binance','BTC/USDT','1h');

  // Random Forest
  const rf = new RandomForestClassifier({ nEstimators:100, maxFeatures:2 });
  rf.train(X, y);
  fs.writeFileSync('rf_model.json', JSON.stringify(rf.toJSON()));

  // SVM (linear kernel) using libsvm-js
  // Load the WASM binary directly to avoid streaming compile
  const wasmBuffer = fs.readFileSync(path.join(__dirname, 'node_modules/libsvm-js/out/wasm/libsvm.wasm'));
  const svm = new SVM({
    kernel: SVM.KERNEL_TYPES.LINEAR,
    type: SVM.SVM_TYPES.C_SVC,
    cost: 1.0,
    wasmBinary: wasmBuffer
  });
  svm.train(X, y);
  fs.writeFileSync('svm_model.json', JSON.stringify(svm.toJSON()));

  // Neural Network (perceptron)
  const { Perceptron } = require('ml-perceptron');
  const nn = new Perceptron({ activation: 'sigmoid', hiddenLayers: [5] });
  nn.train(X, y);
  fs.writeFileSync('nn_model.json', JSON.stringify(nn.toJSON()));

  console.log('All models trained.');

  
}



trainAll();