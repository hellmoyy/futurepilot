// ml/data/split-data.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 1. Baca seluruh data
const dataPath = path.resolve(__dirname, 'training-data.json');
const all = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));

// Optional time-based split using SPLIT_CUTOFF_DATE env (ISO string)
const cutoffStr = process.env.SPLIT_CUTOFF_DATE; // e.g. '2025-05-01T00:00:00Z'
// Enable stratified random split when SPLIT_CUTOFF_DATE is not set
const useStratified = process.env.USE_STRATIFIED_SPLIT === 'true';
let trainSet, valSet;
if (cutoffStr && all.length > 0 && all[0].entryAt) {
  // chronological split: records before cutoff go to train, after to validation
  const cutoff = new Date(cutoffStr).getTime();
  trainSet = all.filter(rec => new Date(rec.entryAt).getTime() < cutoff);
  valSet   = all.filter(rec => new Date(rec.entryAt).getTime() >= cutoff);
} else if (useStratified) {
  // Stratified random split by label
  function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
  }
  const labelGroups = all.reduce((acc, rec) => {
    const key = rec.label ?? 'null';
    (acc[key] = acc[key] || []).push(rec);
    return acc;
  }, {});
  trainSet = [];
  valSet = [];
  const trainRatio = 0.8;
  for (const group of Object.values(labelGroups)) {
    shuffle(group);
    const cut = Math.floor(group.length * trainRatio);
    trainSet.push(...group.slice(0, cut));
    valSet.push(...group.slice(cut));
  }
  // optional: shuffle combined sets
  shuffle(trainSet);
  shuffle(valSet);
} else {
  // default random shuffle split
  function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
  }
  shuffle(all);
  const trainRatio = 0.8;
  const trainSize  = Math.floor(all.length * trainRatio);
  trainSet = all.slice(0, trainSize);
  valSet   = all.slice(trainSize);
}

// 5. Tulis ke file
fs.writeFileSync(
  path.resolve(__dirname, 'training-data.train.json'),
  JSON.stringify(trainSet, null, 2)
);
fs.writeFileSync(
  path.resolve(__dirname, 'training-data.val.json'),
  JSON.stringify(valSet, null, 2)
);

console.log(`Total records: ${all.length}`);
console.log(`Train : ${trainSet.length} records`);
console.log(`Valid : ${valSet.length} records`);