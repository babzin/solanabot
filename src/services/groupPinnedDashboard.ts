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
  guideMessageId?: number;
  performanceMessageId?: number;
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
 * Builds the constant Bot Operating Guide.
 * This message is pinned once and stays permanently pinned in the public group.
 */
export function buildConstantBotGuideText(): string {
  const botUsername = env.TELEGRAM_BOT_USERNAME || 'MySolanaSBot';
  return `
📖 <b>SOLANA ALPHA BREAKOUT RADAR • OPERATING GUIDE</b>
⚡ <i>Automated 24/7 Inception Momentum &amp; Micro-Cap Sniper</i>

🛡️ <b>CORE OPERATING PRINCIPLES:</b>
• <b>Breakout Radar:</b> Continuously scans Raydium &amp; Pump.fun for newly launched tokens (&lt; 2 mins old) at inception momentum.
• <b>RugCheck Armor:</b> Mandatory safety gate enforces 100% LP burned, Mint Authority Revoked, Freeze Authority Revoked, and &lt;3% dev retention.
• <b>Universal $10 Rule:</b> Strictly sizes trade allocations at $10.00 USD (+ gas) — completely eliminates reckless overexposure.
• <b>2X De-Risk Runner Strategy:</b> At 2X (+100%), the initial $10 capital is pulled back to cash. The remaining tokens ("moonbag") ride expansions (5X, 10X, 20X, 50X+) risk-free.
• <b>Wallet Mirroring:</b> Connect your personal sniper wallet via private direct message to mirror trades automatically.

👤 <b>PORTFOLIO &amp; TRADING MODES:</b>
• <b>Unfunded Accounts:</b> Automatically track the <b>$1,000 Model Portfolio</b> with zero deposit required.
• <b>Funded Accounts:</b> Deposit SOL to your sniper wallet. If Auto-Snipe is <b>ON</b>, deposited funds are deployed on verified alerts ($10/trade). If <b>OFF</b>, zero funds are touched unless you manually trigger a buy.

👇 <i>Tap <b>[💬 Open Private DM ➔]</b> below to open direct chat with the bot and view your live dashboard:</i>
  `.trim();
}

/**
 * Keyboard for the constant Bot Operating Guide
 */
export function buildConstantBotGuideKeyboard(): any {
  const botUsername = env.TELEGRAM_BOT_USERNAME || 'MySolanaSBot';
  return {
    inline_keyboard: [
      [
        { text: '💬 Open Private DM ➔', url: `https://t.me/${botUsername}?start=dashboard` },
      ],
      [
        { text: '🔐 Connect Sniper Wallet', url: `https://t.me/${botUsername}?start=connect` },
      ],
    ],
  };
}

/**
 * Builds the 6-Hour Community Performance & PnL Report text.
 * Displays:
 * 1. Wins, losses, win rate, realized PnL
 * 2. Hypothetical $1,000 baseline starting capital simulation
 * 3. Personalized live status (if viewed in private DM)
 */
export async function buildPerformanceReportText(userId?: string): Promise<string> {
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

  // Personalized user status section when viewed in private DM
  let userPersonalStatus = '';
  if (userId) {
    try {
      const { getUserPreferences, getUserActivePositions } = await import('./sniper.js');
      const { fetchUserSolBalance } = await import('./telegram.js');
      const pref = await getUserPreferences(userId);
      const solBal = pref.solanaWallet ? await fetchUserSolBalance(pref.solanaWallet) : 0;
      const isFunded = Boolean(pref.solanaWallet && solBal >= 0.01);
      const solPrice = wallet.solPriceUsd || 145.0;

      if (isFunded) {
        const depositedUsd = (solBal * solPrice).toFixed(2);
        const userPositions = getUserActivePositions(userId);
        const snipeStatusText = pref.autoSnipeEnabled
          ? '🟢 <b>ACTIVE</b> (Using deposited funds for $10 entries)'
          : '⏸️ <b>DISABLED</b> (No funds allocated • Manual only)';

        userPersonalStatus = `
👤 <b>YOUR LIVE ACCOUNT STATUS:</b>
• <b>Deposited Funds:</b> <code>${solBal.toFixed(4)} SOL</code> (<b>$${depositedUsd} USD</b>)
• <b>Auto-Snipe:</b> ${snipeStatusText}
• <b>Active Personal Trades:</b> <code>${userPositions.length} running</code>
• <b>Wallet:</b> <code>${pref.solanaWallet?.slice(0, 4)}...${pref.solanaWallet?.slice(-4)}</code>
        `.trim() + '\n\n';
      } else {
        userPersonalStatus = `
👤 <b>YOUR ACCOUNT STATUS:</b>
• <b>Status:</b> 💼 <b>Utilizing $1,000 Alpha Model Portfolio (Unfunded)</b>
• <b>Auto-Snipe:</b> 🔴 <b>Awaiting Deposit</b>
• <i>Deposit SOL into your personal wallet to switch from the $1,000 model portfolio to live trading.</i>
        `.trim() + '\n\n';
      }
    } catch {}
  }

  return `
📊 <b>COMMUNITY PERFORMANCE &amp; PnL BRIEFING</b>
⚡ <i>Solana Early Trending Breakout Radar • 24/7 Autopilot</i>

${userPersonalStatus}📈 <b>PERFORMANCE &amp; PnL METRICS:</b>
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

<i>Tap <b>[💬 Open Private DM ➔]</b> below to jump into private chat with the bot and view your live trading dashboard.</i>

🔄 <i>Auto-updated live on new trade data • Fresh cycle pinned every 6 hours</i>
🕒 <i>Last Sync: ${timestamp} UTC</i>
  `.trim();
}

// Backwards-compatible export
export const buildGroupDashboardText = buildPerformanceReportText;

/**
 * Builds the inline interactive keyboard for the performance report
 */
export function buildPerformanceReportKeyboard(): any {
  const botUsername = env.TELEGRAM_BOT_USERNAME || 'MySolanaSBot';
  return {
    inline_keyboard: [
      [
        { text: '💬 Open Private DM ➔', url: `https://t.me/${botUsername}?start=dashboard` },
      ],
      [
        { text: '📬 Send Copy to My DM', callback_data: 'send_pinned_to_dm' },
        { text: '🔄 Refresh Stats', callback_data: 'refresh_pinned_dashboard' },
      ],
    ],
  };
}

export const buildGroupDashboardKeyboard = buildPerformanceReportKeyboard;

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
        { text: '🏆 Top Gainers', callback_data: 'cmd_top' },
        { text: '🔄 Refresh Stats', callback_data: 'refresh_pinned_dashboard' },
      ],
    ],
  };
}

/**
 * Ensures the constant Bot Guide message is posted and permanently pinned in the public group.
 * It does NOT get unpinned on 6-hour cycles.
 */
export async function ensureConstantBotGuidePinned(): Promise<void> {
  const targetChatId = env.TELEGRAM_GROUP_CHAT_ID;
  if (!targetChatId || targetChatId === '0' || !env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN.includes('dummy')) {
    return;
  }

  const guideText = buildConstantBotGuideText();
  const guideKeyboard = buildConstantBotGuideKeyboard();

  if (cachedState.guideMessageId && cachedState.chatId === targetChatId) {
    try {
      await bot.editMessageText(guideText, {
        chat_id: targetChatId,
        message_id: cachedState.guideMessageId,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: guideKeyboard,
      });
      return;
    } catch (err: any) {
      if (err?.message?.includes('message is not modified')) return;
      console.warn(`⚠️ [Constant Bot Guide] Edit failed (${err.message}). Posting fresh guide...`);
    }
  }

  try {
    const sentMsg = await bot.sendMessage(targetChatId, guideText, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: guideKeyboard,
    });

    cachedState.chatId = targetChatId;
    cachedState.guideMessageId = sentMsg.message_id;
    persistState();

    await bot.pinChatMessage(targetChatId, sentMsg.message_id, { disable_notification: true }).catch((pinErr: any) => {
      console.warn('⚠️ [Constant Bot Guide] Could not pin guide message:', pinErr.message);
    });

    console.log(`📌 [Constant Bot Guide] Successfully posted and pinned guide #${sentMsg.message_id} in ${targetChatId}`);
  } catch (err: any) {
    console.error('❌ [Constant Bot Guide] Failed to send guide to group:', err.message);
  }
}

/**
 * Posts or updates the Community Performance Report in the public group.
 * - In-place updates (forceNew = false) for live trades
 * - 6-hour cycles (forceNew = true) unpin the old performance report and pin the newest one.
 */
export async function postOrUpdatePerformanceReport(forceNew: boolean = false): Promise<void> {
  const targetChatId = env.TELEGRAM_GROUP_CHAT_ID;
  if (!targetChatId || targetChatId === '0' || !env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN.includes('dummy')) {
    return;
  }

  const text = await buildPerformanceReportText();
  const keyboard = buildPerformanceReportKeyboard();

  // Try in-place edit if not a fresh 6-hour cycle
  if (!forceNew && cachedState.performanceMessageId && cachedState.chatId === targetChatId) {
    try {
      await bot.editMessageText(text, {
        chat_id: targetChatId,
        message_id: cachedState.performanceMessageId,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: keyboard,
      });
      cachedState.lastUpdatedTimeMs = Date.now();
      persistState();
      return;
    } catch (err: any) {
      if (err?.message?.includes('message is not modified')) return;
      console.warn(`⚠️ [Performance Report] Edit failed (${err.message}). Re-posting newest performance report...`);
    }
  }

  // If forceNew (fresh 6-hour cycle), unpin the old performance report
  if (cachedState.performanceMessageId && cachedState.chatId === targetChatId) {
    try {
      await bot.unpinChatMessage(targetChatId, { message_id: cachedState.performanceMessageId } as any);
      console.log(`📌 [Performance Report] Unpinned old performance report #${cachedState.performanceMessageId}`);
    } catch (unpinErr: any) {
      console.warn(`⚠️ [Performance Report] Could not unpin old message #${cachedState.performanceMessageId}:`, unpinErr.message);
    }
  }

  // Send the new performance report and pin it
  try {
    const sentMsg = await bot.sendMessage(targetChatId, text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: keyboard,
    });

    cachedState.chatId = targetChatId;
    cachedState.performanceMessageId = sentMsg.message_id;
    cachedState.lastCycleTimeMs = Date.now();
    cachedState.lastUpdatedTimeMs = Date.now();
    persistState();

    await bot.pinChatMessage(targetChatId, sentMsg.message_id, { disable_notification: true }).catch((pinErr: any) => {
      console.warn('⚠️ [Performance Report] Could not pin message:', pinErr.message);
    });

    console.log(`📌 [Performance Report] Posted and pinned newest performance report #${sentMsg.message_id} in ${targetChatId}`);
  } catch (sendErr: any) {
    console.error('❌ [Performance Report] Failed to send report to group:', sendErr.message);
  }
}

/**
 * Master method: ensures constant guide is pinned and updates performance report.
 */
export async function postOrUpdateGroupPinnedDashboard(forceNew: boolean = false): Promise<void> {
  await ensureConstantBotGuidePinned();
  await postOrUpdatePerformanceReport(forceNew);
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
    postOrUpdatePerformanceReport(false).catch((err) => {
      console.warn('⚠️ [Group Pinned Dashboard] Live update error:', err.message);
    });
  }, 15000);
}

/**
 * Handles user clicking the "📬 Send Copy to My DM" button
 */
export async function handleSendDashboardToDm(query: any): Promise<void> {
  const userId = query.from.id;
  const botUsername = env.TELEGRAM_BOT_USERNAME || 'MySolanaSBot';

  try {
    const text = await buildPerformanceReportText(String(userId));
    const keyboard = buildPrivateDashboardKeyboard();

    await safeSendTelegramMessage(userId, text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: keyboard,
    });

    await bot.answerCallbackQuery(query.id, {
      text: '📬 Performance report & PnL sent to your private DM!',
      show_alert: false,
    });
  } catch (err: any) {
    const errMsg = err?.message || '';
    if (errMsg.includes('403') || errMsg.includes('blocked') || errMsg.includes('chat not found')) {
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
 * Initializes the 6-hour interval scheduler:
 * - Constant Bot Guide stays permanently pinned
 * - Community Performance Report is updated every 6 hours (old report unpinned, newest report pinned)
 */
export function initGroupPinnedDashboardScheduler(): void {
  const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

  // Run initial check / post on startup after a short warm-up delay (5 seconds)
  setTimeout(async () => {
    try {
      await ensureConstantBotGuidePinned();

      const now = Date.now();
      const lastCycle = cachedState.lastCycleTimeMs || 0;
      const isDueForCycle = now - lastCycle >= SIX_HOURS_MS;

      if (!cachedState.performanceMessageId || isDueForCycle) {
        await postOrUpdatePerformanceReport(true);
      } else {
        await postOrUpdatePerformanceReport(false);
      }
    } catch (err: any) {
      console.warn('⚠️ [Group Pinned Dashboard] Startup check error:', err.message);
    }
  }, 5000);

  // Recurring 6-hour scheduler
  setInterval(async () => {
    console.log('⏰ [Group Pinned Dashboard] 6-hour cycle reached. Posting newest performance update and unpinning old one...');
    try {
      await ensureConstantBotGuidePinned();
      await postOrUpdatePerformanceReport(true);
    } catch (err: any) {
      console.warn('⚠️ [Group Pinned Dashboard] 6-hour cycle error:', err.message);
    }
  }, SIX_HOURS_MS);

  console.log('📌 [Group Pinned Dashboard] Scheduler initialized (Constant Guide Pinned + 6h Rotating PnL Pin).');
}
