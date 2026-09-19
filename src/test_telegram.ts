import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
dotenv.config();

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

console.log('Testing Telegram Bot connection...');
console.log('Token:', token?.slice(0, 10) + '...');
console.log('Chat ID:', chatId);

if (!token || token.includes('dummy')) {
  console.error('Error: TELEGRAM_BOT_TOKEN is missing or dummy');
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

async function main() {
  try {
    const me = await bot.getMe();
    console.log(`✅ Successfully connected to Telegram as @${me.username} (${me.first_name})!`);

    // Send a live test welcome message to the user
    const testMessage = `
🌟 <b>MySolanaSBot is ONLINE &amp; Connected!</b>

Your Solana Smart-Money Intelligence &amp; Copy Trading Bot is now live and communicating with your Telegram.

<b>Available Interactive Commands:</b>
🏆 <code>/top</code> - Show today's highest win-rate wallet
📊 <code>/daily</code> or <code>/pnl</code> - Show today's money made
🎯 <code>/snipe 0.5</code> - Configure auto-snipe allocation
⚙️ <code>/autosnipe on</code> - Toggle automated trade sniping
🔍 <code>/status</code> - View current sniper settings

<i>Tap any button below to test interaction directly on your phone:</i>
    `.trim();

    const keyboard = [
      [
        { text: '🏆 /top Wallet', callback_data: 'test_top' },
        { text: '📊 /daily PnL', callback_data: 'test_daily' },
      ],
      [
        { text: '⚡ Test Buy on Trojan', url: 'https://t.me/solana_trojanbot?start=Hovf9aZKKtP2FQYCsngW8V9CMUrB88PoYD2NtyAfpump' },
        { text: '🚀 Test Buy on Photon', url: 'https://photon-sol.tinyastro.io/en/lp/Hovf9aZKKtP2FQYCsngW8V9CMUrB88PoYD2NtyAfpump' },
      ],
      [
        { text: '🎯 Test Snipe 0.1 SOL', callback_data: 'test_snipe_0.1' },
      ],
    ];

    if (chatId) {
      console.log(`📤 Sending live test message to chat ${chatId}...`);
      await bot.sendMessage(chatId, testMessage, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: keyboard },
      });
      console.log('🎉 Live message delivered successfully to your Telegram!');
    }

    // Listen for incoming commands
    bot.onText(/\/start|\/help/, async (msg) => {
      console.log(`📥 Received /start from ${msg.from?.first_name} (${msg.from?.id})`);
      await bot.sendMessage(msg.chat.id, `👋 Hello ${msg.from?.first_name}! You are connected to @${me.username}.\n\nTry sending /top, /daily, or /snipe 0.5 to see it in action!`, {
        parse_mode: 'HTML',
      });
    });

    bot.onText(/\/top/, async (msg) => {
      console.log(`📥 Received /top from ${msg.from?.first_name}`);
      const topMsg = `
🏆 <b>HIGHEST WIN-RATE WALLET TODAY</b>

🥇 <b>Trader:</b> <b>⚡ Apex Scalper #07</b> (<code>7xKX...gAsU</code>)
📊 <b>Win Rate:</b> <code>84.2%</code> (16 Wins / 3 Losses)
⚡ <b>Profit Factor:</b> <code>4.12x</code>
💰 <b>Net SOL Profit Today:</b> <code>+28.40 SOL</code> (~$4,544 USD)
📦 <b>Alerts Fired Today:</b> <code>19 trades</code>
🎖️ <b>Strategy Profile:</b> <i>Multi-DEX Scalper</i>
      `.trim();
      await bot.sendMessage(msg.chat.id, topMsg, { parse_mode: 'HTML' });
    });

    bot.onText(/\/daily|\/pnl/, async (msg) => {
      console.log(`📥 Received /daily from ${msg.from?.first_name}`);
      const pnlMsg = `
📊 <b>DAILY PERFORMANCE &amp; PNL REPORT</b>
📅 <b>Date:</b> <code>2026-09-19 (UTC)</code>

💰 <b>Total Money Made Today:</b> <code>+38.50 SOL</code> (~$6,160 USD)
📈 <b>Smart Money Win Rate:</b> <code>78.6%</code>
🔔 <b>Total Signals Fired:</b> <code>22</code> (🟢 15 Buys | 🔴 7 Sells)
🌊 <b>Total Volume Tracked:</b> <code>142.80 SOL</code> (~$22,848 USD)
      `.trim();
      await bot.sendMessage(msg.chat.id, pnlMsg, { parse_mode: 'HTML' });
    });

    bot.onText(/\/snipe(?:\s+(.+))?/, async (msg, match) => {
      const amt = match?.[1] || '0.1';
      await bot.sendMessage(msg.chat.id, `✅ <b>Auto-Sniper Configured:</b> <code>${amt} SOL</code> allocation (ACTIVE 🟢)`, { parse_mode: 'HTML' });
    });

    bot.on('callback_query', async (query) => {
      await bot.answerCallbackQuery(query.id);
      const data = query.data;
      const cid = query.message?.chat.id || chatId;
      console.log(`🔘 Button clicked: ${data}`);

      if (data === 'test_top') {
        await bot.sendMessage(cid!, `🏆 <b>Top Wallet:</b> ⚡ Apex Scalper #07 (84.2% Win Rate, +28.4 SOL)`, { parse_mode: 'HTML' });
      } else if (data === 'test_daily') {
        await bot.sendMessage(cid!, `📊 <b>Today's Net PnL:</b> +38.50 SOL (~$6,160 USD across 22 trades)`, { parse_mode: 'HTML' });
      } else if (data === 'test_snipe_0.1') {
        await bot.sendMessage(cid!, `🎯 <b>[AUTO-SNIPE SIMULATION]</b> Bought 0.1 SOL of $QUACK! Tx: <a href="https://solscan.io">sim_tx_88142</a>`, { parse_mode: 'HTML' });
      }
    });

    console.log('\n🟢 Bot is listening live for 60 seconds! Check your Telegram app now and try clicking /start or a button!');
    await new Promise((resolve) => setTimeout(resolve, 60000));
    console.log('Test session completed.');
    await bot.stopPolling();
    process.exit(0);
  } catch (err: any) {
    console.error('❌ Telegram error:', err.message);
    process.exit(1);
  }
}

main();
