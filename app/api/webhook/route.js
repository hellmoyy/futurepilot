// app/api/webhook/route.js
import { NextResponse } from 'next/server';
import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
dotenv.config();

const bot = new TelegramBot(process.env.BOT_TOKEN);

export async function POST(request) {
  try {
    const body = await request.json();
    console.log('🔥 update masuk:', body);
    if (body.message?.text) {
      await bot.sendMessage(body.message.chat.id, 'Pong! ✅');
    }
  } catch (e) {
    console.error(e);
  }
  return NextResponse.json({ ok: true });
}