import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();
const uri = process.env.MONGODB_URI;
if (!uri) throw new Error('⚠️ MONGODB_URI belum di-set di .env!');

export async function connectDB() {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(uri, { useNewUrlParser: true, useUnifiedTopology: true });
    console.log('✅ MongoDB connected');
  }
}
