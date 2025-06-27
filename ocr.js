// ocr.js
import Tesseract from 'tesseract.js';

/**
 * Extract trading pair symbol (e.g. BTC/USDT) from chart image via OCR
 * @param {Buffer} imageBuffer - Buffer of the chart image
 * @returns {Promise<string>} - Detected symbol in uppercase
 * @throws Error if symbol cannot be detected
 */
export async function detectSymbolFromImage(imageBuffer) {
  const { data: { text } } = await Tesseract.recognize(imageBuffer, 'eng', {
    logger: m => console.log('OCR:', m.status)
  });

  // Look for patterns like AAA/BBB (e.g. BTC/USDT, ETH/USDT)
  const match = text.match(/\b([A-Z0-9]{2,6}\/[A-Z0-9]{2,6})\b/i);
  if (!match) {
    throw new Error(`Symbol not detected in OCR text: ${text}`);
  }

  return match[1].toUpperCase();
}
