// db.js
import { LowSync, JSONFileSync } from 'lowdb'

// Adapter ke file db.json
const adapter = new JSONFileSync('db.json')
const db = new LowSync(adapter)

// Inisialisasi data kalau belum ada
db.read()
db.data ||= { users: [] }

/**
 * Simpan kredensial exchange (bybit/binance) untuk chatId tertentu
 * @param {number} chatId
 * @param {'binance'|'bybit'} ex
 * @param {{ apiKey: string, secret: string }} creds
 */
export function saveApiCredentials(chatId, ex, creds) {
  db.read()
  let user = db.data.users.find(u => u.chatId === chatId)
  if (!user) {
    user = { chatId, binance: null, bybit: null }
    db.data.users.push(user)
  }
  user[ex] = creds
  db.write()
}

/**
 * Ambil semua kredensial untuk chatId, kembalikan object { binance, bybit }
 * @param {number} chatId
 */
export function getApiCredentials(chatId) {
  db.read()
  return db.data.users.find(u => u.chatId === chatId) || {}
}