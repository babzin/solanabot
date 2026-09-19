import dotenv from 'dotenv';
dotenv.config();

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID || '8129176485';

async function refreshKeyboard() {
  if (!token) {
    console.error('No TELEGRAM_BOT_TOKEN');
    return;
  }

  const persistentReplyKeyboard = {
    keyboard: [
      [{ text: '🛡️ Safe Only' }, { text: '🚀 Risk Only' }, { text: '🌐 Show All' }],
      [{ text: '👥 Tracked Wallets' }, { text: '🏆 Top Wallets Today' }, { text: '📊 Daily PnL' }],
      [{ text: '🟢 Turn Snipe ON' }, { text: '🔴 Turn Snipe OFF' }],
      [{ text: '🚀 /start' }, { text: '🔍 Bot Status' }, { text: '🎯 Signal Filter' }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };

  const text = `
🎯 <b>Unified Start Button Active!</b>

You now have <b>ONE unified [ 🚀 /start ] button</b> that handles both universal command typing (<code>/start</code> and <code>\\start</code>) and 1-tap inline menus seamlessly.

Tap <b>🚀 /start</b> below to open your main dashboard anytime!
  `.trim();

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: 'HTML',
      reply_markup: persistentReplyKeyboard,
    }),
  });

  const data = await res.json();
  console.log('Telegram API response:', data.ok ? '✅ Success' : data);
}

refreshKeyboard();
