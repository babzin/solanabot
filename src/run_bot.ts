import { bot, initTelegramCommands } from './services/telegram.js';
import { env } from './config/env.js';

async function startBot() {
  console.log('====================================================');
  console.log('🤖 SOLANA COPY TRADING BOT - TELEGRAM RUNNER');
  console.log('====================================================');

  if (!env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN.includes('dummy')) {
    console.error('❌ Error: TELEGRAM_BOT_TOKEN is missing or dummy in .env');
    console.error('Please configure your token from @BotFather in your .env file.');
    process.exit(1);
  }

  try {
    const me = await bot.getMe();
    console.log(`✅ Connected to Telegram as @${me.username} (${me.first_name})`);
    console.log(`📡 Registered Chat ID: ${env.TELEGRAM_CHAT_ID}`);
    console.log('🟢 Polling mode active: Bot is listening for incoming messages...');
    console.log('\n💡 Try sending any of these commands on Telegram:');
    console.log('   /start     - Welcome message and interactive menu');
    console.log('   /filter    - 1-on-1 Signal filter (Safe, Risk, Show All)');
    console.log('   /wallets   - View All 30 Tracked Smart Wallets with names');
    console.log('   /top       - Highest win-rate trader and stats today');
    console.log('   /daily     - Total money made and PnL breakdown');
    console.log('   /snipe 0.05- Configure auto-snipe trade size');
    console.log('   /autosnipe - Toggle auto-sniping on/off');
    console.log('   /status    - View current sniper and filter settings');
    console.log('----------------------------------------------------\n');

    // Initialize command handlers and start polling
    initTelegramCommands();

    // Log incoming messages for visibility in terminal
    bot.on('message', (msg) => {
      const from = msg.from?.username ? `@${msg.from.username}` : (msg.from?.first_name || 'User');
      console.log(`📥 [Incoming Message] From: ${from} | Text: "${msg.text || ''}"`);
    });

    bot.on('callback_query', (query) => {
      const from = query.from.username ? `@${query.from.username}` : query.from.first_name;
      console.log(`🔘 [Button Clicked] From: ${from} | Action: "${query.data}"`);
    });

  } catch (err: any) {
    console.error('❌ Failed to connect to Telegram:', err.message);
    process.exit(1);
  }
}

startBot();
