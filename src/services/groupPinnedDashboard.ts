import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { env } from '../config/env.js';
import { bot, safeSendTelegramMessage } from './telegram.js';
import { getPaperPortfolioSummary } from './paperTrading.js';
import { getTokensForDate } from './earlyTokenStore.js';
import { prisma } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, '../../data');
const DASHBOARD_STATE_FILE = path.join(DATA_DIR, 'pinned_dashboard.json');

// Ensure data directory exists
try {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
} catch {}

interface PinnedDashboardState {
  chatId: string;
  messageId?: number;
  lastCycleTimeMs?: number;
  lastUpdatedTimeMs?: number;
}

let cachedState: PinnedDashboardState = {
  chatId: env.TELEGRAM_GROUP_CHAT_ID || '',
};

// Load persisted state from disk
try {
  if (fs.existsSync(DASHBOARD_STATE_FILE)) {
    const raw = fs.readFileSync(DASHBOARD_STATE_FILE, 'utf-8');
    cachedState = JSON.parse(raw);
  }
} catch (err: any) {
  console.warn('⚠️ Could not load pinned_dashboard.json:', err.message);
}

function persistState(): void {
  try {
    fs.writeFileSync(DASHBOARD_STATE_FILE, JSON.stringify(cachedState, null, 2), 'utf-8');
  } catch (err: any) {
    console.warn('⚠️ Could not persist pinned_dashboard.json:', err.message);
  }
}

/**
 * Builds the comprehensive dashboard text including:
 * 1. Bot operating instructions
 * 2. 6-hour performance & PnL report (wins, losses, win rate, realized PnL)
 * 3. Hypothetical $1,000 baseline simulation
 * 4. Active trades and daily discoveries
 */
export async function buildGroupDashboardText(): Promise<string> {
  const summary = await getPaperPortfolioSummary();
  const wallet = summary.wallet;

  const totalTrades = wallet.totalTrades || 0;
  const winningTrades = wallet.winningTrades || 0;
  const losingTrades = wallet.losingTrades || 0;
  const winRate = totalTrades > 0 ? ((winningTrades / totalTrades) * 100).toFixed(1) : '0.0';

  const realizedPnlUsd = wallet.totalRealizedPnlUsd || 0;
  const realizedText = realizedPnlUsd >= 0
    ? `+$${realizedPnlUsd.toFixed(2)} USD`
    : `-$${Math.abs(realizedPnlUsd).toFixed(2)} USD`;

  // Hypothetical $1,000 starting capital calculations
  const baselineInitialUsd = 1000.0;
  const netWorthUsd = summary.netWorthUsd || baselineInitialUsd;
  const totalReturnUsd = Number((netWorthUsd - baselineInitialUsd).toFixed(2));
  const totalReturnPct = Number((((netWorthUsd - baselineInitialUsd) / baselineInitialUsd) * 100).toFixed(1));
  const totalReturnText = totalReturnUsd >= 0
    ? `+$${totalReturnUsd.toFixed(2)} USD (+${totalReturnPct.toFixed(1)}%)`
    : `-$${Math.abs(totalReturnUsd).toFixed(2)} USD (${totalReturnPct.toFixed(1)}%)`;

  // Today's discovered gems
  const today = new Date().toISOString().slice(0, 10);
  let todayCount = 0;
  try {
    todayCount = await prisma.earlyTrendingToken.count({ where: { alertDate: today } });
  } catch {}
  if (todayCount === 0) {
    try {
      todayCount = (await getTokensForDate(today)).length;
    } catch {}
  }

  const activePositions = summary.activePositions || [];
  const activeCount = activePositions.length;

  // Find top performer among active or closed trades
  let topRunnerText = 'Scanning for next breakout...';
  let bestMultiplier = 1.0;
  let bestSymbol = '';
  for (const pos of activePositions) {
    if (pos.peakMultiplier && pos.peakMultiplier > bestMultiplier) {
      bestMultiplier = pos.peakMultiplier;
      bestSymbol = pos.tokenSymbol;
    }
  }
  if (!bestSymbol && summary.closedPositions && summary.closedPositions.length > 0) {
    for (const c of summary.closedPositions) {
      if (c.peakMultiplier && c.peakMultiplier > bestMultiplier) {
        bestMultiplier = c.peakMultiplier;
        bestSymbol = c.tokenSymbol;
      }
    }
  }
  if (bestSymbol && bestMultiplier > 1.0) {
    topRunnerText = `<b>$${bestSymbol}</b> reached <b>${bestMultiplier.toFixed(2)}X</b> (+${((bestMultiplier - 1) * 100).toFixed(0)}%)`;
  }

  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);

  return `
📌 <b>COMMUNITY PERFORMANCE BRIEFING &amp; BOT GUIDE</b>
⚡ <i>Solana Early Trending Breakout Radar • 24/7 Autopilot</i>

📖 <b>HOW TO UTILIZE THIS BOT:</b>
• <b>Breakout Radar:</b> Scans Raydium &amp; Pump.fun 24/7 for brand new tokens (&lt; 2 mins old) at inception momentum.
• <b>RugCheck Armor:</b> Mandatory safety gate enforces 100% LP burned, Mint Authority Revoked, Freeze Authority Revoked, and &lt;3% dev retention.
• <b>Universal $10 Rule:</b> Strictly sizes trade allocations at $10.00 USD (+ gas) — completely eliminates reckless overexposure.
• <b>2X De-Risk Runner Strategy:</b> At 2X (+100%), the initial $10 capital is pulled back to cash. The remaining tokens ("moonbag") ride expansions (5X, 10X, 20X, 50X+) risk-free.
• <b>Wallet Mirroring:</b> Connect your personal sniper wallet via private direct message to mirror trades automatically.

📊 <b>PERFORMANCE &amp; PnL METRICS:</b>
• <b>Closed Trades:</b> <code>${totalTrades}</code>
• <b>Win / Loss Record:</b> <code>${winningTrades}W</code> - <code>${losingTrades}L</code> (<b>${winRate}% Win Rate</b>)
• <b>Realized PnL:</b> <b>${realizedText}</b>
• <b>Active Positions:</b> <code>${activeCount}</code> moonbags running
• <b>Coins Discovered Today:</b> <code>${todayCount}</code> breakout gems
• <b>Top Performer:</b> ${topRunnerText}

💵 <b>HYPOTHETICAL $1,000 STARTING CAPITAL:</b>
• <b>Starting Capital:</b> <code>$1,000.00 USD</code>
• <b>Current Hypothetical Equity:</b> <b>$${netWorthUsd.toFixed(2)} USD</b>
• <b>Net Cumulative Return:</b> <b>${totalReturnText}</b>
• <b>Liquid Cash Reserve:</b> <code>$${wallet.liquidCashUsd.toFixed(2)} USD</code> (Capital floor secured)

<i>Tap <b>[📬 Send to My Private DM]</b> below to receive this report and personal wallet instructions directly in your private chat.</i>

🔄 <i>Auto-updated live on new trade data • Fresh cycle pinned every 6 hours</i>
🕒 <i>Last Sync: ${timestamp} UTC</i>
  `.trim();
}

/**
 * Builds the inline interactive keyboard for the group dashboard
 */
export function buildGroupDashboardKeyboard(): any {
  const botUsername = env.TELEGRAM_BOT_USERNAME || 'MySolanaSBot';
  return {
    inline_keyboard: [
      [
        { text: '📬 Send to My Private DM', callback_data: 'send_pinned_to_dm' },
      ],
      [
        { text: '🔐 Connect Sniper Wallet', url: `https://t.me/${botUsername}?start=connect` },
        { text: '🔄 Refresh Stats', callback_data: 'refresh_pinned_dashboard' },
      ],
    ],
  };
}

/**
 * Builds keyboard specifically for private direct messages
 */
export function buildPrivateDashboardKeyboard(): any {
  return {
    inline_keyboard: [
      [
        { text: '💼 View Portfolio', callback_data: 'cmd_paper_portfolio' },
        { text: '⚙️ Auto-Snipe Config', callback_data: 'cmd_autosnipe' },
      ],
      [
        { text: '💎 Daily Gems', callback_data: 'cmd_early' },
        { text: '🏆 Top Gainers', callback_data: 'cmd_top' },
      ],
      [
        { text: '🔄 Refresh Stats', callback_data: 'refresh_pinned_dashboard' },
      ],
    ],
  };
}

/**
 * Posts or updates the pinned dashboard in the public community group.
 * If forceNew is true or editing fails, sends a new message and pins it.
 */
export async function postOrUpdateGroupPinnedDashboard(forceNew: boolean = false): Promise<void> {
  const targetChatId = env.TELEGRAM_GROUP_CHAT_ID;
  if (!targetChatId || targetChatId === '0' || !env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN.includes('dummy')) {
    return;
  }

  const text = await buildGroupDashboardText();
  const keyboard = buildGroupDashboardKeyboard();

  // Try editing existing message in place if not forced to post a new one
  if (!forceNew && cachedState.messageId && cachedState.chatId === targetChatId) {
    try {
      await bot.editMessageText(text, {
        chat_id: targetChatId,
        message_id: cachedState.messageId,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: keyboard,
      });
      cachedState.lastUpdatedTimeMs = Date.now();
      persistState();
      console.log(`📌 [Group Pinned Dashboard] Updated message #${cachedState.messageId} in ${targetChatId}`);
      return;
    } catch (err: any) {
      const errMsg = err?.message || '';
      if (errMsg.includes('message is not modified')) {
        // Content has not changed, nothing more to do
        return;
      }
      console.warn(`⚠️ [Group Pinned Dashboard] Edit failed (${errMsg}). Re-posting and pinning fresh message...`);
    }
  }

  // Send a fresh message and pin it
  try {
    const sentMsg = await bot.sendMessage(targetChatId, text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: keyboard,
    });

    cachedState.chatId = targetChatId;
    cachedState.messageId = sentMsg.message_id;
    cachedState.lastCycleTimeMs = Date.now();
    cachedState.lastUpdatedTimeMs = Date.now();
    persistState();

    // Pin the message in the group without notifying all members
    try {
      await bot.pinChatMessage(targetChatId, sentMsg.message_id, { disable_notification: true });
      console.log(`📌 [Group Pinned Dashboard] Successfully posted and pinned message #${sentMsg.message_id} in ${targetChatId}`);
    } catch (pinErr: any) {
      console.warn('⚠️ [Group Pinned Dashboard] Could not pin message (check bot admin rights in group):', pinErr.message);
    }
  } catch (sendErr: any) {
    console.error('❌ [Group Pinned Dashboard] Failed to send message to group:', sendErr.message);
  }
}

// Debounce timer for live updates
let debounceTimer: NodeJS.Timeout | null = null;

/**
 * Triggers a live dashboard update whenever new trade or milestone data is available.
 * Debounced by 15 seconds to prevent exceeding Telegram rate limits.
 */
export function triggerGroupDashboardUpdate(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    postOrUpdateGroupPinnedDashboard(false).catch((err) => {
      console.warn('⚠️ [Group Pinned Dashboard] Live update error:', err.message);
    });
  }, 15000);
}

/**
 * Handles user clicking the "📬 Send to My Private DM" button
 */
export async function handleSendDashboardToDm(query: any): Promise<void> {
  const userId = query.from.id;
  const botUsername = env.TELEGRAM_BOT_USERNAME || 'MySolanaSBot';

  try {
    const text = await buildGroupDashboardText();
    const keyboard = buildPrivateDashboardKeyboard();

    await safeSendTelegramMessage(userId, text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: keyboard,
    });

    await bot.answerCallbackQuery(query.id, {
      text: '📬 Performance report & bot guide sent to your private DM!',
      show_alert: false,
    });
  } catch (err: any) {
    const errMsg = err?.message || '';
    if (errMsg.includes('403') || errMsg.includes('blocked') || errMsg.includes('chat not found')) {
      // User hasn't clicked Start in the bot yet
      await bot.answerCallbackQuery(query.id, {
        text: `⚠️ Please open @${botUsername} and tap START first so the bot can DM you!`,
        show_alert: true,
      });
    } else {
      await bot.answerCallbackQuery(query.id, {
        text: `⚠️ Could not deliver to DM: ${errMsg}`,
        show_alert: true,
      });
    }
  }
}

/**
 * Initializes the 6-hour interval scheduler for the pinned group dashboard.
 * - Posts/updates once upon startup
 * - Every 6 hours posts a fresh message and pins it
 */
export function initGroupPinnedDashboardScheduler(): void {
  const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

  // Run initial check / post on startup after a short warm-up delay (5 seconds)
  setTimeout(async () => {
    try {
      const now = Date.now();
      const lastCycle = cachedState.lastCycleTimeMs || 0;
      const isDueForCycle = now - lastCycle >= SIX_HOURS_MS;

      // If no message pinned yet or >6h passed, post and pin fresh message
      if (!cachedState.messageId || isDueForCycle) {
        await postOrUpdateGroupPinnedDashboard(true);
      } else {
        // Otherwise update existing pinned message in place
        await postOrUpdateGroupPinnedDashboard(false);
      }
    } catch (err: any) {
      console.warn('⚠️ [Group Pinned Dashboard] Startup check error:', err.message);
    }
  }, 5000);

  // Recurring 6-hour scheduler
  setInterval(async () => {
    console.log('⏰ [Group Pinned Dashboard] 6-hour cycle reached. Posting and pinning fresh performance update...');
    try {
      await postOrUpdateGroupPinnedDashboard(true);
    } catch (err: any) {
      console.warn('⚠️ [Group Pinned Dashboard] 6-hour cycle error:', err.message);
    }
  }, SIX_HOURS_MS);

  console.log('📌 [Group Pinned Dashboard] Scheduler initialized (6-hour pinned cycles + live in-place updates).');
}
