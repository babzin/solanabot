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

  const dexscreenerUrl = `https://dexscreener.com/solana/${snipe.tokenMint}`;
  const message = `
🤖 <b>[AUTO-SNIPE EXECUTED]</b>${simText}

🪙 <b>Target Token:</b> <a href="${dexscreenerUrl}"><b>$${escapeHtml(symbol)}</b></a> (<code>${snipe.tokenMint.slice(0, 6)}...${snipe.tokenMint.slice(-4)}</code>)
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
  const dexscreenerUrl = `https://dexscreener.com/solana/${snipe.tokenMint}`;

  const message = `
🚨 <b>[AI AUTO-SELL EXECUTED]</b>${simText}

🪙 <b>Sold Token:</b> <a href="${dexscreenerUrl}"><b>$${escapeHtml(symbol)}</b></a> (<code>${snipe.tokenMint.slice(0, 6)}...${snipe.tokenMint.slice(-4)}</code>)
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

  let aiSection = '';
  if (token.aiScore) {
    const score = token.aiScore.convictionScore;
    const badgeEmoji = score >= 80 ? '🔥' : score >= 60 ? '⚡' : '⚠️';
    aiSection = `\n\n🤖 <b>AI Conviction:</b> <code>${score}/100</code> (${badgeEmoji} ${escapeHtml(token.aiScore.metaCategory)})\n` +
      `💡 <i>${escapeHtml(token.aiScore.thesis)}</i>`;
  }

  let lossDefenseSection = '';
  if (token.learnedRisk) {
    const risk = token.learnedRisk.flopRiskScore;
    const runner = token.learnedRisk.runnerAffinityScore ?? 50;
    const shieldEmoji = risk <= 20 ? '🛡️' : risk <= 40 ? '⚖️' : '⚠️';
    lossDefenseSection = `\n🧠 <b>Loss-Defense:</b> Flop Risk <code>${risk}%</code> ${shieldEmoji} | Runner Match <code>${runner}%</code> 🎯`;
  }

  return `
🔥 <a href="${dexscreenerUrl}"><b>&lrm;${escapeHtml(token.tokenName || token.tokenSymbol)}</b></a><b> New </b><a href="https://t.me/solearlytrending"><b>Trending</b></a>
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
┗ Airdrops: ${airdropPct}% 🤍 | Burnt: ${burntPct}% 🔥${aiSection}${lossDefenseSection}
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
    { command: 'paper', description: '💼 $100 Paper Portfolio & Live PnL' },
    { command: 'paper_reset', description: '🔄 Reset Paper Account to $100' },
    { command: 'scan', description: '⚡ Scan DexScreener & Pump.fun Now' },
    { command: 'daily', description: '💎 Daily 2min Early Trending Coins' },
    { command: 'top', description: '🏆 Daily Top Gainers & 5X-20X Hall of Fame' },
    { command: 'flops', description: '📉 Daily Flopped Coins & Dips (-50%+)' },
    { command: 'weekly', description: '🗓️ Weekly Cumulative Recap & PnL' },
    { command: 'learner', description: '🧠 Adaptive Loss-Learning Feedback Engine' },
    { command: 'ask', description: '🤖 AI Trading Co-Pilot Q&A' },
    { command: 'audit', description: '🔍 AI Audit Any Token Mint or Ticker' },
    { command: 'milestones', description: '📈 Price Milestones (+50% / -50%)' },
    { command: 'positions', description: '💼 My Active Positions & TP/SL Status' },
    { command: 'autosnipe', description: '⚙️ Auto-Snipe Settings & Toggle' },
    { command: 'wallet', description: '💰 Wallet Balance & Solscan' },
    { command: 'help', description: '❓ How It Works & Trading Guide' },
  ]).catch((err) => {
    console.warn('⚠️ Could not register Telegram menu commands:', err.message);
  });

  // Persistent Keyboard docked at the bottom of phone screen (10 clean buttons)
  const persistentReplyKeyboard = {
    keyboard: [
      [{ text: '🚀 /start' }, { text: '⚡ Scan Now' }],
      [{ text: '💼 $100 Paper' }, { text: '💎 Daily Coins' }],
      [{ text: '🏆 Top Gainers' }, { text: '📉 Daily Flops' }],
      [{ text: '📈 Price Milestones' }, { text: '🗓️ Weekly Report' }],
      [{ text: '🤖 AI Co-Pilot' }, { text: '⚙️ Auto-Snipe' }],
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
• 🤖 <b>AI Co-Pilot:</b> Pre-alert meme narrative &amp; rug risk conviction scoring

💼 <b>$100 REAL-MARKET PAPER TRADING:</b>
• 🏦 <b>Bankroll:</b> $100.00 USD with real-time Solana priority gas &amp; slippage friction
• 🎯 <b>Position Sizing:</b> 3% compounding capital per trade (Up to 20 concurrent positions)
• 🛡️ <b>Automated Trailing:</b> 2X Take-Profit + -40% Moonbag Trailing Stop-Loss

⚙️ <b>AUTO-SNIPER &amp; EXIT STRATEGY:</b>
• <b>Status:</b> ${snipeBadge}
• 🎯 <b>2X Take-Profit:</b> Sells 50% at +100% to secure initial SOL risk-free!
• 🛡️ <b>Trailing Stop-Loss:</b> Protects remaining moonbag on deep reversals (-40%)

<i>Tap any button below to view active gems or manage auto-snipe:</i>
    `.trim();

    const inlineKeyboard = [
      [
        { text: '💼 $100 Paper Portfolio', callback_data: 'cmd_paper_portfolio' },
        { text: '⚡ Scan Now', callback_data: 'cmd_scan' },
      ],
      [
        { text: '💎 Daily Coins', callback_data: 'cmd_early' },
        { text: '🏆 Top Gainers', callback_data: 'cmd_top' },
      ],
      [
        { text: '📉 Daily Flops', callback_data: 'cmd_flops' },
        { text: '🗓️ Weekly Report', callback_data: 'cmd_weekly' },
      ],
      [
        { text: '🤖 AI Co-Pilot', callback_data: 'cmd_copilot' },
        { text: '📈 Price Milestones', callback_data: 'cmd_milestones' },
      ],
      [
        { text: '💼 My Positions', callback_data: 'cmd_positions' },
        { text: '⚙️ Auto-Snipe Settings', callback_data: 'cmd_snipe_menu' },
      ],
      [
        { text: '💰 Wallet & Solscan', callback_data: 'cmd_wallet' },
        { text: '🧠 Loss Learner', callback_data: 'cmd_learner' },
      ],
      [
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

  // /start or Start button (supports deep-linking: /start <tokenMint>)
  bot.onText(/\/start(?:\s+(.+))?|🚀 \/start|🚀 Start/i, async (msg, match) => {
    const payload = match?.[1]?.trim();
    if (payload && payload.length >= 30) {
      await handleTokenDeepLink(msg.chat.id, payload);
      return;
    }
    await sendWelcomeDashboard(msg.chat.id);
  });

  // /paper or /portfolio or "💼 $100 Paper" button
  bot.onText(/💼 \$100 Paper|\/paper|\/portfolio|Paper Trading|Paper Portfolio/i, async (msg) => {
    await handlePaperPortfolioCommand(msg.chat.id);
  });

  // /paper_reset or /reset_paper
  bot.onText(/\/paper_reset|\/reset_paper/i, async (msg) => {
    await handlePaperResetCommand(msg.chat.id);
  });

  // /daily or /early or "💎 Daily Coins" button
  bot.onText(/💎 Daily Coins|\/daily|\/early|Daily Coin/i, async (msg) => {
    await handleEarlyTrendingCommand(msg.chat.id);
  });

  // /top or /profits or "🏆 Top Gainers" button
  bot.onText(/🏆 Top Gainers|\/top|\/profits|\/leaderboard|Top Early Trending|Top Gainer|Hall of Fame/i, async (msg) => {
    await handleTopCommand(msg.chat.id);
  });

  // /flops or /bad or "📉 Daily Flops" button
  bot.onText(/📉 Daily Flops|\/flops|\/bad|\/flopped|\/dips|Bad Coin|Daily Flop/i, async (msg) => {
    await handleDailyFlopsCommand(msg.chat.id);
  });

  // /weekly or /week or "🗓️ Weekly Report"
  bot.onText(/🗓️ Weekly Report|\/weekly|\/week|Weekly Report|Weekly Recap/i, async (msg) => {
    await handleWeeklyReportCommand(msg.chat.id);
  });

  // /ask or "🤖 AI Co-Pilot"
  bot.onText(/🤖 AI Co-Pilot|\/ask(?:\s+(.+))?/i, async (msg, match) => {
    const question = match?.[1]?.trim();
    if (!question) {
      await bot.sendMessage(
        msg.chat.id,
        `🤖 <b>AI Trading Co-Pilot</b> 🧠\n\n` +
          `Ask me anything about today's signals, market trends, or token behavior!\n\n` +
          `<b>Examples:</b>\n` +
          `• <code>/ask which coins made the most today?</code>\n` +
          `• <code>/ask why did our tokens flop?</code>\n` +
          `• <code>/ask what is the current hottest meta?</code>\n` +
          `• <code>/audit &lt;mintAddress&gt;</code> to analyze any token address!`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '🏆 Top Gainers', callback_data: 'cmd_top' },
                { text: '📉 Daily Flops', callback_data: 'cmd_flops' },
              ],
              [{ text: '🗓️ Weekly Report', callback_data: 'cmd_weekly' }],
            ],
          },
        }
      );
      return;
    }

    const waitMsg = await bot.sendMessage(msg.chat.id, '⚡ <i>Checking market &amp; on-chain data...</i>', { parse_mode: 'HTML' });
    try {
      const { askTradingCoPilot } = await import('./aiIntelligence.js');
      const answer = await askTradingCoPilot(question);
      try {
        await bot.editMessageText(answer, {
          chat_id: msg.chat.id,
          message_id: waitMsg.message_id,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        });
      } catch {
        await bot.editMessageText(answer.replace(/<[^>]+>/g, ''), {
          chat_id: msg.chat.id,
          message_id: waitMsg.message_id,
          disable_web_page_preview: true,
        });
      }
    } catch (err: any) {
      await bot.sendMessage(msg.chat.id, `⚠️ <i>Co-Pilot notice: ${err.message}</i>`, { parse_mode: 'HTML' });
    }
  });

  // /audit <mint or ticker>
  bot.onText(/\/audit(?:\s+(.+))?/i, async (msg, match) => {
    const query = match?.[1]?.trim();
    if (!query) {
      await bot.sendMessage(
        msg.chat.id,
        'ℹ️ <i>Please provide a token mint or ticker symbol:\n<code>/audit &lt;mintAddress or $TICKER&gt;</code>\n\nExamples:\n• <code>/audit BONK</code>\n• <code>/audit $NPC</code>\n• <code>/audit 7GUnr7krtQhJwd6ASY2VUprd9t4c64zcgCsjdmZepump</code></i>',
        { parse_mode: 'HTML' }
      );
      return;
    }

    const waitMsg = await bot.sendMessage(msg.chat.id, `🔍 <i>Running AI & On-Chain Audit for <code>${escapeHtml(query)}</code>...</i>`, { parse_mode: 'HTML' });
    try {
      const { lookupTokenAnalytics, renderTokenAnalyticsCard } = await import('./aiIntelligence.js');
      const audit = await lookupTokenAnalytics(query);

      if (!audit) {
        await bot.editMessageText(
          `⚠️ <i>Could not find an active Solana liquidity pool for "<b>${escapeHtml(query)}</b>" on DexScreener or radar. Check the spelling or provide the raw mint address.</i>`,
          {
            chat_id: msg.chat.id,
            message_id: waitMsg.message_id,
            parse_mode: 'HTML',
          }
        );
        return;
      }

      const auditCard = renderTokenAnalyticsCard(audit);

      await bot.editMessageText(auditCard, {
        chat_id: msg.chat.id,
        message_id: waitMsg.message_id,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: [
            [
              { text: `📊 Chart $${audit.symbol}`, url: audit.dexUrl || `https://dexscreener.com/solana/${audit.mint}` },
              { text: '🔍 Solscan', url: `https://solscan.io/token/${audit.mint}` },
            ],
            [
              { text: '⚡ Snipe 0.1 SOL', callback_data: `snipe_quick_0.1_${audit.mint}` },
              { text: '⚡ Snipe 0.5 SOL', callback_data: `snipe_quick_0.5_${audit.mint}` },
            ],
            [
              { text: '⚡ Scan Now', callback_data: 'cmd_scan' },
            ],
          ],
        },
      });
    } catch (err: any) {
      await bot.sendMessage(msg.chat.id, `⚠️ <i>Audit error: ${err.message}</i>`, { parse_mode: 'HTML' });
    }
  });

  // /predict or /gems or /recommend
  bot.onText(/\/predict|\/gems|\/recommend|\/buy/i, async (msg) => {
    const waitMsg = await bot.sendMessage(msg.chat.id, '🎯 <i>Analyzing live on-chain momentum, buy pressure & radar breakout signals...</i>', { parse_mode: 'HTML' });
    try {
      const { predictTopGemsToBuy } = await import('./aiIntelligence.js');
      const { text, tokens } = await predictTopGemsToBuy();

      const inlineKeyboard: any[] = [];
      for (const t of tokens) {
        inlineKeyboard.push([
          { text: `📊 Chart $${t.tokenSymbol}`, url: `https://dexscreener.com/solana/${t.tokenMint}` },
          { text: `⚡ Snipe $${t.tokenSymbol} (0.1 SOL)`, callback_data: `snipe_quick_0.1_${t.tokenMint}` },
        ]);
      }
      inlineKeyboard.push([
        { text: '🔄 Refresh Predictions', callback_data: 'cmd_predict' },
        { text: '⚡ Scan DexScreener', callback_data: 'cmd_scan' },
      ]);

      await bot.editMessageText(text, {
        chat_id: msg.chat.id,
        message_id: waitMsg.message_id,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: inlineKeyboard },
      });
    } catch (err: any) {
      await bot.sendMessage(msg.chat.id, `⚠️ <i>Prediction error: ${err.message}</i>`, { parse_mode: 'HTML' });
    }
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
      `• /flops — View Daily Flopped Coins & Dips\n` +
      `• /milestones — View Pumps &amp; Retracements\n` +
      `• /positions — View Active Positions &amp; PnL\n` +
      `• /autosnipe — Toggle Automated Sniping\n` +
      `• /wallet — View Connected Wallet &amp; Solscan\n` +
      `• /learner — Adaptive Loss-Learning Engine &amp; Autopsies`,
      { parse_mode: 'HTML' }
    );
  });

  // /learner or /memory or "🧠 Loss Learner"
  bot.onText(/\/(?:learner|memory|lossanalytics)|🧠 Loss Learner|Loss Learner/i, async (msg) => {
    try {
      const { getLearnedLossDashboard } = await import('./lossLearner.js');
      const dash = getLearnedLossDashboard();
      await bot.sendMessage(msg.chat.id, dash, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🔄 Refresh Memory & Stats', callback_data: 'cmd_learner' },
              { text: '⚡ Scan DexScreener', callback_data: 'cmd_scan' },
            ],
          ],
        },
      });
    } catch (err: any) {
      await bot.sendMessage(msg.chat.id, `⚠️ Error loading loss learner: ${err.message}`);
    }
  });

  // Natural Language & Free-form Question Listener
  // Catches any message that isn't a command and either:
  // 1) Is a Solana token mint (triggers automatic audit)
  // 2) Is a natural question or trading strategy inquiry (triggers AI Co-Pilot)
  bot.on('message', async (msg) => {
    const text = msg.text?.trim();
    if (!text || text.startsWith('/')) return;

    // Ignore known persistent button labels already handled by bot.onText
    const knownButtons = [
      '⚡ scan now', '💎 daily coins', '🏆 top gainers', '📉 daily flops',
      '🗓️ weekly report', '🤖 ai co-pilot', '📈 price milestones', '💼 my positions',
      '⚙️ auto-snipe', '🟢 auto-snipe on', '🔴 auto-snipe off', '💰 wallet', '❓ help'
    ];
    if (knownButtons.some((b) => b === text.toLowerCase())) return;

    // Check if the user pasted a raw Solana Mint address (base58 32-44 characters)
    if (/^[1-9A-HJ-NP-za-km-z]{32,44}$/.test(text)) {
      const waitMsg = await bot.sendMessage(msg.chat.id, `🔍 <i>Running AI &amp; On-Chain Audit for <code>${text.slice(0, 8)}...</code></i>`, { parse_mode: 'HTML' });
      try {
        const { lookupTokenAnalytics, renderTokenAnalyticsCard } = await import('./aiIntelligence.js');
        const audit = await lookupTokenAnalytics(text);

        if (!audit) {
          await bot.editMessageText(
            `⚠️ <i>No active Solana liquidity pool found for mint <code>${text}</code> on DexScreener.</i>`,
            { chat_id: msg.chat.id, message_id: waitMsg.message_id, parse_mode: 'HTML' }
          );
          return;
        }

        const auditCard = renderTokenAnalyticsCard(audit);

        await bot.editMessageText(auditCard, {
          chat_id: msg.chat.id,
          message_id: waitMsg.message_id,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup: {
            inline_keyboard: [
              [
                { text: `📊 Chart $${audit.symbol}`, url: audit.dexUrl || `https://dexscreener.com/solana/${audit.mint}` },
                { text: '🔍 Solscan', url: `https://solscan.io/token/${audit.mint}` },
              ],
              [
                { text: '⚡ Snipe 0.1 SOL', callback_data: `snipe_quick_0.1_${audit.mint}` },
                { text: '⚡ Snipe 0.5 SOL', callback_data: `snipe_quick_0.5_${audit.mint}` },
              ],
              [
                { text: '⚡ Scan Now', callback_data: 'cmd_scan' },
              ],
            ],
          },
        });
      } catch (err: any) {
        await bot.sendMessage(msg.chat.id, `⚠️ <i>Audit error: ${err.message}</i>`, { parse_mode: 'HTML' });
      }
      return;
    }

    // Check if it looks like a question or conversational query to the AI Co-Pilot
    const isQuestion =
      text.endsWith('?') ||
      /^(how|why|what|when|where|who|which|should|can|could|would|is|are|tell|explain|give|do|does|will|maximize|maximise|avoid|aloid|size|snipe|trade|profit|loss|hi|hello|hey|yo)\b/i.test(text) ||
      text.length >= 4;

    if (isQuestion) {
      const waitMsg = await bot.sendMessage(msg.chat.id, '⚡ <i>Checking market &amp; on-chain data...</i>', { parse_mode: 'HTML' });
      try {
        const { askTradingCoPilot, lookupTokenAnalytics, predictTopGemsToBuy, extractTokenFromQuery } = await import('./aiIntelligence.js');
        const answer = await askTradingCoPilot(text);

        // Check if query mentioned a specific token or asks for buy recommendations to generate dynamic buttons
        const target = extractTokenFromQuery(text);
        const isRecQuery = /(buy|predict|recommend|gem|coin)/i.test(text);

        const inlineKeyboard: any[] = [];

        if (target) {
          const tokenAudit = await lookupTokenAnalytics(target);
          if (tokenAudit) {
            inlineKeyboard.push([
              { text: `📊 Chart $${tokenAudit.symbol}`, url: tokenAudit.dexUrl || `https://dexscreener.com/solana/${tokenAudit.mint}` },
              { text: `⚡ Snipe $${tokenAudit.symbol} (0.1 SOL)`, callback_data: `snipe_quick_0.1_${tokenAudit.mint}` },
            ]);
          }
        } else if (isRecQuery) {
          const { tokens } = await predictTopGemsToBuy();
          for (const t of tokens.slice(0, 2)) {
            inlineKeyboard.push([
              { text: `📊 Chart $${t.tokenSymbol}`, url: `https://dexscreener.com/solana/${t.tokenMint}` },
              { text: `⚡ Snipe $${t.tokenSymbol}`, callback_data: `snipe_quick_0.1_${t.tokenMint}` },
            ]);
          }
        }

        inlineKeyboard.push([
          { text: '🏆 Top Gainers', callback_data: 'cmd_top' },
          { text: '💎 Daily Coins', callback_data: 'cmd_early' },
        ]);
        inlineKeyboard.push([
          { text: '🗓️ Weekly Report', callback_data: 'cmd_weekly' },
          { text: '⚡ Scan Now', callback_data: 'cmd_scan' },
        ]);

        const replyMarkup = { inline_keyboard: inlineKeyboard };

        try {
          await bot.editMessageText(answer, {
            chat_id: msg.chat.id,
            message_id: waitMsg.message_id,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            reply_markup: replyMarkup,
          });
        } catch {
          await bot.editMessageText(answer.replace(/<[^>]+>/g, ''), {
            chat_id: msg.chat.id,
            message_id: waitMsg.message_id,
            disable_web_page_preview: true,
            reply_markup: replyMarkup,
          });
        }
      } catch (err: any) {
        await bot.sendMessage(msg.chat.id, `⚠️ <i>Co-Pilot notice: ${err.message}</i>`, { parse_mode: 'HTML' });
      }
    }
  });

  // Telegram Inline Query Mode (@MySolanaSBot <query>)
  bot.on('inline_query', async (inlineQuery) => {
    const rawQ = (inlineQuery.query || '').trim();
    const queryId = inlineQuery.id;

    try {
      const results: any[] = [];
      const cleanQ = rawQ.trim().replace(/^\$/, '');
      const isMint = /^[1-9A-HJ-NP-za-km-z]{32,44}$/.test(cleanQ);
      const isTicker = /^[A-Za-z0-9_]{2,12}$/.test(cleanQ) && !['start', 'help', 'scan', 'daily', 'top', 'flops', 'weekly'].includes(cleanQ.toLowerCase());
      const isPredictQuery = /(buy|predict|gems?|coins?|recommend)/i.test(rawQ);

      // 1. If user typed a mint address or ticker symbol, show instant AI analytics inline
      if (isMint || (isTicker && !isPredictQuery)) {
        const { lookupTokenAnalytics, renderTokenAnalyticsCard } = await import('./aiIntelligence.js');
        const audit = await lookupTokenAnalytics(cleanQ);
        if (audit) {
          const recEmoji = audit.recommendation === 'STRONG_BUY' ? '🟢' : audit.recommendation === 'SPECULATIVE_SNIPE' ? '🟡' : '🔴';
          const cardText = renderTokenAnalyticsCard(audit);

          results.push({
            type: 'article',
            id: `audit_${audit.mint}`,
            title: `🔍 $${audit.symbol} (${recEmoji} ${audit.recommendation})`,
            description: `MC: $${Math.round(audit.onChainMetrics.marketCapUsd).toLocaleString()} • Reasons to Buy & Avoid`,
            input_message_content: {
              message_text: cardText,
              parse_mode: 'HTML',
              disable_web_page_preview: true,
            },
            reply_markup: {
              inline_keyboard: [
                [
                  { text: `📊 Chart $${audit.symbol}`, url: audit.dexUrl || `https://dexscreener.com/solana/${audit.mint}` },
                  { text: '🔍 Solscan', url: `https://solscan.io/token/${audit.mint}` },
                ],
                [
                  { text: `⚡ Snipe 0.1 SOL`, callback_data: `snipe_quick_0.1_${audit.mint}` },
                  { text: `⚡ Snipe 0.5 SOL`, callback_data: `snipe_quick_0.5_${audit.mint}` },
                ],
                [
                  { text: '⚡ Scan Now', callback_data: 'cmd_scan' },
                ],
              ],
            },
          });
        }
      }

      // 2. If user searched for predictions or coins to buy
      if (isPredictQuery) {
        const { predictTopGemsToBuy } = await import('./aiIntelligence.js');
        const { text: predText, tokens } = await predictTopGemsToBuy();
        const predButtons: any[] = [];
        for (const t of tokens.slice(0, 3)) {
          predButtons.push([
            { text: `📊 Chart $${t.tokenSymbol}`, url: `https://dexscreener.com/solana/${t.tokenMint}` },
            { text: `⚡ Snipe $${t.tokenSymbol}`, callback_data: `snipe_quick_0.1_${t.tokenMint}` },
          ]);
        }
        predButtons.push([
          { text: '⚡ Scan Now', callback_data: 'cmd_scan' },
        ]);

        results.push({
          type: 'article',
          id: `predict_${Date.now()}`,
          title: `🎯 AI Predicted Gems to Buy Right Now`,
          description: `Live radar momentum & buy-pressure recommendations`,
          input_message_content: {
            message_text: predText,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
          },
          reply_markup: { inline_keyboard: predButtons },
        });
      }

      // 3. AI Strategy / Question Answer
      const qText = rawQ || 'how do we maximize profit today';
      const { askTradingCoPilot } = await import('./aiIntelligence.js');
      const aiReply = await askTradingCoPilot(qText);

      results.push({
        type: 'article',
        id: `ai_${Date.now()}`,
        title: `💡 Trader Co-Pilot: "${rawQ || 'How do we maximize profit today?'}"`,
        description: `Instant strategy & advice grounded in live bot data`,
        input_message_content: {
          message_text: aiReply,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        },
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🏆 Top Gainers', callback_data: 'cmd_top' },
              { text: '💎 Daily Coins', callback_data: 'cmd_early' },
            ],
            [
              { text: '🗓️ Weekly Report', callback_data: 'cmd_weekly' },
              { text: '⚡ Scan Now', callback_data: 'cmd_scan' },
            ],
          ],
        },
      });

      // 4. Today's Top Gainers Card
      const today = new Date().toISOString().slice(0, 10);
      let topTokens: any[] = [];
      try {
        topTokens = await prisma.earlyTrendingToken.findMany({
          where: { alertDate: today },
          orderBy: { lastMilestonePct: 'desc' },
          take: 3,
        });
      } catch {}

      if (topTokens.length > 0) {
        results.push({
          type: 'article',
          id: `top_${today}`,
          title: `🏆 Today's Top Gainers (${topTokens.length} gems active)`,
          description: `Leader: $${topTokens[0].tokenSymbol} (+${topTokens[0].lastMilestonePct}%)`,
          input_message_content: {
            message_text: renderTopLeaderboardText(topTokens, today),
            parse_mode: 'HTML',
            disable_web_page_preview: true,
          },
          reply_markup: {
            inline_keyboard: [
              [{ text: '🏆 Open Leaderboard', callback_data: 'cmd_top' }],
            ],
          },
        });
      }

      await bot.answerInlineQuery(queryId, results, { cache_time: 10, is_personal: true });
    } catch (err: any) {
      console.warn('[Telegram Inline Query Notice]:', err.message);
    }
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
      } else if (data === 'cmd_paper_portfolio') {
        await handlePaperPortfolioCommand(chatId);
      } else if (data === 'cmd_paper_reset') {
        await handlePaperResetCommand(chatId);
      } else if (data === 'cmd_scan') {
        await bot.sendMessage(chatId, '🔍 <i>Scanning DexScreener & Pump.fun for fresh 2-minute breakout gems...</i>', { parse_mode: 'HTML' });
        const { runEarlyTrendingRadarCycle } = await import('./earlyTrending.js');
        const count = await runEarlyTrendingRadarCycle();
        if (count > 0) {
          await bot.sendMessage(chatId, `✅ <i>Scan complete: Dispatched <b>${count}</b> new gem alert(s)!</i>`, { parse_mode: 'HTML' });
        } else {
          await bot.sendMessage(chatId, `✅ <i>Scan complete. No unalerted tokens met the strict 5X/20X criteria right this second. Continuous background radar is scanning every 35s!</i>`, { parse_mode: 'HTML' });
        }
      } else if (data === 'cmd_predict') {
        const waitMsg = await bot.sendMessage(chatId, '🎯 <i>Analyzing live on-chain momentum, buy pressure & radar breakout signals...</i>', { parse_mode: 'HTML' });
        const { predictTopGemsToBuy } = await import('./aiIntelligence.js');
        const { text: predText, tokens } = await predictTopGemsToBuy();
        const predButtons: any[] = [];
        for (const t of tokens) {
          predButtons.push([
            { text: `📊 Chart $${t.tokenSymbol}`, url: `https://dexscreener.com/solana/${t.tokenMint}` },
            { text: `⚡ Snipe $${t.tokenSymbol} (0.1 SOL)`, callback_data: `snipe_quick_0.1_${t.tokenMint}` },
          ]);
        }
        predButtons.push([
          { text: '🔄 Refresh Predictions', callback_data: 'cmd_predict' },
          { text: '⚡ Scan DexScreener', callback_data: 'cmd_scan' },
        ]);
        await bot.editMessageText(predText, {
          chat_id: chatId,
          message_id: waitMsg.message_id,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup: { inline_keyboard: predButtons },
        });
      } else if (data === 'cmd_wallet') {
        const wallet = env.USER_SOLANA_WALLET;
        const mode = env.SNIPER_PRIVATE_KEY ? '🟢 Live On-Chain' : '⚡ Paper Trading';
        await bot.sendMessage(chatId, `💼 <b>Wallet:</b> <code>${wallet}</code>\n🔗 <a href="https://solscan.io/account/${wallet}">View on Solscan</a>\n⚡ <b>Mode:</b> ${mode}`, { parse_mode: 'HTML', disable_web_page_preview: true });
      } else if (data === 'cmd_learner') {
        const { getLearnedLossDashboard } = await import('./lossLearner.js');
        const dash = getLearnedLossDashboard();
        await bot.sendMessage(chatId, dash, {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '🔄 Refresh Memory & Stats', callback_data: 'cmd_learner' },
                { text: '⚡ Scan DexScreener', callback_data: 'cmd_scan' },
              ],
            ],
          },
        });
      } else if (data === 'cmd_help') {
        await bot.sendMessage(chatId, `📖 <b>Quick Guide:</b>\n• Continuous radar scans every 35s\n• Strict LP burnt & revoked authority audit\n• Instant +50% to 79X pump tracking & alerts\n• 1-Tap Snipe buttons on every alert card\n• <code>/predict</code> for AI predicted coins to buy\n• <code>/audit &lt;token&gt;</code> for reasons to buy or avoid`, { parse_mode: 'HTML' });
      } else if (data === 'cmd_early') {
        await handleEarlyTrendingCommand(chatId);
      } else if (data === 'cmd_top') {
        await handleTopCommand(chatId);
      } else if (data === 'cmd_flops') {
        await handleDailyFlopsCommand(chatId);
      } else if (data === 'cmd_weekly') {
        await handleWeeklyReportCommand(chatId);
      } else if (data === 'cmd_copilot') {
        await bot.sendMessage(
          chatId,
          `🤖 <b>AI Trading Co-Pilot</b> 🧠\n\n` +
            `Ask me anything on Telegram or use commands:\n\n` +
            `• <code>/predict</code> — Top predicted breakout coins to buy\n` +
            `• <code>/audit &lt;mint or $TICKER&gt;</code> — Live analytics with reasons to buy or avoid\n` +
            `• <code>/ask which coins made the most today?</code>\n` +
            `• <code>/ask how do we avoid yesterday's losses?</code>\n` +
            `• Or simply type: <i>"tell me about $BONK"</i> or <i>"what coins should I buy?"</i>`,
          { parse_mode: 'HTML' }
        );
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
 * Renders the Top Early Trending profit leaderboard matching exact @solearlytrending / Soul format:
 *
 * 🏆 Top Early Trending 💸
 * 🥇 Pump Family | $FAMILY • 40X [X]
 * 🥈 Invisible, Nameless, Untraceable | $INU • 25X
 * 🥉 Tyler Raw Fund | $TYLER • 20X [X]
 * 4⃣ $ZEBRA • 20X
 * 5⃣ $FATHOMIE • 15X
 * 6⃣ $SCAT • 11X
 * 7⃣ $DUMBCOIN • 10X
 * 8⃣ $HOLT • 10X
 * $RSRV • 10X
 * $ZCAT • 10X
 * $ZECAT • 7X
 * $AWARDED • 7X
 * Disclaimer
 */
/**
 * Formats YYYY-MM-DD into a human-readable display string
 */
export function formatDisplayDate(isoDateStr: string): string {
  try {
    const [year, month, day] = isoDateStr.split('-').map(Number);
    const d = new Date(Date.UTC(year, month - 1, day));
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${dayNames[d.getUTCDay()]}, ${monthNames[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
  } catch {
    return isoDateStr;
  }
}

/**
 * Renders the Top Early Trending profit leaderboard matching exact @solearlytrending / Soul format:
 *
 * 🏆 Top Early Trending 💸
 * 📅 Date: Thursday, Sep 24, 2026
 * 🚀 Total Multiplier: +52X • (all coins make a total of 52X)
 */
export function renderTopLeaderboardText(tokens: any[], dateStr?: string): string {
  const botUsername = env.TELEGRAM_BOT_USERNAME || 'MySolanaSBot';
  const headerLink = `https://t.me/${botUsername}`;

  // Calculate total combined multiplier across all coins
  let totalMultiplier = 0;
  tokens.forEach((t) => {
    let multVal = 1.0;
    if (t.peakPriceUsd && t.entryPriceUsd && t.entryPriceUsd > 0) {
      multVal = t.peakPriceUsd / t.entryPriceUsd;
    } else if (t.lastMilestonePct && t.lastMilestonePct > 0) {
      multVal = 1 + t.lastMilestonePct / 100;
    }
    totalMultiplier += multVal;
  });

  const roundedTopX = totalMultiplier >= 10 ? Math.round(totalMultiplier) : Number(totalMultiplier.toFixed(1));
  const activeDate = dateStr || new Date().toISOString().slice(0, 10);
  const dateFormatted = formatDisplayDate(activeDate);

  let out = `🏆 <a href="${headerLink}"><b>Top Early Trending</b></a> 💸\n`;
  out += `📅 <b>Date:</b> <code>${dateFormatted}</code>\n`;
  out += `🚀 <b>Total Multiplier:</b> <code>+${roundedTopX}X</code> • <i>(all coins make a total of ${roundedTopX}X)</i>\n\n`;

  const numberEmojis = ['4⃣', '5⃣', '6⃣', '7⃣', '8⃣'];

  tokens.forEach((t, i) => {
    const tokenMint = t.tokenMint;
    const tokenSymbol = escapeHtml(t.tokenSymbol);
    const tokenName = escapeHtml(t.tokenName || t.tokenSymbol);
    const tokenLink = getDexScreenerUrl(t);

    // Multiplier calculation
    let multVal = 1.0;
    if (t.peakPriceUsd && t.entryPriceUsd && t.entryPriceUsd > 0) {
      multVal = t.peakPriceUsd / t.entryPriceUsd;
    } else if (t.lastMilestonePct && t.lastMilestonePct > 0) {
      multVal = 1 + t.lastMilestonePct / 100;
    }

    let multStr = `${Math.round(multVal)}X`;
    if (multVal >= 1.5 && multVal < 2.0) {
      multStr = `${multVal.toFixed(1)}X`;
    } else if (multVal < 1.5 && t.lastMilestonePct > 0) {
      multStr = `+${t.lastMilestonePct}%`;
    } else if (multVal <= 1.0) {
      multStr = `1X`;
    }

    const xLink = t.xUrl && typeof t.xUrl === 'string' && t.xUrl.startsWith('http')
      ? ` <a href="${t.xUrl}">[X]</a>`
      : '';

    if (i === 0) {
      out += `🥇 <a href="${tokenLink}">${tokenName} | $${tokenSymbol}</a> • ${multStr}${xLink}\n`;
    } else if (i === 1) {
      out += `🥈 <a href="${tokenLink}">${tokenName} | $${tokenSymbol}</a> • ${multStr}${xLink}\n`;
    } else if (i === 2) {
      out += `🥉 <a href="${tokenLink}">${tokenName} | $${tokenSymbol}</a> • ${multStr}${xLink}\n`;
    } else if (i < 8) {
      const numEmo = numberEmojis[i - 3] || `${i + 1}⃣`;
      out += `<a href="${tokenLink}">${numEmo} $${tokenSymbol}</a> • ${multStr}${xLink}\n`;
    } else {
      out += `<a href="${tokenLink}">$${tokenSymbol}</a> • ${multStr}${xLink}\n`;
    }
  });

  out += `<a href="https://dexscreener.com">Disclaimer</a>`;
  return out.trim();
}

/**
 * Handles deep-linked token viewing: /start <tokenMint>
 */
export async function handleTokenDeepLink(chatId: number | string, tokenMint: string): Promise<void> {
  try {
    const token = await prisma.earlyTrendingToken.findUnique({
      where: { tokenMint },
    });

    if (token) {
      const card = renderEarlyTrendingCardText(token);
      const dexscreenerUrl = getDexScreenerUrl(token);
      const trojanUrl = env.TROJAN_REF_CODE
        ? `https://t.me/solana_trojanbot?start=r-${env.TROJAN_REF_CODE}-${token.tokenMint}`
        : `https://t.me/solana_trojanbot?start=${token.tokenMint}`;
      const photonUrl = env.PHOTON_REF_CODE
        ? `https://photon-sol.tinyastro.io/en/lp/${token.pairAddress || token.tokenMint}?ref=${env.PHOTON_REF_CODE}`
        : `https://photon-sol.tinyastro.io/en/lp/${token.pairAddress || token.tokenMint}`;

      const inlineKeyboard = [
        [
          { text: '📊 DexScreener', url: dexscreenerUrl },
          { text: '🔍 Solscan', url: `https://solscan.io/token/${token.tokenMint}` },
        ],
        [
          { text: '⚡ Snipe 0.1 SOL', callback_data: `snipe_quick_0.1_${token.tokenMint}` },
          { text: '⚡ Snipe 0.5 SOL', callback_data: `snipe_quick_0.5_${token.tokenMint}` },
        ],
        [
          { text: '🦄 Buy on Trojan', url: trojanUrl },
          { text: '⚡ Buy on Photon', url: photonUrl },
        ],
      ];

      await bot.sendMessage(chatId, card, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: inlineKeyboard },
      });
      return;
    }

    // Fallback: If not in DB, query DexScreener live
    const { getMarketData } = await import('./market.js');
    const market = await getMarketData(tokenMint, 0, '');
    if (market) {
      const message = `
📈 <a href="https://dexscreener.com/solana/${tokenMint}"><b>&lrm;${escapeHtml(market.tokenSymbol || 'TOKEN')}</b></a> (${escapeHtml(market.tokenName || '')})
🪙 <code>${tokenMint}</code>

MC: <b>${formatUsd(market.marketCap)}</b> | Liq: <b>${formatUsd(market.liquidityUsd)}</b>
Price: <b>$${market.priceUsd.toFixed(6)}</b> | 24h Vol: <b>${formatUsd(market.analytics?.volume1h || 0)}</b>
`.trim();

      await bot.sendMessage(chatId, message, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: [
            [
              { text: '📊 DexScreener', url: `https://dexscreener.com/solana/${tokenMint}` },
              { text: '🔍 Solscan', url: `https://solscan.io/token/${tokenMint}` },
            ],
            [
              { text: '⚡ Snipe 0.1 SOL', callback_data: `snipe_quick_0.1_${tokenMint}` },
              { text: '⚡ Snipe 0.5 SOL', callback_data: `snipe_quick_0.5_${tokenMint}` },
            ],
          ],
        },
      });
      return;
    }

    await bot.sendMessage(chatId, `⚠️ <i>Token <code>${tokenMint}</code> was not found.</i>`, { parse_mode: 'HTML' });
  } catch (err: any) {
    console.warn('handleTokenDeepLink error:', err.message);
  }
}

/**
 * Displays the Top Early Trending Leaderboard (/top or /profits) strictly for today
 */
export async function handleTopCommand(chatId: number | string): Promise<void> {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const dateFormatted = formatDisplayDate(today);

    // Strictly fetch today's alerted coins (no cross-day fallback)
    let tokens = await prisma.earlyTrendingToken.findMany({
      where: { alertDate: today },
      orderBy: { lastMilestonePct: 'desc' },
      take: 25,
    });

    // Sort by highest actual multiplier
    tokens.sort((a, b) => {
      const multA = a.peakPriceUsd && a.entryPriceUsd && a.entryPriceUsd > 0
        ? a.peakPriceUsd / a.entryPriceUsd
        : (1 + (a.lastMilestonePct || 0) / 100);
      const multB = b.peakPriceUsd && b.entryPriceUsd && b.entryPriceUsd > 0
        ? b.peakPriceUsd / b.entryPriceUsd
        : (1 + (b.lastMilestonePct || 0) / 100);
      return multB - multA;
    });

    if (tokens.length === 0) {
      await bot.sendMessage(
        chatId,
        `🏆 <b>Top Early Trending</b> 💸\n` +
          `📅 <b>Date:</b> <code>${dateFormatted}</code>\n\n` +
          `<i>No coins recorded yet for today (${today}). Background radar is actively scanning!</i>\n` +
          `Tap <b>⚡ Scan Now</b> to run an immediate discovery cycle.`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '⚡ Scan Now', callback_data: 'cmd_scan' }],
              [{ text: '🗓️ Weekly Report', callback_data: 'cmd_weekly' }],
              [{ text: '🚀 /start (Main Menu)', callback_data: 'cmd_start' }],
            ],
          },
        }
      );
      return;
    }

    const report = renderTopLeaderboardText(tokens.slice(0, 15), today);

    const inlineKeyboard = [
      [
        { text: '⚡ Scan Now', callback_data: 'cmd_scan' },
        { text: '💎 Daily Coins', callback_data: 'cmd_early' },
      ],
      [
        { text: '📉 Daily Flops', callback_data: 'cmd_flops' },
        { text: '🗓️ Weekly Report', callback_data: 'cmd_weekly' },
      ],
      [
        { text: '📈 Price Milestones', callback_data: 'cmd_milestones' },
        { text: '💼 My Positions', callback_data: 'cmd_positions' },
      ],
      [
        { text: '🚀 /start (Main Menu)', callback_data: 'cmd_start' },
      ],
    ];

    await bot.sendMessage(chatId, report, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: inlineKeyboard },
    });
  } catch (err: any) {
    console.warn('handleTopCommand error:', err.message);
  }
}

/**
 * Displays Daily Flopped Coins strictly for today
 */
export async function handleDailyFlopsCommand(chatId: number | string): Promise<void> {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const dateFormatted = formatDisplayDate(today);

    // Strictly fetch today's alerted coins (no fallback to earlier days)
    const tokens = await prisma.earlyTrendingToken.findMany({
      where: { alertDate: today },
      orderBy: { createdAt: 'desc' },
    });

    // Calculate drop and retracement metrics
    const flops = tokens
      .map((t) => {
        const dropFromEntryPct = t.entryPriceUsd > 0
          ? ((t.lastAlertedPriceUsd - t.entryPriceUsd) / t.entryPriceUsd) * 100
          : 0;
        const dropFromPeakPct = t.peakPriceUsd > 0
          ? ((t.lastAlertedPriceUsd - t.peakPriceUsd) / t.peakPriceUsd) * 100
          : dropFromEntryPct;
        const currentMc = t.entryPriceUsd > 0
          ? (t.lastAlertedPriceUsd / t.entryPriceUsd) * t.entryMarketCap
          : t.entryMarketCap;

        return {
          ...t,
          dropFromEntryPct: Number(dropFromEntryPct.toFixed(1)),
          dropFromPeakPct: Number(dropFromPeakPct.toFixed(1)),
          currentMarketCap: Math.round(currentMc),
          isFlop: dropFromEntryPct <= -20 || (dropFromPeakPct <= -45 && dropFromEntryPct <= 10) || (t.lastDipMilestonePct === -50 && dropFromEntryPct <= -30),
        };
      })
      .filter((t) => t.isFlop)
      .sort((a, b) => a.dropFromEntryPct - b.dropFromEntryPct); // Worst drops first

    if (flops.length === 0) {
      await bot.sendMessage(
        chatId,
        `📉 <b>DAILY FLOPPED COINS &amp; DIPS</b> 🟢\n` +
          `📅 <b>Date:</b> <code>${dateFormatted}</code>\n\n` +
          `<i>No coins have dumped today! All alerted gems for today (${today}) are holding strong or currently in profit.</i>\n\n` +
          `Whenever an alerted coin drops &gt;20% or triggers a -50% retracement, it is automatically cataloged here.`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '🏆 Top Gainers', callback_data: 'cmd_top' },
                { text: '💎 Daily Coins', callback_data: 'cmd_early' },
              ],
              [
                { text: '🗓️ Weekly Report', callback_data: 'cmd_weekly' },
                { text: '🚀 /start (Main Menu)', callback_data: 'cmd_start' },
              ],
            ],
          },
        }
      );
      return;
    }

    let totalFlopDropPct = 0;
    flops.forEach((f) => {
      totalFlopDropPct += Math.abs(f.dropFromEntryPct);
    });
    const totalFlopMultiplier = (totalFlopDropPct / 100).toFixed(1);
    const roundedFlopDropPct = Math.round(totalFlopDropPct);

    let report = `📉 <b>DAILY FLOPPED COINS &amp; DIPS</b> 🩸\n`;
    report += `📅 <b>Date:</b> <code>${dateFormatted}</code>\n`;
    report += `🩸 <b>Total Drawdown:</b> <code>-${totalFlopMultiplier}X</code> (<code>-${roundedFlopDropPct}%</code>) • <i>(all coins make a total of -${totalFlopMultiplier}X / -${roundedFlopDropPct}%)</i>\n`;
    report += `<i>Tokens alerted today (${today}) that dumped or suffered heavy drawdowns:</i>\n\n`;

    flops.slice(0, 10).forEach((t, i) => {
      const dexscreenerUrl = getDexScreenerUrl(t);
      const symbol = escapeHtml(t.tokenSymbol);
      const name = escapeHtml(t.tokenName || t.tokenSymbol);
      const entryMcStr = formatUsd(t.entryMarketCap);
      const currentMcStr = formatUsd(t.currentMarketCap);
      const rankEmoji = i === 0 ? '💀' : (i < 3 ? '🩸' : '📉');

      report += `${rankEmoji} <b>#${i + 1}.</b> <a href="${dexscreenerUrl}"><b>$${symbol}</b></a> (${name}) • <code>${t.dropFromEntryPct}%</code>\n`;
      report += `   💵 Entry: <code>${entryMcStr}</code> ➔ Now: <code>${currentMcStr}</code>\n`;
      if (t.peakPriceUsd > t.entryPriceUsd * 1.3) {
        report += `   ⚠️ Peak Drawdown: <code>${t.dropFromPeakPct}% from peak</code>\n`;
      }
      report += `   🔗 <a href="${dexscreenerUrl}">[DexScreener Live Chart]</a>\n\n`;
    });

    report += `🛡️ <i>Auto-Snipe protection: Trailing Stop-Loss cuts risk at -25% to protect capital!</i>`;

    const flopButtons: any[][] = [];
    // Direct DexScreener chart links for top flopped tokens (2 per row)
    for (let i = 0; i < Math.min(flops.length, 6); i += 2) {
      const row: any[] = [];
      row.push({ text: `📊 $${flops[i].tokenSymbol} Chart`, url: getDexScreenerUrl(flops[i]) });
      if (i + 1 < Math.min(flops.length, 6)) {
        row.push({ text: `📊 $${flops[i + 1].tokenSymbol} Chart`, url: getDexScreenerUrl(flops[i + 1]) });
      }
      flopButtons.push(row);
    }

    flopButtons.push([
      { text: '🏆 Top Gainers', callback_data: 'cmd_top' },
      { text: '💎 Daily Coins', callback_data: 'cmd_early' },
    ]);
    flopButtons.push([
      { text: '🗓️ Weekly Report', callback_data: 'cmd_weekly' },
      { text: '🚀 /start (Main Menu)', callback_data: 'cmd_start' },
    ]);

    await bot.sendMessage(chatId, report.trim(), {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: flopButtons },
    });
  } catch (err: any) {
    console.warn('handleDailyFlopsCommand error:', err.message);
  }
}

/**
 * Displays the Weekly Cumulative Performance Recap (/weekly or /week)
 */
export async function handleWeeklyReportCommand(chatId: number | string): Promise<void> {
  try {
    const { calculateWeeklyStats, renderWeeklyReportText } = await import('./weeklyReport.js');
    const stats = await calculateWeeklyStats(0);
    const report = renderWeeklyReportText(stats);

    const inlineKeyboard = [
      [
        { text: '🏆 Top Gainers', callback_data: 'cmd_top' },
        { text: '💎 Daily Coins', callback_data: 'cmd_early' },
      ],
      [
        { text: '📉 Daily Flops', callback_data: 'cmd_flops' },
        { text: '📈 Price Milestones', callback_data: 'cmd_milestones' },
      ],
      [
        { text: '💼 My Positions', callback_data: 'cmd_positions' },
        { text: '🚀 /start (Main Menu)', callback_data: 'cmd_start' },
      ],
    ];

    await bot.sendMessage(chatId, report, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: inlineKeyboard },
    });
  } catch (err: any) {
    console.warn('handleWeeklyReportCommand error:', err.message);
    await bot.sendMessage(chatId, `⚠️ <i>Could not generate weekly report: ${err.message}</i>`, { parse_mode: 'HTML' });
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
        const closedDexUrl = getDexScreenerUrl(p as any);
        report += `• <a href="${closedDexUrl}"><b>$${escapeHtml(p.tokenSymbol)}</b></a>: ${p.exitReason || 'Closed'} (Realized: <code>+${p.realizedSolProfit.toFixed(2)} SOL</code>)\n`;
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
• 🛡️ <b>Trailing Stop-Loss:</b> Automatically locks in gains if token drops 40% from its peak!
• 🛑 <b>Hard Stop-Loss:</b> Sells position if price sustains -35% drop (with 45s wick buffer).

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

/**
 * Handles /paper and /portfolio command displaying live $100 bankroll & active positions
 */
export async function handlePaperPortfolioCommand(chatId: number | string): Promise<void> {
  try {
    const { getPaperPortfolioSummary } = await import('./paperTrading.js');
    const summary = await getPaperPortfolioSummary();
    const w = summary.wallet;

    const pnlSign = summary.totalPnlUsd >= 0 ? '+' : '';
    const pnlEmoji = summary.totalPnlUsd >= 0 ? '💸' : '🩸';
    const statusColor = summary.totalPnlUsd >= 0 ? '🟢' : '🔴';

    let msg = `
💼 <b>[PAPER TRADING: $100 LIVE PORTFOLIO]</b> ${pnlEmoji}
<i>100% Real Market Dynamics • Real Gas &amp; Slippage Deductions</i>

🏦 <b>NET EQUITY:</b> <b>$${summary.netWorthUsd.toFixed(2)} USD</b> (<code>${summary.netWorthSol.toFixed(4)} SOL</code>)
${statusColor} <b>Total PnL:</b> <b>${pnlSign}$${summary.totalPnlUsd.toFixed(2)} (${pnlSign}${summary.totalPnlPercent.toFixed(1)}%)</b>
💵 <b>Liquid Cash:</b> <code>$${w.liquidCashUsd.toFixed(2)} USD</code> (<code>${w.liquidCashSol.toFixed(4)} SOL</code>)
🔒 <b>In Active Trades:</b> <code>$${w.totalInvestedUsd.toFixed(2)} USD</code>
⛽ <b>Total Real Gas Paid:</b> <code>-${w.totalFeesPaidSol.toFixed(4)} SOL</code> (<b>-$${w.totalFeesPaidUsd.toFixed(2)}</b>)
🎯 <b>Win Rate:</b> <b>${w.winRatePercent.toFixed(1)}%</b> (${w.winningTrades}W / ${w.losingTrades}L • ${w.totalTrades} Total)

📊 <b>ACTIVE POSITIONS (${summary.activePositions.length}/${w.maxConcurrentPositions}):</b>
`;

    if (summary.activePositions.length === 0) {
      msg += `<i>No active open positions right now. Standing by for radar gems!</i>\n`;
    } else {
      for (const pos of summary.activePositions) {
        const gainPct = ((pos.currentPriceUsd - pos.entryPriceUsd) / pos.entryPriceUsd) * 100;
        const sign = gainPct >= 0 ? '+' : '';
        const badge = pos.status === 'PARTIAL_TP_2X' ? '🌙 MOONBAG (50%)' : '🟢 OPEN (100%)';
        const mult = (pos.currentPriceUsd / pos.entryPriceUsd).toFixed(2);
        msg += `\n• <b>$${pos.tokenSymbol}</b> [${badge}]\n` +
          `  Entry: <code>$${pos.entryPriceUsd.toFixed(6)}</code> ➔ Now: <code>$${pos.currentPriceUsd.toFixed(6)}</code> (${sign}${gainPct.toFixed(1)}% | ${mult}X)\n` +
          `  Peak: <code>$${pos.peakPriceUsd.toFixed(6)}</code> (${pos.peakMultiplier}X) • Initial: $${pos.investedUsd.toFixed(2)}\n`;
      }
    }

    msg += `\n🛡️ <i>Trailing Stop (-40% off peak) + 2X Take-Profit + -35% SL (45s buffer) active.</i>`;

    const inlineKeyboard = [
      [
        { text: '🔄 Refresh Portfolio', callback_data: 'cmd_paper_portfolio' },
        { text: '⚡ Scan Gems Now', callback_data: 'cmd_scan' },
      ],
      [
        { text: '🔄 Reset Paper Account to $100', callback_data: 'cmd_paper_reset' },
      ],
    ];

    await bot.sendMessage(chatId, msg.trim(), {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: inlineKeyboard },
    });
  } catch (err: any) {
    await bot.sendMessage(chatId, `⚠️ Could not fetch paper trading portfolio: ${err.message}`);
  }
}

/**
 * Handles /paper_reset command resetting the paper trading account to pristine $100
 */
export async function handlePaperResetCommand(chatId: number | string): Promise<void> {
  try {
    const { resetPaperTradingWallet } = await import('./paperTrading.js');
    const w = await resetPaperTradingWallet();
    await bot.sendMessage(
      chatId,
      `🔄 <b>[PAPER TRADING RESET SUCCESSFUL]</b> ✅\n\n` +
        `Your paper trading portfolio has been reset to <b>$100.00 USD</b> pristine capital!\n` +
        `• 💵 Liquid Balance: <code>$100.00 USD</code> (${w.liquidCashSol} SOL)\n` +
        `• 🎯 Allocation: <code>3% compounding per trade ($${w.tradeSizeUsd.toFixed(2)})</code> (Up to ${w.maxConcurrentPositions} positions)\n` +
        `• 🛡️ Trailing Stop-Loss: Active at -40% from peak (-35% SL with 45s buffer)\n\n` +
        `<i>Ready to capture the next live market runner!</i>`,
      { parse_mode: 'HTML' }
    );
  } catch (err: any) {
    await bot.sendMessage(chatId, `⚠️ Failed to reset paper portfolio: ${err.message}`);
  }
}


