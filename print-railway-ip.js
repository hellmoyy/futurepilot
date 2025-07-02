// print-railway-ip.js
import axios from 'axios';

async function fetchPublicIP() {
  try {
    // Gunakan layanan fetch IP yang aman dan cepat
    const { data } = await axios.get('https://api.ipify.org');
    console.log(`\n🚀 IP Publik Railway-mu: \x1b[32m${data}\x1b[0m`);
    console.log('\n✅ Masukkan IP ini ke Binance API whitelist!');
  } catch (e) {
    console.error('❌ Gagal fetch IP:', e.message);
  }
}

fetchPublicIP();