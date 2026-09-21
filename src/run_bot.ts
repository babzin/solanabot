import { env } from './config/env.js';
import { prisma } from './services/db.js';
import { initEarlyTrendingCron } from './services/earlyTrending.js';
import { initPriceMilestoneTracker } from './services/priceTracker.js';
import { redis } from './services/redis.js';
import { bot, initTelegramCommands } from './services/telegram.js';

async function startFullBot() {
  console.log('====================================================');
  console.log('🔥 SOLANA EARLY & WHALE TRENDING RADAR (@solearlytrending)');
  console.log('====================================================');

  if (!env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN.includes('dummy')) {
    console.error('❌ Error: TELEGRAM_BOT_TOKEN is missing in .env');
    process.exit(1);
  }

  try {
    // 1. Telegram Connection
    const me = await bot.getMe();
    console.log(`✅ Connected to Telegram as @${me.username} (${me.first_name})`);
    console.log(`📡 Registered Chat ID: ${env.TELEGRAM_CHAT_ID}`);

    // 2. Initialize Early & Whale Radar Cron (2-Min Breakouts, 25-30/Day, @solearlytrending Style)
    initEarlyTrendingCron();

    // 3. Initialize 50% Price Milestone Tracker (+50% Pump & -50% Dip Alerts)
    initPriceMilestoneTracker();

    // 4. Initialize Telegram Commands & Polling
    initTelegramCommands();
    console.log('🟢 Telegram Polling: Online (Listening for /start, /daily, /top, /milestones, /positions, /autosnipe)');

    // Log user interactions
    bot.on('message', (msg) => {
      const from = msg.from?.username ? `@${msg.from.username}` : (msg.from?.first_name || 'User');
      console.log(`📥 [Incoming Message] From: ${from} | Text: "${msg.text || ''}"`);
    });

    bot.on('callback_query', (query) => {
      const from = query.from.username ? `@${query.from.username}` : query.from.first_name;
      console.log(`🔘 [Button Clicked] From: ${from} | Action: "${query.data}"`);
    });

    console.log('----------------------------------------------------');
    console.log('✨ All systems operational. Solana Early Trending Radar ready!\n');

    // Graceful shutdown
    const shutdown = async () => {
      console.log('\n🛑 Shutting down bot gracefully...');
      redis.disconnect();
      await prisma.$disconnect();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (err: any) {
    console.error('❌ Failed to start bot runner:', err.message);
    process.exit(1);
  }
}

startFullBot();
