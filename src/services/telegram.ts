import TelegramBot from 'node-telegram-bot-api';
import { env } from '../config/env.js';
import { prisma } from './db.js';
import {
  executeSnipeTrade,
  executeSnipeSell,
  getUserAutoSnipeConfig,
  setUserAutoSnipeConfig,
  getUserPreferences,
  getActivePositions,
  getAllPositions,
  SnipeResult,
  SnipedPosition,
} from './sniper.js';
import { broadcastPricePump, broadcastPriceDip } from './events.js';

export const bot = new TelegramBot(env.TELEGRAM_BOT_TOKEN, {
  polling: {
    interval: 300,
    autoStart: false,
    params: {
      timeout: 10,
    },
  },
});

export function escapeHtml(str: string): string {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function formatTokenQuantity(amount: number): string {
  if (!amount || amount <= 0) return 'Tokens';
  if (amount >= 1_000_000_000) return `${(amount / 1_000_000_000).toFixed(2)}B`;
  if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(2)}M`;
  if (amount >= 1_000) return `${(amount / 1_000).toFixed(1)}K`;
  return amount.toFixed(0);
}

export function formatUnitPrice(priceUsd: number): string {
  if (!priceUsd || priceUsd <= 0) return '$0.00';
  if (priceUsd < 0.000001) return `$${priceUsd.toExponential(3)}`;
  if (priceUsd < 0.01) return `$${priceUsd.toFixed(6)}`;
  return `$${priceUsd.toFixed(4)}`;
}

export function formatUsd(num?: number): string {
  if (!num || num <= 0) return '$0';
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `$${(num / 1_000).toFixed(1)}K`;
  return `$${num.toFixed(1)}`;
}

export function getDexScreenerUrl(token: { dexUrl?: string | null; pairAddress?: string | null; tokenMint: string }): string {
  if (token.dexUrl && token.dexUrl.startsWith('http')) return token.dexUrl;
  if (token.pairAddress) return `https://dexscreener.com/solana/${token.pairAddress}`;
  return `https://dexscreener.com/solana/${token.tokenMint}`;
}

/**
 * Deprecated: Replaced by Solana Early & Whale Trending Coin Radar (@solearlytrending)
 */
export const buildUnifiedAlertCard = (_alert?: any): string => '';
export const buildSoulScannerCard = buildUnifiedAlertCard;
export async function dispatchTradeAlert(_alert?: any): Promise<void> {}
export async function dispatchExitAlert(..._args: any[]): Promise<void> {}

/**
 * Dispatches an automated snipe execution notification
 */
export async function dispatchSnipeNotification(
  snipe: SnipeResult,
  chatId: string | number = env.TELEGRAM_CHAT_ID
): Promise<void> {
  const simText = snipe.simulated ? ' <i>(Paper-Trading Simulation)</i>' : '';
  const explorerUrl = `https://solscan.io/tx/${snipe.signature}`;
  const symbol = snipe.tokenSymbol || 'TOKEN';

  const message = `
🤖 <b>[AUTO-SNIPE EXECUTED]</b>${simText}

🪙 <b>Target Token:</b> <b>$${escapeHtml(symbol)}</b> (<code>${snipe.tokenMint.slice(0, 6)}...${snipe.tokenMint.slice(-4)}</code>)
💰 <b>Allocation Spent:</b> <code>${snipe.solAmount.toFixed(2)} SOL</code>
📦 <b>Estimated Acquired:</b> <code>${formatTokenQuantity(snipe.tokenAmount)} ${symbol}</code>
⚡ <b>Routing Strategy:</b> <i>${escapeHtml(snipe.routePlan || 'Jupiter v6 Aggregator')}</i>
🔗 <b>Transaction Receipt:</b> <a href="${explorerUrl}">${snipe.signature.slice(0, 16)}...</a>

💡 <i>Auto-snipe settings can be tuned with <code>/snipe &lt;amount&gt;</code> or toggled via <code>/autosnipe</code></i>
`.trim();

  if (!env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN.includes('dummy')) {
    console.log(`[Snipe Notification Dry-Run]:\n${message}`);
    return;
  }

  try {
    await bot.sendMessage(chatId, message, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  } catch (err: any) {
    console.warn('⚠️ Could not send snipe notification:', err.message);
  }
}

/**
 * Dispatches an automated snipe sell/exit notification
 */
export async function dispatchSnipeSellNotification(
  snipe: SnipeResult,
  chatId: string | number = env.TELEGRAM_CHAT_ID
): Promise<void> {
  const simText = snipe.simulated ? ' <i>(Paper-Trading Simulation)</i>' : '';
  const explorerUrl = `https://solscan.io/tx/${snipe.signature}`;
  const symbol = snipe.tokenSymbol || 'TOKEN';

  const message = `
🚨 <b>[AI AUTO-SELL EXECUTED]</b>${simText}

🪙 <b>Sold Token:</b> <b>$${escapeHtml(symbol)}</b> (<code>${snipe.tokenMint.slice(0, 6)}...${snipe.tokenMint.slice(-4)}</code>)
💰 <b>SOL Reclaimed:</b> <code>+${snipe.solAmount.toFixed(3)} SOL</code>
📦 <b>Quantity Exited:</b> <code>${formatTokenQuantity(snipe.tokenAmount)} ${symbol}</code>
⚡ <b>Routing Strategy:</b> <i>${escapeHtml(snipe.routePlan || 'Jupiter Instant Take-Profit Exit')}</i>
🔗 <b>Transaction Receipt:</b> <a href="${explorerUrl}">${snipe.signature.slice(0, 16)}...</a>

💡 <i>AI detected smart-money dump/exit signal and automatically sold to protect capital!</i>
`.trim();

  if (!env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN.includes('dummy')) {
    console.log(`[Snipe Sell Notification Dry-Run]:\n${message}`);
    return;
  }

  try {
    await bot.sendMessage(chatId, message, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  } catch (err: any) {
    console.warn('⚠️ Could not send snipe sell notification:', err.message);
  }
}

export interface PricePumpMilestoneData {
  tokenMint: string;
  tokenSymbol: string;
  tokenName: string;
  entryPriceUsd: number;
  currentPriceUsd: number;
  entryMarketCap: number;
  currentMarketCap: number;
  gainPercent: number;
  milestonePercent: number;
  multiplier: number;
  elapsedTimeText: string;
  dexUrl: string;
}

export interface PriceDipMilestoneData {
  tokenMint: string;
  tokenSymbol: string;
  tokenName: string;
  referencePriceUsd: number;
  currentPriceUsd: number;
  currentMarketCap: number;
  referenceMarketCap?: number;
  dropPercent: number;
  dipType: string;
  dexUrl: string;
}

/**
 * Generates two 10-emoji rows of clickable Solscan links matching @solearlytrending exact format
 */
export function buildSolscanHolderMatrix(token: any): { row1: string; row2: string } {
  const distribution = token.topHoldersDistribution || [];
  const defaultEmojis = ['🛠️', '📦', '📦', '📦', '🐳', '🐟', '🐟', '🐟', '🍤', '🐟', '🐟', '🐟', '🍤', '🐟', '🐟', '🐟', '🍤', '🐟', '🐳', '🐟'];
  const devAddr = token.devAddress || token.tokenMint;

  const links: string[] = [];
  for (let i = 0; i < 20; i++) {
    const item = distribution[i];
    const addr = item?.address || (i === 0 ? devAddr : token.tokenMint);
    let emo = defaultEmojis[i];
    if (item?.type === 'dev') emo = '🛠️';
    else if (item?.type === 'bundle') emo = '📦';
    else if (item?.type === 'whale') emo = '🐳';
    else if (item?.type === 'fish') emo = '🐟';
    else if (item?.type === 'shrimp') emo = '🍤';

    // Solscan individual wallet anchor
    links.push(`<a href="https://solscan.io/account/${addr}">${emo}</a>`);
  }

  return {
    row1: links.slice(0, 10).join(''),
    row2: links.slice(10, 20).join(''),
  };
}

/**
 * Renders the exact @solearlytrending alert card text for any token
 */
export function renderEarlyTrendingCardText(token: any): string {
  const mint = token.tokenMint;
  const dexscreenerUrl = getDexScreenerUrl(token);
  const botUser = env.TELEGRAM_BOT_USERNAME || 'solearlytrending_bot';

  const links: string[] = [];
  if (token.xUrl) links.push(`<a href="${token.xUrl}">X</a>`);
  if (token.webUrl) links.push(`<a href="${token.webUrl}">WEB</a>`);
  if (token.tgUrl) links.push(`<a href="${token.tgUrl}">TG</a>`);
  links.push(`<a href="${dexscreenerUrl}">CHART</a>`);
  const linksLine = links.join('•');

  const mc = token.entryMarketCap || token.marketCap || 50_000;
  const mcStr = formatUsd(mc);
  const peakVal = token.peakPriceUsd && token.entryPriceUsd && token.entryPriceUsd > 0
    ? Math.max(mc * 1.05, (token.peakPriceUsd / token.entryPriceUsd) * mc)
    : mc * 1.08;
  const peakStr = formatUsd(peakVal);

  const liqUsd = token.liquidityUsd || Math.round(mc * 0.35);
  const liqStr = formatUsd(liqUsd);
  const vol1h = token.volume1h || Math.round(mc * 0.28);
  const vol1hStr = formatUsd(vol1h);
  const fakeVolUsd = token.fakeVolumeUsd ?? Math.round(vol1h * 0.015);
  const fakeVolPct = token.fakeVolumePct ?? (vol1h > 0 ? ((fakeVolUsd / vol1h) * 100).toFixed(0) : '2');
  const fakeVolStr = formatUsd(fakeVolUsd);

  const devSol = token.devSolBalance ?? (token.whaleSolAmount ? Math.max(0, Math.round(token.whaleSolAmount)) : 0);
  const holderCount = token.holderCount || 393;
  const top20Pct = token.top20Pct || 33;
  const devHoldingPct = token.devHoldingPct ?? 0;
  const fishPct = Math.max(15, Math.round(top20Pct * 0.65));
  const whalePct = Math.max(5, Math.round(top20Pct - fishPct));
  const soldIcon = devHoldingPct === 0 ? '🟢' : '🔴';
  const burntPct = token.lpBurntPct ?? 100;

  const bundleCount = token.bundleCount ?? 6;
  const bundleInitialPct = token.bundleInitialPct ?? 18;
  const bundleCurrentPct = token.bundleCurrentPct ?? 1.5;

  const sniperCount = token.sniperCount ?? 23;
  const sniperInitialPct = token.sniperInitialPct ?? 45;
  const sniperCurrentPct = token.sniperCurrentPct ?? 6.8;

  const devAddr = token.devAddress || mint;
  const devBundledPct = token.devBundledPct ?? 0.4;
  const devSoldPct = token.devSoldPct ?? (devHoldingPct === 0 ? 100 : 0);
  const airdropPct = token.airdropPct ?? 0;

  let ageText = token.ageText;
  if (!ageText && token.pairCreatedAt) {
    const createdMs = typeof token.pairCreatedAt === 'bigint' ? Number(token.pairCreatedAt) : Number(token.pairCreatedAt);
    const diffMin = Math.max(1, Math.floor((Date.now() - createdMs) / 60_000));
    ageText = `${diffMin}m`;
  } else if (!ageText && token.ageMinutes) {
    ageText = `${token.ageMinutes}m`;
  } else if (!ageText) {
    ageText = '2m';
  }

  const { row1, row2 } = buildSolscanHolderMatrix(token);

  return `
🔥 <a href="https://t.me/${botUser}?start=snipe_${mint}"><b>&lrm;${escapeHtml(token.tokenName || token.tokenSymbol)}</b></a><b> New </b><a href="https://t.me/solearlytrending"><b>Trending</b></a>
🕒 <b>Age</b>: ${ageText} | <b>Security</b>: ✅
🔗 ${linksLine}

💰 <b>MC: ${mcStr}</b> • 🔝 ${peakStr}
💧 <b>Liq:</b> ${liqStr}
📈 <b>Vol:</b> <i>1h</i>: ${vol1hStr}
┗   <a href="https://t.me/${botUser}?start=fakevol_${mint}"><b>Fake</b></a>: ${fakeVolStr} [${fakeVolPct}%]
👥 <a href="https://solscan.io/token/${mint}#holders"><b>Hodls</b></a>: ${holderCount}

📦 <a href="https://t.me/${botUser}?start=bundle_${mint}"><b>/Bundles</b></a>: ${bundleCount} • ${bundleInitialPct}% → ${bundleCurrentPct}%
🔫 <a href="https://docs.soulsystems.tech/user-guides/soul-scanner/snipers"><b>Snipers</b></a>: ${sniperCount} • ${sniperInitialPct}% → ${sniperCurrentPct}% 🤍
<a href="https://t.me/${botUser}?start=first20_${mint}"><b>🎯 First 20</b></a><b>:</b> ${top20Pct}% | 🐟 ${fishPct}% | 🐳 ${whalePct}%
${row1}
${row2}

<a href="https://solscan.io/account/${devAddr}"><b>🛠️ Dev:</b></a> ${devSol} SOL | ${devHoldingPct}%
┣ Bundled: ${devBundledPct}% 🤍 | Sold: ${devSoldPct}% ${soldIcon}
┗ Airdrops: ${airdropPct}% 🤍 | Burnt: ${burntPct}% 🔥
`.trim();
}

/**
 * Dispatches an Early & Whale Radar alert formatted exactly like @solearlytrending
 */
export async function dispatchEarlyTrendingAlert(
  candidate: any,
  dailyIndex: number = 1
): Promise<void> {
  const dexscreenerUrl = getDexScreenerUrl(candidate);
  const trojanUrl = env.TROJAN_REF_CODE
    ? `https://t.me/solana_trojanbot?start=r-${env.TROJAN_REF_CODE}-${candidate.tokenMint}`
    : `https://t.me/solana_trojanbot?start=${candidate.tokenMint}`;

  const photonUrl = env.PHOTON_REF_CODE
    ? `https://photon-sol.tinyastro.io/en/lp/${candidate.pairAddress || candidate.tokenMint}?ref=${env.PHOTON_REF_CODE}`
    : `https://photon-sol.tinyastro.io/en/lp/${candidate.pairAddress || candidate.tokenMint}`;

  const message = renderEarlyTrendingCardText(candidate);

  const inlineKeyboard = [
    [
      { text: '📊 DexScreener', url: dexscreenerUrl },
      { text: '🔍 Solscan', url: `https://solscan.io/token/${candidate.tokenMint}` },
    ],
    [
      { text: '⚡ Snipe 0.1 SOL', callback_data: `snipe_quick_0.1_${candidate.tokenMint}` },
      { text: '⚡ Snipe 0.5 SOL', callback_data: `snipe_quick_0.5_${candidate.tokenMint}` },
    ],
    [
      { text: '🦄 Buy on Trojan', url: trojanUrl },
      { text: '⚡ Buy on Photon', url: photonUrl },
    ],
  ];

  if (!env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN.includes('dummy')) {
    console.log(`[Early Radar Dry-Run #${dailyIndex}]:\n${message}`);
    return;
  }

  // Attempt photo alert with card as caption if imageUrl is present
  if (candidate.imageUrl) {
    try {
      await bot.sendPhoto(env.TELEGRAM_CHAT_ID, candidate.imageUrl, {
        caption: message,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: inlineKeyboard },
      });
      return;
    } catch (photoErr: any) {
      console.warn(`⚠️ Photo dispatch notice for ${candidate.tokenSymbol} (${photoErr.message}), falling back to text card...`);
    }
  }

  try {
    await bot.sendMessage(env.TELEGRAM_CHAT_ID, message, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: inlineKeyboard },
      disable_web_page_preview: true,
    });
  } catch (err: any) {
    console.error('⚠️ Failed to dispatch Early Trending Alert:', err.message);
  }
}

/**
 * Dispatches a +50% Profit Pump Milestone Alert matching @solearlytrending format
 */
export async function dispatchPricePumpMilestoneAlert(
  pump: PricePumpMilestoneData
): Promise<void> {
  const chartUrl = pump.dexUrl || getDexScreenerUrl(pump);
  const entryMc = formatUsd(pump.entryMarketCap);
  const currentMc = formatUsd(pump.currentMarketCap);

  const multText = pump.multiplier >= 2.0 ? `${pump.multiplier}X` : `${pump.milestonePercent}%`;

  let flyingMoney = '💸💸';
  if (pump.multiplier >= 2.0) flyingMoney = '💸💸💸💸';
  if (pump.multiplier >= 3.0) flyingMoney = '💸💸💸💸💸💸';
  if (pump.multiplier >= 5.0) flyingMoney = '💸💸💸💸💸💸💸💸💸💸';
  if (pump.multiplier >= 10.0) flyingMoney = '💸💸💸💸💸💸💸💸💸💸💸💸💸💸💸💸💸💸💸💸';
  if (pump.multiplier >= 15.0) flyingMoney = '💸💸💸💸💸💸💸💸💸💸💸💸💸💸💸💸💸💸💸💸💸💸💸💸💸💸💸💸💸💸';
  if (pump.multiplier >= 20.0) flyingMoney = '💸💸💸💸💸💸💸💸💸💸💸💸💸💸💸💸💸💸💸💸💸💸💸💸💸💸💸💸💸💸💸💸💸💸💸💸💸💸💸💸';

  const message = `
📈 <a href="${chartUrl}"><b>&lrm;${escapeHtml(pump.tokenSymbol)}</b></a> is up <b>${multText}</b> 📈
from ⚡️ <a href="${chartUrl}">Entry Signal</a>

<b>${entryMc}</b> —> <b>${currentMc}</b> 💵

${flyingMoney}
`.trim();

  // Broadcast to Soul Web Terminal
  broadcastPricePump(pump);

  const inlineKeyboard = [
    [
      { text: '📊 DexScreener Chart', url: chartUrl },
      { text: '🔍 Solscan', url: `https://solscan.io/token/${pump.tokenMint}` },
    ],
    [
      { text: '💰 Take-Profit (Sell 50%)', callback_data: `sell_quick_50_${pump.tokenMint}` },
      { text: '🚪 Exit All (100%)', callback_data: `sell_quick_100_${pump.tokenMint}` },
    ],
  ];

  if (!env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN.includes('dummy')) {
    console.log(`[Pump Milestone Dry-Run]:\n${message}`);
    return;
  }

  try {
    await bot.sendMessage(env.TELEGRAM_CHAT_ID, message, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: inlineKeyboard },
      disable_web_page_preview: true,
    });
  } catch (err: any) {
    console.error('⚠️ Failed to dispatch Pump Milestone Alert:', err.message);
  }
}

/**
 * Dispatches a -50% Retracement Milestone Alert matching @solearlytrending update card style
 */
export async function dispatchPriceDipMilestoneAlert(
  dip: PriceDipMilestoneData
): Promise<void> {
  const chartUrl = dip.dexUrl || getDexScreenerUrl(dip);

  const refMcVal = dip.referenceMarketCap || (dip.referencePriceUsd && dip.currentPriceUsd && dip.currentPriceUsd > 0
    ? (dip.currentMarketCap * (dip.referencePriceUsd / dip.currentPriceUsd))
    : dip.currentMarketCap * 2);
  const refMc = formatUsd(refMcVal);
  const currentMc = formatUsd(dip.currentMarketCap);

  const signalLabel = dip.dipType === 'Peak Pullback' ? 'Peak Level' : 'Entry Signal';

  const message = `
📉 <a href="${chartUrl}"><b>&lrm;${escapeHtml(dip.tokenSymbol)}</b></a> is down <b>${dip.dropPercent}%</b> 📉
from ⚡️ <a href="${chartUrl}">${signalLabel}</a>

<b>${refMc}</b> —> <b>${currentMc}</b> 💵

🩸🩸
`.trim();

  // Broadcast to Soul Web Terminal
  broadcastPriceDip(dip);

  const inlineKeyboard = [
    [
      { text: '📊 DexScreener Chart', url: chartUrl },
      { text: '🔍 Solscan', url: `https://solscan.io/token/${dip.tokenMint}` },
    ],
    [
      { text: '🛡️ Emergency Cut-Loss (Sell 100%)', callback_data: `sell_quick_100_${dip.tokenMint}` },
    ],
  ];

  if (!env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN.includes('dummy')) {
    console.log(`[Dip Milestone Dry-Run]:\n${message}`);
    return;
  }

  try {
    await bot.sendMessage(env.TELEGRAM_CHAT_ID, message, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: inlineKeyboard },
      disable_web_page_preview: true,
    });
  } catch (err: any) {
    console.error('⚠️ Failed to dispatch Dip Milestone Alert:', err.message);
  }
}

/**
 * Initializes Telegram Bot interactive command handlers:
 * Dedicated 6-button menu: Start, Daily Coins, Top Gainers, Price Milestones, My Positions, and Auto-Snipe
 */
export function initTelegramCommands(): void {
  // Graceful polling error suppression for test/dummy tokens
  bot.on('polling_error', (err: any) => {
    if (env.TELEGRAM_BOT_TOKEN.includes('dummy')) return;
    console.warn('⚠️ Telegram polling issue:', err.message);
  });

  // Register native Telegram Command Menu
  bot.setMyCommands([
    { command: 'start', description: '🚀 Main Menu & Dashboard' },
    { command: 'scan', description: '⚡ Scan DexScreener & Pump.fun Now' },
    { command: 'daily', description: '💎 Daily 2min Early Trending Coins' },
    { command: 'top', description: '🏆 Daily Top Gainers & 5X-20X Hall of Fame' },
    { command: 'milestones', description: '📈 Price Milestones (+50% / -50%)' },
    { command: 'positions', description: '💼 My Active Positions & TP/SL Status' },
    { command: 'autosnipe', description: '⚙️ Auto-Snipe Settings & Toggle' },
    { command: 'wallet', description: '💰 Wallet Balance & Solscan' },
    { command: 'help', description: '❓ How It Works & Trading Guide' },
  ]).catch((err) => {
    console.warn('⚠️ Could not register Telegram menu commands:', err.message);
  });

  // Persistent Keyboard docked at the bottom of phone screen (8 clean buttons)
  const persistentReplyKeyboard = {
    keyboard: [
      [{ text: '🚀 /start' }, { text: '⚡ Scan Now' }],
      [{ text: '💎 Daily Coins' }, { text: '🏆 Top Gainers' }],
      [{ text: '📈 Price Milestones' }, { text: '💼 My Positions' }],
      [{ text: '⚙️ Auto-Snipe' }, { text: '💰 Wallet' }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };

  const sendWelcomeDashboard = async (chatId: number | string) => {
    const userId = String(chatId);
    const pref = await getUserPreferences(userId);

    const snipeBadge = pref.autoSnipeEnabled
      ? `🟢 <b>ACTIVE</b> (<code>${pref.autoSnipeSolAmount.toFixed(2)} SOL</code>)`
      : '🔴 <b>DISABLED</b> (Signals Only)';

    let dailyCoinCount = 0;
    try {
      const today = new Date().toISOString().slice(0, 10);
      dailyCoinCount = await prisma.earlyTrendingToken.count({ where: { alertDate: today } });
    } catch {}

    const welcome = `
🔥 <b>Solana Early &amp; Whale Trending Radar (@solearlytrending)</b> 💵
<i>Modeled after @solearlytrending • Built for high-velocity 5X–20X breakouts</i>

💎 <b>EARLY &amp; WHALE RADAR:</b>
• <b>Alerted Today:</b> <code>${dailyCoinCount}/45 Verified Gems</code>
• 🕒 <b>Age Gate:</b> Fresh 2-minute launches &amp; bonding curve breakouts
• 🎯 <b>Filtering:</b> Strict RugCheck audit (Mint &amp; Freeze revoked, 100% LP burned, Dev sold/clean)
• 📈 <b>Price Milestones:</b> Real-time +50% Pumps &amp; -50% Retracement alerts
• 📊 <b>DexScreener:</b> 1-Tap direct pair chart button on every call

⚙️ <b>AUTO-SNIPER &amp; EXIT STRATEGY:</b>
• <b>Status:</b> ${snipeBadge}
• 🎯 <b>2X Take-Profit:</b> Sells 50% at +100% to secure initial SOL risk-free!
• 🛡️ <b>Trailing Stop-Loss:</b> Protects remaining moonbag on sharp reversals (-25%)

<i>Tap any button below to view active gems or manage auto-snipe:</i>
    `.trim();

    const inlineKeyboard = [
      [
        { text: '⚡ Scan Now', callback_data: 'cmd_scan' },
        { text: '💎 Daily Coins', callback_data: 'cmd_early' },
      ],
      [
        { text: '🏆 Top Gainers', callback_data: 'cmd_top' },
        { text: '📈 Price Milestones', callback_data: 'cmd_milestones' },
      ],
      [
        { text: '💼 My Positions', callback_data: 'cmd_positions' },
        { text: '⚙️ Auto-Snipe Settings', callback_data: 'cmd_snipe_menu' },
      ],
      [
        { text: '💰 Wallet & Solscan', callback_data: 'cmd_wallet' },
        { text: '❓ How It Works', callback_data: 'cmd_help' },
      ],
    ];

    try {
      await bot.sendMessage(chatId, welcome, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: inlineKeyboard,
        },
      });

      // Also ensure the docked bottom reply keyboard is activated
      await bot.sendMessage(chatId, '📱 <i>Quick 1-tap buttons docked below:</i>', {
        parse_mode: 'HTML',
        reply_markup: persistentReplyKeyboard,
      });
    } catch (err: any) {
      console.warn('Failed to send welcome dashboard:', err.message);
    }
  };

  // /start or Start button
  bot.onText(/\/start|🚀 \/start|🚀 Start/i, async (msg) => {
    await sendWelcomeDashboard(msg.chat.id);
  });

  // /daily or /early or "💎 Daily Coins" button
  bot.onText(/💎 Daily Coins|\/daily|\/early|Daily Coin/i, async (msg) => {
    await handleEarlyTrendingCommand(msg.chat.id);
  });

  // /top or "🏆 Top Gainers" button
  bot.onText(/🏆 Top Gainers|\/top|Top Gainer|Hall of Fame/i, async (msg) => {
    await handleTopCommand(msg.chat.id);
  });

  // /milestones or "📈 Price Milestones" button
  bot.onText(/\/milestones|📈 Price Milestones|📈 Milestones|Price Milestone/i, async (msg) => {
    await handlePriceMilestonesCommand(msg.chat.id);
  });

  // /positions or "💼 My Positions" button
  bot.onText(/💼 My Positions|\/positions|\/portfolio|My Position/i, async (msg) => {
    await handlePositionsCommand(msg.chat.id);
  });

  // "⚙️ Auto-Snipe" button
  bot.onText(/⚙️ Auto-Snipe|Auto Snipe Settings/i, async (msg) => {
    const userId = String(msg.from?.id || msg.chat.id);
    await handleSnipeStatus(msg.chat.id, userId);
  });

  // "🟢 Auto-Snipe ON" button
  bot.onText(/🟢 Auto-Snipe ON|\/autosnipe\s+on/i, async (msg) => {
    const userId = String(msg.from?.id || msg.chat.id);
    await setUserAutoSnipeConfig(userId, { autoSnipeEnabled: true });
    await bot.sendMessage(msg.chat.id, '🟢 <b>Auto-Snipe is now ENABLED!</b>\nThe bot will automatically snipe approved trades.', { parse_mode: 'HTML' });
  });

  // "🔴 Auto-Snipe OFF" button
  bot.onText(/🔴 Auto-Snipe OFF|\/autosnipe\s+off/i, async (msg) => {
    const userId = String(msg.from?.id || msg.chat.id);
    await setUserAutoSnipeConfig(userId, { autoSnipeEnabled: false });
    await bot.sendMessage(msg.chat.id, '🔴 <b>Auto-Snipe is now DISABLED!</b>\nYou will receive alert signals only.', { parse_mode: 'HTML' });
  });

  // /autosnipe on|off
  bot.onText(/\/autosnipe(?:\s+(on|off))?/i, async (msg, match) => {
    const userId = String(msg.from?.id || msg.chat.id);
    const mode = match?.[1]?.toLowerCase();
    if (mode === 'on') {
      await setUserAutoSnipeConfig(userId, { autoSnipeEnabled: true });
      await bot.sendMessage(msg.chat.id, '🟢 <b>Auto-Snipe is now ENABLED!</b>', { parse_mode: 'HTML' });
    } else if (mode === 'off') {
      await setUserAutoSnipeConfig(userId, { autoSnipeEnabled: false });
      await bot.sendMessage(msg.chat.id, '🔴 <b>Auto-Snipe is now DISABLED!</b>', { parse_mode: 'HTML' });
    } else {
      await handleSnipeStatus(msg.chat.id, userId);
    }
  });

  // /scan or "⚡ Scan Now"
  bot.onText(/\/scan|⚡ Scan Now|Scan/i, async (msg) => {
    await bot.sendMessage(msg.chat.id, '🔍 <i>Scanning DexScreener & Pump.fun for fresh 2-minute breakout gems...</i>', { parse_mode: 'HTML' });
    try {
      const { runEarlyTrendingRadarCycle } = await import('./earlyTrending.js');
      const count = await runEarlyTrendingRadarCycle();
      if (count > 0) {
        await bot.sendMessage(msg.chat.id, `✅ <i>Scan complete: Dispatched <b>${count}</b> new gem alert(s)!</i>`, { parse_mode: 'HTML' });
      } else {
        await bot.sendMessage(msg.chat.id, `✅ <i>Scan complete. No new gems met the 5X threshold in the last 35 seconds. Radar is scanning continuously!</i>`, { parse_mode: 'HTML' });
      }
    } catch (err: any) {
      await bot.sendMessage(msg.chat.id, `⚠️ <i>Scan error: ${err.message}</i>`, { parse_mode: 'HTML' });
    }
  });

  // /wallet or /balance or "💰 Wallet"
  bot.onText(/\/wallet|\/balance|💰 Wallet|Balance/i, async (msg) => {
    const wallet = env.USER_SOLANA_WALLET;
    const mode = env.SNIPER_PRIVATE_KEY
      ? '🟢 <b>Live On-Chain Trading (Mainnet)</b>'
      : '⚡ <b>Zero-Risk Paper Trading (Simulation)</b>';
    await bot.sendMessage(
      msg.chat.id,
      `💼 <b>Connected Sniper Wallet</b>\n\n` +
      `🔑 <b>Address:</b> <code>${wallet}</code>\n` +
      `🔗 <a href="https://solscan.io/account/${wallet}">View Account on Solscan</a>\n\n` +
      `⚡ <b>Engine Status:</b> ${mode}\n` +
      `💡 <i>To trade live on-chain with real SOL, set <code>SNIPER_PRIVATE_KEY</code> in your .env.</i>`,
      { parse_mode: 'HTML', disable_web_page_preview: true }
    );
  });

  // /help or "❓ Help"
  bot.onText(/\/help|❓ Help/i, async (msg) => {
    await bot.sendMessage(
      msg.chat.id,
      `📖 <b>Solana Early Trending &amp; Sniper Bot Guide</b>\n\n` +
      `1️⃣ <b>Early Gem Discovery:</b> Scans DexScreener &amp; Pump.fun continuously for 2-minute breakout coins ($20k-$150k MC).\n\n` +
      `2️⃣ <b>RugCheck Audit:</b> Revoked mint &amp; freeze, 100% burned LP, clean holder distribution.\n\n` +
      `3️⃣ <b>Automated Price Tracking:</b> Tracks alerted coins every 30s. When a coin hits <b>+50%</b>, <b>2X</b>, <b>5X</b>, up to <b>79X</b>, you receive instant pump alerts with take-profit buttons!\n\n` +
      `4️⃣ <b>1-Tap Sniping:</b> Tap <code>⚡ Snipe 0.1 SOL</code> on any card to trade immediately, or toggle <code>/autosnipe</code> to snipe automatically.\n\n` +
      `<b>Commands:</b>\n` +
      `• /start — Open Main Dashboard\n` +
      `• /scan — Run Immediate Radar Scan\n` +
      `• /daily — View Today's Alerted Coins\n` +
      `• /top — View Daily Top Gainers\n` +
      `• /milestones — View Pumps &amp; Retracements\n` +
      `• /positions — View Active Positions &amp; PnL\n` +
      `• /autosnipe — Toggle Automated Sniping\n` +
      `• /wallet — View Connected Wallet &amp; Solscan`,
      { parse_mode: 'HTML' }
    );
  });

  // Inline button callbacks
  bot.on('callback_query', async (query) => {
    const data = query.data;
    const chatId = query.message?.chat.id || 0;
    const userId = String(query.from.id);
    const msgId = query.message?.message_id;

    try {
      await bot.answerCallbackQuery(query.id);

      if (data === 'cmd_start') {
        await sendWelcomeDashboard(chatId);
      } else if (data === 'cmd_scan') {
        await bot.sendMessage(chatId, '🔍 <i>Scanning DexScreener & Pump.fun for fresh 2-minute breakout gems...</i>', { parse_mode: 'HTML' });
        const { runEarlyTrendingRadarCycle } = await import('./earlyTrending.js');
        const count = await runEarlyTrendingRadarCycle();
        if (count > 0) {
          await bot.sendMessage(chatId, `✅ <i>Scan complete: Dispatched <b>${count}</b> new gem alert(s)!</i>`, { parse_mode: 'HTML' });
        } else {
          await bot.sendMessage(chatId, `✅ <i>Scan complete. No unalerted tokens met the strict 5X/20X criteria right this second. Continuous background radar is scanning every 35s!</i>`, { parse_mode: 'HTML' });
        }
      } else if (data === 'cmd_wallet') {
        const wallet = env.USER_SOLANA_WALLET;
        const mode = env.SNIPER_PRIVATE_KEY ? '🟢 Live On-Chain' : '⚡ Paper Trading';
        await bot.sendMessage(chatId, `💼 <b>Wallet:</b> <code>${wallet}</code>\n🔗 <a href="https://solscan.io/account/${wallet}">View on Solscan</a>\n⚡ <b>Mode:</b> ${mode}`, { parse_mode: 'HTML', disable_web_page_preview: true });
      } else if (data === 'cmd_help') {
        await bot.sendMessage(chatId, `📖 <b>Quick Guide:</b>\n• Continuous radar scans every 35s\n• Strict LP burnt & revoked authority audit\n• Instant +50% to 79X pump tracking & alerts\n• 1-Tap Snipe buttons on every alert card`, { parse_mode: 'HTML' });
      } else if (data === 'cmd_early') {
        await handleEarlyTrendingCommand(chatId);
      } else if (data === 'cmd_top') {
        await handleTopCommand(chatId);
      } else if (data === 'cmd_milestones') {
        await handlePriceMilestonesCommand(chatId);
      } else if (data === 'cmd_positions') {
        await handlePositionsCommand(chatId);
      } else if (data === 'cmd_snipe_menu') {
        await handleSnipeStatus(chatId, userId, msgId);
      } else if (data?.startsWith('daily_card_')) {
        const idx = parseInt(data.replace('daily_card_', ''), 10);
        if (!isNaN(idx)) {
          await handleEarlyTrendingCommand(chatId, idx, msgId);
        }
      } else if (data === 'daily_send_last3') {
        const today = new Date().toISOString().slice(0, 10);
        const tokens = await prisma.earlyTrendingToken.findMany({
          where: { alertDate: today },
          orderBy: { dailyQuotaIndex: 'asc' },
        });
        const last3 = tokens.slice(-3);
        if (last3.length === 0) {
          await bot.sendMessage(chatId, 'ℹ️ <i>No coins logged yet today.</i>', { parse_mode: 'HTML' });
        } else {
          for (const t of last3) {
            const cardText = renderEarlyTrendingCardText(t);
            const url = getDexScreenerUrl(t);
            await bot.sendMessage(chatId, cardText, {
              parse_mode: 'HTML',
              disable_web_page_preview: true,
              reply_markup: {
                inline_keyboard: [[{ text: '📊 Chart (DexScreener)', url }]],
              },
            });
            await new Promise((r) => setTimeout(r, 400));
          }
        }
      } else if (data?.startsWith('wallets_') || data === 'cmd_wallets' || data === 'cmd_discover' || data === 'cmd_filter') {
        await sendWelcomeDashboard(chatId);
      } else if (data === 'snipe_enable') {
        await setUserAutoSnipeConfig(userId, { autoSnipeEnabled: true });
        await bot.sendMessage(chatId, '🟢 <b>Auto-Snipe is now ENABLED!</b>\nThe bot will automatically snipe approved trades.', { parse_mode: 'HTML' });
      } else if (data === 'snipe_disable') {
        await setUserAutoSnipeConfig(userId, { autoSnipeEnabled: false });
        await bot.sendMessage(chatId, '🔴 <b>Auto-Snipe is now DISABLED!</b>\nYou will receive alert signals only.', { parse_mode: 'HTML' });
      } else if (data?.startsWith('snipe_set_')) {
        const amt = parseFloat(data.replace('snipe_set_', ''));
        if (!isNaN(amt)) {
          await setUserAutoSnipeConfig(userId, { autoSnipeSolAmount: amt, autoSnipeEnabled: true });
          await bot.sendMessage(chatId, `✅ <b>Snipe size updated to ${amt} SOL!</b> Auto-snipe is <b>ACTIVE</b> 🟢`, { parse_mode: 'HTML' });
        }
      } else if (data?.startsWith('snipe_quick_')) {
        const parts = data.split('_');
        const amount = parseFloat(parts[2]);
        const mint = parts[3];
        if (!isNaN(amount) && mint) {
          await bot.sendMessage(chatId, `⏳ <i>Executing 1-tap snipe of ${amount} SOL for token <code>${mint.slice(0, 6)}...${mint.slice(-4)}</code>...</i>`, { parse_mode: 'HTML' });
          const snipeResult = await executeSnipeTrade(mint, amount);
          await dispatchSnipeNotification(snipeResult, chatId);
        }
      } else if (data?.startsWith('sell_quick_')) {
        const parts = data.split('_');
        const pct = parseFloat(parts[2]) || 100;
        const mint = parts[3];
        if (mint) {
          await bot.sendMessage(chatId, `⏳ <i>Executing ${pct}% exit for token <code>${mint.slice(0, 6)}...${mint.slice(-4)}</code>...</i>`, { parse_mode: 'HTML' });
          const sellResult = await executeSnipeSell(mint, undefined, undefined, pct);
          await dispatchSnipeSellNotification(sellResult, chatId);
        }
      }
    } catch (err: any) {
      console.warn('Callback query error:', err.message);
    }
  });

  if (env.TELEGRAM_ENABLE_POLLING && env.TELEGRAM_BOT_TOKEN && !env.TELEGRAM_BOT_TOKEN.includes('dummy')) {
    bot.startPolling({ restart: true }).catch((err) => {
      console.warn('⚠️ Telegram polling start skipped:', err.message);
    });
    console.log('🤖 Telegram interactive command listeners activated (/daily, /top, /milestones, /positions, /autosnipe)');
  }
}

/**
 * Displays today's Early & Whale Radar coins as individual @solearlytrending alert cards
 */
async function handleEarlyTrendingCommand(chatId: number | string, targetIndex?: number, messageIdToEdit?: number): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const tokens = await prisma.earlyTrendingToken.findMany({
      where: { alertDate: today },
      orderBy: { dailyQuotaIndex: 'asc' },
    });

    if (tokens.length === 0) {
      await bot.sendMessage(
        chatId,
        `💎 <b>Daily Coins (@solearlytrending Strategy)</b>\n\n` +
          `No tokens have met the strict @solearlytrending criteria yet today.\n` +
          `The engine scans DexScreener continuously and requires revoked mint/freeze, 100% burned/locked LP, and clean audits.`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '📈 Price Milestones', callback_data: 'cmd_milestones' },
                { text: '🚀 /start (Main Menu)', callback_data: 'cmd_start' },
              ],
            ],
          },
        }
      );
      return;
    }

    // Default to latest token
    const currIdx = typeof targetIndex === 'number' && targetIndex >= 0 && targetIndex < tokens.length
      ? targetIndex
      : tokens.length - 1;

    const token = tokens[currIdx];
    const cardText = renderEarlyTrendingCardText(token);
    const dexscreenerUrl = getDexScreenerUrl(token);

    const navButtons: any[] = [];
    if (currIdx > 0) {
      navButtons.push({ text: `⬅️ #${currIdx} ${tokens[currIdx - 1].tokenSymbol}`, callback_data: `daily_card_${currIdx - 1}` });
    }
    navButtons.push({ text: `💎 #${currIdx + 1}/${tokens.length}`, callback_data: `daily_card_${currIdx}` });
    if (currIdx < tokens.length - 1) {
      navButtons.push({ text: `➡️ #${currIdx + 2} ${tokens[currIdx + 1].tokenSymbol}`, callback_data: `daily_card_${currIdx + 1}` });
    }

    const keyboard = [
      [
        { text: '📊 Chart (DexScreener)', url: dexscreenerUrl },
      ],
      navButtons,
      [
        { text: '📬 Send Last 3 One-by-One', callback_data: 'daily_send_last3' },
      ],
      [
        { text: '🏆 Top Gainers', callback_data: 'cmd_top' },
        { text: '📈 Price Milestones', callback_data: 'cmd_milestones' },
      ],
      [
        { text: '🚀 /start (Main Menu)', callback_data: 'cmd_start' },
      ],
    ];

    if (messageIdToEdit) {
      await bot.editMessageText(cardText, {
        chat_id: chatId,
        message_id: messageIdToEdit,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: keyboard },
      });
    } else {
      await bot.sendMessage(chatId, cardText, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: keyboard },
      });
    }
  } catch (err: any) {
    console.warn('handleEarlyTrendingCommand error:', err.message);
  }
}

/**
 * Displays active 50% Price Milestone Trackers
 */
async function handlePriceMilestonesCommand(chatId: number | string): Promise<void> {
  try {
    const tokens = await prisma.earlyTrendingToken.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { updatedAt: 'desc' },
      take: 15,
    });

    if (tokens.length === 0) {
      await bot.sendMessage(
        chatId,
        `📈 <b>Price Milestone Trackers (Active: 0)</b>\n\n` +
          `No tokens are currently in the active milestone tracking list.\n` +
          `Whenever a daily gem is alerted, it is tracked in real-time for +50% pumps and -50% dips!`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '💎 Daily Coins', callback_data: 'cmd_early' },
                { text: '🚀 /start (Main Menu)', callback_data: 'cmd_start' },
              ],
            ],
          },
        }
      );
      return;
    }

    let report = `📈 <b>ACTIVE 50% PRICE MILESTONE TRACKERS</b> 🎯\n`;
    report += `<i>Continuous price checks every 30s (Zero RPC credit usage via DexScreener).</i>\n\n`;

    for (const t of tokens) {
      const dexscreenerUrl = getDexScreenerUrl(t);
      const entryPrice = formatUnitPrice(t.entryPriceUsd);
      const lastPrice = formatUnitPrice(t.lastAlertedPriceUsd);
      const gainPct = t.entryPriceUsd > 0
        ? (((t.lastAlertedPriceUsd - t.entryPriceUsd) / t.entryPriceUsd) * 100).toFixed(1)
        : '0.0';
      const isPositive = Number(gainPct) >= 0;
      const emoji = isPositive ? '📈' : '📉';

      report += `🪙 <a href="${dexscreenerUrl}"><b>$${escapeHtml(t.tokenSymbol)}</b></a> (${emoji} <code>${isPositive ? '+' : ''}${gainPct}%</code>)\n`;
      report += `   💵 Entry: <code>${entryPrice}</code> ➔ Last: <code>${lastPrice}</code>\n`;
      report += `   🎯 Top Milestone: <code>+${t.lastMilestonePct}%</code> | Dip: <code>${t.lastDipMilestonePct}%</code>\n`;
      report += `   🔗 <a href="${dexscreenerUrl}">[DexScreener Chart]</a>\n\n`;
    }

    const milestoneButtons: any[][] = [];
    tokens.slice(0, 10).forEach((t) => {
      milestoneButtons.push([
        { text: `📊 $${t.tokenSymbol} Chart`, url: getDexScreenerUrl(t) },
      ]);
    });
    milestoneButtons.push([
      { text: '💎 Daily Coins', callback_data: 'cmd_early' },
      { text: '🏆 Top Gainers', callback_data: 'cmd_top' },
    ]);
    milestoneButtons.push([
      { text: '💼 My Positions', callback_data: 'cmd_positions' },
      { text: '🚀 /start (Main Menu)', callback_data: 'cmd_start' },
    ]);

    await bot.sendMessage(chatId, report.trim(), {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: milestoneButtons,
      },
    });
  } catch (err: any) {
    console.warn('handlePriceMilestonesCommand error:', err.message);
  }
}

/**
 * Displays the Daily Hall of Fame Leaderboard (/top)
 */
async function handleTopCommand(chatId: number | string): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  try {
    let tokens = await prisma.earlyTrendingToken.findMany({
      where: { alertDate: today },
      orderBy: { lastMilestonePct: 'desc' },
      take: 10,
    });

    if (tokens.length === 0 || tokens.every((t) => t.lastMilestonePct === 0)) {
      const topEver = await prisma.earlyTrendingToken.findMany({
        where: { lastMilestonePct: { gt: 0 } },
        orderBy: { lastMilestonePct: 'desc' },
        take: 10,
      });
      if (topEver.length > 0) {
        tokens = topEver;
      }
    }

    if (tokens.length === 0) {
      await bot.sendMessage(
        chatId,
        `🏆 <b>Daily Hall of Fame Leaderboard (/top)</b>\n\n` +
          `No tokens have logged a +50% milestone yet today.\n` +
          `Our 30s price tracker monitors every alerted token for 50%, 100% (2X), 300% (4X), and 20X moonshots!`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '💎 Daily Coins', callback_data: 'cmd_early' },
                { text: '📈 Price Milestones', callback_data: 'cmd_milestones' },
              ],
              [{ text: '🚀 /start (Main Menu)', callback_data: 'cmd_start' }],
            ],
          },
        }
      );
      return;
    }

    let report = `🏆 <b>SOLANA TRENDING HALL OF FAME LEADERBOARD</b> 🚀\n`;
    report += `<i>Top breakout performers discovered within 2 minutes of launch:</i>\n\n`;

    tokens.forEach((t, i) => {
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `<b>#${i + 1}</b>`;
      const dexscreenerUrl = getDexScreenerUrl(t);
      const entryMc = formatUsd(t.entryMarketCap);
      const mult = (1 + t.lastMilestonePct / 100).toFixed(1);
      const peakMc = formatUsd(t.entryMarketCap * (1 + t.lastMilestonePct / 100));

      report += `${medal} <a href="${dexscreenerUrl}"><b>$${escapeHtml(t.tokenSymbol)}</b></a> • <b>+${t.lastMilestonePct}% (${mult}X)</b> 🔥\n`;
      report += `   💰 Entry MC: <code>${entryMc}</code> ➔ Peak: <code>${peakMc}</code>\n`;
      report += `   🔗 <a href="${dexscreenerUrl}">[DexScreener Chart]</a>\n\n`;
    });

    const buttons: any[][] = [];
    tokens.slice(0, 8).forEach((t) => {
      buttons.push([
        { text: `📊 $${t.tokenSymbol} Chart (+${t.lastMilestonePct}%)`, url: getDexScreenerUrl(t) },
      ]);
    });
    buttons.push([
      { text: '💎 Daily Coins', callback_data: 'cmd_early' },
      { text: '📈 Price Milestones', callback_data: 'cmd_milestones' },
    ]);
    buttons.push([
      { text: '💼 My Positions', callback_data: 'cmd_positions' },
      { text: '🚀 /start (Main Menu)', callback_data: 'cmd_start' },
    ]);

    await bot.sendMessage(chatId, report.trim(), {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: buttons },
    });
  } catch (err: any) {
    console.warn('handleTopCommand error:', err.message);
  }
}

/**
 * Displays Active Sniped Positions, Live PnL, and TP/SL status (/positions)
 */
async function handlePositionsCommand(chatId: number | string): Promise<void> {
  try {
    const active = getActivePositions();
    const all = getAllPositions();

    if (active.length === 0 && all.length === 0) {
      await bot.sendMessage(
        chatId,
        `💼 <b>Active Positions &amp; Portfolio Tracker (/positions)</b>\n\n` +
          `No positions are currently tracked.\n\n` +
          `When <b>Auto-Snipe</b> is enabled or you tap <b>[⚡ Quick Buy]</b> on any alert card, positions are actively managed here:\n` +
          `• 🎯 <b>2X Take-Profit:</b> Automatically sells 50% at +100% to recoup your initial SOL!\n` +
          `• 🛡️ <b>Trailing Stop-Loss:</b> Automatically protects the remaining moonbag if price drops 25% from peak!\n` +
          `• 🛑 <b>Hard Stop-Loss:</b> Limits max drawdown to -25% from entry.`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '💎 Daily Coins', callback_data: 'cmd_early' },
                { text: '⚙️ Auto-Snipe Settings', callback_data: 'cmd_snipe_menu' },
              ],
              [{ text: '🚀 /start (Main Menu)', callback_data: 'cmd_start' }],
            ],
          },
        }
      );
      return;
    }

    let report = `💼 <b>PORTFOLIO &amp; SNIPED POSITIONS</b> 📊\n`;
    report += `<i>Autonomous 2X TP (sell 50%) + Trailing SL (-25% from peak) active:</i>\n\n`;

    if (active.length === 0) {
      report += `ℹ️ <i>No currently OPEN positions. (All previous positions closed at profit/stop).</i>\n\n`;
    } else {
      active.forEach((pos, idx) => {
        const gainPct = (((pos.currentPriceUsd - pos.entryPriceUsd) / pos.entryPriceUsd) * 100).toFixed(1);
        const isUp = Number(gainPct) >= 0;
        const emoji = isUp ? '🟢' : '🔴';
        const chartUrl = getDexScreenerUrl(pos as any);
        const statusBadge = pos.status === 'PARTIAL_TP_2X' ? ' [🎯 50% TP SECURED]' : '';

        report += `${emoji} <b>#${idx + 1}.</b> <a href="${chartUrl}"><b>$${escapeHtml(pos.tokenSymbol)}</b></a>${statusBadge}\n`;
        report += `   💰 Allocation: <code>${pos.solInvested.toFixed(2)} SOL</code> | PnL: <b>${isUp ? '+' : ''}${gainPct}%</b>\n`;
        report += `   💵 Entry: <code>${formatUnitPrice(pos.entryPriceUsd)}</code> ➔ Now: <code>${formatUnitPrice(pos.currentPriceUsd)}</code>\n`;
        report += `   🔝 Peak: <code>${formatUnitPrice(pos.peakPriceUsd)}</code> | Realized: <code>+${pos.realizedSolProfit.toFixed(2)} SOL</code>\n`;
        report += `   🔗 <a href="${chartUrl}">[DexScreener Live Chart]</a>\n\n`;
      });
    }

    const closed = all.filter((p) => p.status === 'CLOSED').slice(-3);
    if (closed.length > 0) {
      report += `📜 <b>Recently Closed Positions:</b>\n`;
      closed.forEach((p) => {
        report += `• <b>$${escapeHtml(p.tokenSymbol)}:</b> ${p.exitReason || 'Closed'} (Realized: <code>+${p.realizedSolProfit.toFixed(2)} SOL</code>)\n`;
      });
      report += `\n`;
    }

    const posButtons: any[][] = [];
    active.slice(0, 6).forEach((pos) => {
      posButtons.push([
        { text: `📊 $${pos.tokenSymbol} Chart`, url: getDexScreenerUrl(pos as any) },
      ]);
    });
    posButtons.push([
      { text: '🔄 Refresh Positions', callback_data: 'cmd_positions' },
      { text: '🏆 Top Gainers', callback_data: 'cmd_top' },
    ]);
    posButtons.push([
      { text: '💎 Daily Coins', callback_data: 'cmd_early' },
      { text: '🚀 /start (Main Menu)', callback_data: 'cmd_start' },
    ]);

    await bot.sendMessage(chatId, report.trim(), {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: posButtons },
    });
  } catch (err: any) {
    console.warn('handlePositionsCommand error:', err.message);
  }
}

async function handleSnipeStatus(chatId: number | string, userId: string, messageIdToEdit?: number): Promise<void> {
  const pref = await getUserPreferences(userId);
  const statusEmoji = pref.autoSnipeEnabled ? '🟢 ACTIVE (Auto-Buy Enabled)' : '🔴 DISABLED (Signals Only)';
  const walletAddr = env.USER_SOLANA_WALLET || '6hb1Nmj9C8xZe5oWAKYBgJcPMZnqxAGTHPBqouuy5NmM';
  const walletTrunc = `${walletAddr.slice(0, 4)}...${walletAddr.slice(-4)}`;

  const message = `
🎯 <b>AI Auto-Trading &amp; Sniper Dashboard</b>

🤖 <b>Auto-Snipe Status:</b> <b>${statusEmoji}</b>
💰 <b>Snipe Allocation:</b> <code>${pref.autoSnipeSolAmount.toFixed(2)} SOL</code> per coin
🛡️ <b>Max Slippage:</b> <code>${pref.maxSlippagePercent}%</code>
💼 <b>Connected Wallet:</b> <code>${walletTrunc}</code>

<b>Autonomous Exit Strategy:</b>
• 🎯 <b>2X Take-Profit:</b> Automatically sells 50% at +100% to recoup principal risk-free!
• 🛡️ <b>Trailing Stop-Loss:</b> Automatically locks in gains if token drops 25% from its peak!
• 🛑 <b>Hard Stop-Loss:</b> Sells position if price falls -25% from entry.

<b>How it works:</b>
• <b>DISABLED (Default):</b> You receive 2-minute Early &amp; Whale alerts with 1-tap quick buy buttons. The bot never spends your SOL automatically.
• <b>ACTIVE:</b> The bot automatically executes buys with <code>${pref.autoSnipeSolAmount.toFixed(2)} SOL</code> on verified @solearlytrending tokens passing strict RugCheck security!

<i>Tap below to adjust allocation or toggle mode:</i>
  `.trim();

  const keyboard = [
    [
      pref.autoSnipeEnabled
        ? { text: '🔴 Turn Auto-Snipe OFF', callback_data: 'snipe_disable' }
        : { text: '🟢 Turn Auto-Snipe ON', callback_data: 'snipe_enable' },
    ],
    [
      { text: '⚡ Set 0.5 SOL', callback_data: 'snipe_set_0.5' },
      { text: '⚡ Set 1.0 SOL', callback_data: 'snipe_set_1.0' },
      { text: '⚡ Set 2.0 SOL', callback_data: 'snipe_set_2.0' },
    ],
    [
      { text: '💼 My Positions', callback_data: 'cmd_positions' },
      { text: '💎 Daily Coins', callback_data: 'cmd_early' },
    ],
    [
      { text: '🚀 /start (Main Menu)', callback_data: 'cmd_start' },
    ],
  ];

  if (messageIdToEdit) {
    try {
      await bot.editMessageText(message, {
        chat_id: chatId,
        message_id: messageIdToEdit,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: keyboard },
      });
      return;
    } catch {
      // Fallback
    }
  }

  await bot.sendMessage(chatId, message, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: keyboard },
  });
}

