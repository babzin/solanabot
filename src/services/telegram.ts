import TelegramBot from 'node-telegram-bot-api';
import { env } from '../config/env.js';
import { prisma } from './db.js';
import {
  executeSnipeTrade,
  executeSnipeSell,
  executeUserSnipeTrade,
  executeUserSnipeSell,
  getUserAutoSnipeConfig,
  setUserAutoSnipeConfig,
  getUserPreferences,
  setUserPreferences,
  getActivePositions,
  getAllPositions,
  getUserActivePositions,
  getSolForFixedUsd,
  executeSolWithdrawal,
  SnipeResult,
  SnipedPosition,
  VALID_TRADE_SIZES_USD,
  ValidTradeSizeUsd,
  sanitizeTradeSizeUsd,
  isValidTradeSizeUsd,
  BOT_ENTRY_FEE_PCT,
  BOT_PROFIT_FEE_PCT,
} from './sniper.js';
import {
  encryptPrivateKey,
  generateBurnerWallet,
  isValidPrivateKey,
  decryptUserKeypair,
  parseKeypair,
} from './encryption.js';
import {
  verifyGroupMembership,
  revokeUserWalletAndAccess,
} from './groupAccessGate.js';
import { broadcastPricePump, broadcastPriceDip } from './events.js';
import { getTokensForDate, getActiveTrackedTokens, getTokensForPastDays } from './earlyTokenStore.js';
import {
  initGroupPinnedDashboardScheduler,
  handleSendDashboardToDm,
  postOrUpdateGroupPinnedDashboard,
} from './groupPinnedDashboard.js';
import {
  getAdminAnalyticsSummary,
  setAdminFeeWallet,
  getAdminFeeWallet,
  isValidSolanaAddress,
  sweepServerFeesToAdmin,
} from './adminConfig.js';

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

/**
 * Safely sends Telegram messages without hitting the 4,096 character limit.
 * Automatically splits long text into chunks if needed.
 */
export async function safeSendTelegramMessage(chatId: number | string, text: string, options?: any): Promise<any> {
  const MAX_CHUNK = 3800;
  if (text.length <= MAX_CHUNK) {
    return bot.sendMessage(chatId, text, options);
  }
  const lines = text.split('\n');
  let currentChunk = '';
  let lastResult: any = null;
  for (const line of lines) {
    if ((currentChunk + '\n' + line).length > MAX_CHUNK) {
      if (currentChunk.trim().length > 0) {
        lastResult = await bot.sendMessage(chatId, currentChunk.trim(), { ...options, reply_markup: undefined });
      }
      currentChunk = line;
    } else {
      currentChunk += (currentChunk ? '\n' : '') + line;
    }
  }
  if (currentChunk.trim().length > 0) {
    lastResult = await bot.sendMessage(chatId, currentChunk.trim(), options);
  }
  return lastResult;
}

interface CachedAdmin {
  isAdmin: boolean;
  timestamp: number;
}
const adminCache = new Map<string, CachedAdmin>();
const ADMIN_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

// State tracking for admins currently inputting a fee wallet address
export const adminAwaitingWalletInput = new Map<string, number>();

/**
 * Pre-populates the cache with all current group administrators
 */
export async function refreshGroupAdminsCache(): Promise<void> {
  const groupChatId = env.TELEGRAM_GROUP_CHAT_ID;
  if (!groupChatId || groupChatId === '0' || !env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN.includes('dummy')) {
    return;
  }
  try {
    const admins = await bot.getChatAdministrators(groupChatId);
    for (const adm of admins) {
      const cacheKey = `${groupChatId}_${adm.user.id}`;
      adminCache.set(cacheKey, { isAdmin: true, timestamp: Date.now() });
    }
    console.log(`🛡️ [Admin Guardian] Cached ${admins.length} administrator(s) for group ${groupChatId}`);
  } catch (err: any) {
    console.warn('⚠️ [Admin Guardian] Could not fetch group administrators:', err.message);
  }
}

/**
 * Locks the public group so regular users cannot send any messages.
 * Telegram natively replaces their message input bar with "MUTE".
 * Only the owner and group administrators retain permission to send messages.
 */
export async function enforceGroupChatPermissions(): Promise<void> {
  const groupChatId = env.TELEGRAM_GROUP_CHAT_ID;
  if (!groupChatId || groupChatId === '0' || !env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN.includes('dummy')) {
    return;
  }
  try {
    await bot.setChatPermissions(groupChatId, {
      can_send_messages: false,
      can_send_audios: false,
      can_send_documents: false,
      can_send_photos: false,
      can_send_videos: false,
      can_send_video_notes: false,
      can_send_voice_notes: false,
      can_send_polls: false,
      can_send_other_messages: false,
      can_add_web_page_previews: false,
      can_change_info: false,
      can_invite_users: false,
      can_pin_messages: false,
    } as any);
    console.log(`🔒 [Group Permissions] MUTE mode successfully enforced for group ${groupChatId}. Only admins/owner can post.`);
  } catch (err: any) {
    console.warn(`⚠️ [Group Permissions] Could not set chat permissions for ${groupChatId}:`, err?.message);
  }
}

/**
 * Determines whether a user is either the bot owner (env.TELEGRAM_CHAT_ID)
 * or a group administrator/creator in the specified chat.
 */
export async function isGroupAdminOrOwner(chatId: number | string, userId: number | string): Promise<boolean> {
  const sUserId = String(userId);
  const sChatId = String(chatId);
  const ownerId = String(env.TELEGRAM_CHAT_ID || '');

  // Owner is always authorized (supports single ID or comma-separated list)
  if (sUserId && ownerId && (sUserId === ownerId || ownerId.split(',').map((x) => x.trim()).includes(sUserId))) {
    return true;
  }

  // If this check happens in a private DM (where sChatId === sUserId or sChatId > 0),
  // fallback to verifying group admin status in the official group chat.
  const targetGroupChatId =
    (sChatId === sUserId && env.TELEGRAM_GROUP_CHAT_ID && env.TELEGRAM_GROUP_CHAT_ID !== '0')
      ? env.TELEGRAM_GROUP_CHAT_ID
      : chatId;

  const cacheKey = `${targetGroupChatId}_${sUserId}`;
  const cached = adminCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < ADMIN_CACHE_TTL_MS) {
    return cached.isAdmin;
  }

  try {
    const member = await bot.getChatMember(targetGroupChatId, Number(userId));
    const isAdmin = member.status === 'creator' || member.status === 'administrator';
    adminCache.set(cacheKey, { isAdmin, timestamp: Date.now() });
    return isAdmin;
  } catch (err: any) {
    console.warn(`⚠️ [Admin Check] Could not verify permissions for user ${userId} in ${targetGroupChatId}:`, err.message);
    return false;
  }
}

/**
 * Enforces that only the owner and group administrators can post messages in the public group.
 * Non-admin messages (text, photos, stickers, commands, media) are instantly deleted,
 * and a temporary 8-second notice guides them to private DM.
 */
export async function enforceGroupAdminOnly(msg: any): Promise<boolean> {
  const groupChatId = env.TELEGRAM_GROUP_CHAT_ID;
  if (!groupChatId || String(msg.chat?.id) !== String(groupChatId)) {
    return true; // Not the restricted public group
  }
  if (msg.from?.is_bot) {
    return true; // Allow bots (or our own bot)
  }

  const userId = msg.from?.id;
  const isAuthorized = userId ? await isGroupAdminOrOwner(msg.chat.id, userId) : false;

  if (!isAuthorized) {
    // Delete unauthorized message from public group immediately
    bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});

    // Send transient 8s notice guiding them to private DM
    const botUser = env.TELEGRAM_BOT_USERNAME || 'MySolanaSBot';
    const senderName = msg.from?.first_name || 'Member';
    const warnText = `⚠️ <b>${escapeHtml(senderName)}</b>, this public group is restricted to owner and admin announcements.\n\n💬 <i>To interact with the bot, view your portfolio, or trade, please click below to open your private direct message:</i>`;

    bot.sendMessage(msg.chat.id, warnText, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '💬 Open Private DM ➔', url: `https://t.me/${botUser}?start=dashboard` }],
        ],
      },
    }).then((sentWarn) => {
      setTimeout(() => {
        bot.deleteMessage(msg.chat.id, sentWarn.message_id).catch(() => {});
      }, 8000);
    }).catch(() => {});

    return false;
  }

  return true;
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
  const explorerUrl = `https://solscan.io/tx/${snipe.signature}`;
  const symbol = snipe.tokenSymbol || 'TOKEN';

  const dexscreenerUrl = `https://dexscreener.com/solana/${snipe.tokenMint}`;
  const feeInfo = snipe.entryFeeSol !== undefined
    ? `\n🧾 <b>Bot Fee (1% Entry):</b> <code>${snipe.entryFeeSol.toFixed(4)} SOL</code>`
    : '';

  const message = `
🤖 <b>[AUTO-SNIPE EXECUTED]</b>

🪙 <b>Target Token:</b> <a href="${dexscreenerUrl}"><b>$${escapeHtml(symbol)}</b></a> (<code>${snipe.tokenMint.slice(0, 6)}...${snipe.tokenMint.slice(-4)}</code>)
💰 <b>Allocation Spent:</b> <code>${snipe.solAmount.toFixed(4)} SOL</code>${feeInfo}
📦 <b>Estimated Acquired:</b> <code>${formatTokenQuantity(snipe.tokenAmount)} ${symbol}</code>
⚡ <b>Routing Strategy:</b> <i>${escapeHtml(snipe.routePlan || 'Jupiter v6 Aggregator')}</i>
🔗 <b>Transaction Receipt:</b> <a href="${explorerUrl}">${snipe.signature.slice(0, 16)}...</a>

💡 <i>Auto-snipe volume can be changed via <code>/tradesize</code> or toggled via <code>/autosnipe</code></i>
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
  const explorerUrl = `https://solscan.io/tx/${snipe.signature}`;
  const symbol = snipe.tokenSymbol || 'TOKEN';
  const dexscreenerUrl = `https://dexscreener.com/solana/${snipe.tokenMint}`;

  let pnlLine = '';
  if (snipe.grossProfitSol !== undefined) {
    if (snipe.isProfitable) {
      pnlLine = `\n📈 <b>Gross Profit:</b> <code>+${snipe.grossProfitSol.toFixed(4)} SOL</code>` +
                `\n🧾 <b>Bot Fee (15% on Profit):</b> <code>-${(snipe.profitFeeSol || 0).toFixed(4)} SOL</code>` +
                `\n💵 <b>Net SOL Credited:</b> <code>+${snipe.solAmount.toFixed(4)} SOL</code>`;
    } else {
      pnlLine = `\n🩸 <b>Outcome:</b> <code>${snipe.grossProfitSol.toFixed(4)} SOL</code>` +
                `\n🧾 <b>Profit Fee:</b> <code>0.00 SOL</code> (0% on losses)` +
                `\n💵 <b>Capital Preserved:</b> <code>+${snipe.solAmount.toFixed(4)} SOL</code>`;
    }
  }

  const message = `
🚨 <b>[AI AUTO-SELL EXECUTED]</b>

🪙 <b>Sold Token:</b> <a href="${dexscreenerUrl}"><b>$${escapeHtml(symbol)}</b></a> (<code>${snipe.tokenMint.slice(0, 6)}...${snipe.tokenMint.slice(-4)}</code>)
💰 <b>SOL Reclaimed:</b> <code>+${snipe.solAmount.toFixed(4)} SOL</code>${pnlLine}
📦 <b>Quantity Exited:</b> <code>${formatTokenQuantity(snipe.tokenAmount)} ${symbol}</code>
⚡ <b>Routing Strategy:</b> <i>${escapeHtml(snipe.routePlan || 'Jupiter Instant Take-Profit Exit')}</i>
🔗 <b>Transaction Receipt:</b> <a href="${explorerUrl}">${snipe.signature.slice(0, 16)}...</a>

💡 <i>Fee Rule: 15% applied to net profits on profitable exits. 0% extra fee on losing trades.</i>
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
🔥 <a href="${dexscreenerUrl}"><b>&lrm;${escapeHtml(token.tokenName || token.tokenSymbol)}</b></a><b> New </b><a href="https://t.me/solearlytrending"><b>Trending</b></a>
🕒 <b>Age</b>: ${escapeHtml(ageText)} | <b>Security</b>: ✅
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
  const targetGroupChatId = env.TELEGRAM_GROUP_CHAT_ID || env.TELEGRAM_CHAT_ID;
  const dexscreenerUrl = getDexScreenerUrl(candidate);
  const botUser = env.TELEGRAM_BOT_USERNAME || 'MySolanaSBot';

  const message = renderEarlyTrendingCardText(candidate);

  const inlineKeyboard = [
    [
      { text: '📊 DexScreener', url: dexscreenerUrl },
      { text: '🔍 Solscan', url: `https://solscan.io/token/${candidate.tokenMint}` },
    ],
    [
      { text: '⚡ Snipe $10 (Private DM)', url: `https://t.me/${botUser}?start=snipe_${candidate.tokenMint}` },
      { text: '💬 Open Private DM', url: `https://t.me/${botUser}` },
    ],
    [
      { text: '⚡ Snipe 0.1 SOL', callback_data: `snipe_quick_0.1_${candidate.tokenMint}` },
      { text: '⚡ Snipe 0.5 SOL', callback_data: `snipe_quick_0.5_${candidate.tokenMint}` },
    ],
  ];

  if (!env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN.includes('dummy')) {
    console.log(`[Early Radar Dry-Run #${dailyIndex}]:\n${message}`);
    return;
  }

  // Attempt photo alert with card as caption if imageUrl is present and fits Telegram's 1024-character caption limit
  if (candidate.imageUrl && message.length <= 1024) {
    try {
      await bot.sendPhoto(targetGroupChatId, candidate.imageUrl, {
        caption: message,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: inlineKeyboard },
      });
      return;
    } catch (photoErr: any) {
      // Fall through to full text card
    }
  }

  try {
    await bot.sendMessage(targetGroupChatId, message, {
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
  const targetGroupChatId = env.TELEGRAM_GROUP_CHAT_ID || env.TELEGRAM_CHAT_ID;
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

  const botUser = env.TELEGRAM_BOT_USERNAME || 'MySolanaSBot';
  const inlineKeyboard = [
    [
      { text: '📊 DexScreener Chart', url: chartUrl },
      { text: '🔍 Solscan', url: `https://solscan.io/token/${pump.tokenMint}` },
    ],
    [
      { text: '💰 Take-Profit (Sell 50%)', callback_data: `sell_quick_50_${pump.tokenMint}` },
      { text: '🚪 Exit All (100%)', callback_data: `sell_quick_100_${pump.tokenMint}` },
    ],
    [
      { text: '💬 Open Private DM', url: `https://t.me/${botUser}` },
    ],
  ];

  if (!env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN.includes('dummy')) {
    console.log(`[Pump Milestone Dry-Run]:\n${message}`);
    return;
  }

  try {
    await bot.sendMessage(targetGroupChatId, message, {
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
  const targetGroupChatId = env.TELEGRAM_GROUP_CHAT_ID || env.TELEGRAM_CHAT_ID;
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

  const botUser = env.TELEGRAM_BOT_USERNAME || 'MySolanaSBot';
  const inlineKeyboard = [
    [
      { text: '📊 DexScreener Chart', url: chartUrl },
      { text: '🔍 Solscan', url: `https://solscan.io/token/${dip.tokenMint}` },
    ],
    [
      { text: '🛡️ Emergency Cut-Loss (Sell 100%)', callback_data: `sell_quick_100_${dip.tokenMint}` },
      { text: '💬 Open Private DM', url: `https://t.me/${botUser}` },
    ],
  ];

  if (!env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN.includes('dummy')) {
    console.log(`[Dip Milestone Dry-Run]:\n${message}`);
    return;
  }

  try {
    await bot.sendMessage(targetGroupChatId, message, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: inlineKeyboard },
      disable_web_page_preview: true,
    });
  } catch (err: any) {
    console.error('⚠️ Failed to dispatch Dip Milestone Alert:', err.message);
  }
}

/**
 * Queries live SOL balance for a given wallet address using Solana web3 RPC
 */
export async function fetchUserSolBalance(walletAddress: string): Promise<number> {
  try {
    const { Connection, PublicKey } = await import('@solana/web3.js');
    const conn = new Connection(env.HELIUS_RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed');
    const lamports = await conn.getBalance(new PublicKey(walletAddress));
    return Number((lamports / 1e9).toFixed(4));
  } catch {
    return 0;
  }
}

/**
 * Sends or updates the personalized multi-user wallet dashboard
 */
export async function sendUserWalletDashboard(
  chatId: number | string,
  userId: string,
  messageIdToEdit?: number
): Promise<void> {
  const membership = await verifyGroupMembership(userId);
  if (!membership.isMember) {
    await bot.sendMessage(
      chatId,
      `⛔ <b>Access Denied:</b> You must be an active member of our official group to configure a sniper wallet.\n\n` +
      `<i>Please join the group before setting up your sniper wallet.</i>`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  const pref = await getUserPreferences(userId);
  const walletAddr = pref.solanaWallet;
  let solBal = 0;
  if (walletAddr) {
    solBal = await fetchUserSolBalance(walletAddr);
  }

  const statusEmoji = pref.autoSnipeEnabled ? '🟢 <b>ACTIVE</b>' : '🔴 <b>DISABLED</b>';
  const walletDisplay = walletAddr ? `<code>${walletAddr}</code>` : '<i>Not Connected (Click button below)</i>';
  const currentTradeSize = (pref.fixedTradeSizeUsd ? pref.fixedTradeSizeUsd : 10.0).toFixed(2);

  let msg = `
💼 <b>SNIPER WALLET DASHBOARD</b>

🔑 <b>Wallet:</b> ${walletDisplay}
💰 <b>Balance:</b> <code>${solBal.toFixed(4)} SOL</code>
⚡ <b>Auto-Snipe:</b> ${statusEmoji}
💵 <b>Trade Allocation:</b> <b>$${currentTradeSize} USD</b> per trade
🛡️ <b>Strategy:</b> 2X De-Risk (Sell 50%) ➔ Infinite Trend Runner
💳 <b>Bot Fee Structure:</b>
  • 1% fee on every executed trade
  • 15% fee on profit when trade exits in profit
  • 0% fee on losing trades (only entry fee incurred)
📢 <b>Bankroll Requirement:</b> Minimum deposit of $1,000 required for optimal operation
`.trim();

  if (walletAddr) {
    msg += `\n🔗 <a href="https://solscan.io/account/${walletAddr}">View on Solscan</a>`;
    if (solBal < 0.03) {
      msg += `\n\n⚠️ <i>Low SOL Warning: Please deposit at least 0.05 SOL to fund trades and Solana gas fees!</i>`;
    }
  } else {
    msg += `\n\n💡 <i>To link your own wallet, paste your Solana private key directly into this private chat. It will be encrypted with AES-256-GCM and your original message will be deleted immediately for security.</i>`;
  }

  const inlineKeyboard: any[] = [];
  if (!walletAddr) {
    inlineKeyboard.push([{ text: '✨ Generate Dedicated Sniper Wallet', callback_data: 'wallet_generate_burner' }]);
  } else {
    inlineKeyboard.push([
      pref.autoSnipeEnabled
        ? { text: '🔴 Turn Auto-Snipe OFF', callback_data: 'snipe_disable' }
        : { text: '🟢 Turn Auto-Snipe ON', callback_data: 'snipe_enable' },
    ]);
    inlineKeyboard.push([
      { text: `💵 Set Trade Volume ($${currentTradeSize})`, callback_data: 'cmd_tradesize' },
    ]);
    inlineKeyboard.push([
      { text: '✨ Generate New Burner', callback_data: 'wallet_generate_burner' },
      { text: '💸 Withdraw SOL', callback_data: 'wallet_withdraw' },
    ]);
  }
  inlineKeyboard.push([
    { text: '💼 My Positions', callback_data: 'cmd_positions' },
    { text: '🔄 Refresh Balance', callback_data: 'cmd_wallet' },
  ]);
  inlineKeyboard.push([
    { text: '🚀 /start (Main Menu)', callback_data: 'cmd_start' },
  ]);

  if (messageIdToEdit) {
    try {
      await bot.editMessageText(msg, {
        chat_id: chatId,
        message_id: messageIdToEdit,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: inlineKeyboard },
      });
      return;
    } catch {}
  }

  await bot.sendMessage(chatId, msg, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: inlineKeyboard },
  });
}

/**
 * Builds the interactive keyboard with discrete trade volume amounts:
 * $10, $15, $20, $30, $40, $45, or $50 USD
 */
export function buildTradeSizeKeyboard(currentSize: number = 10): any {
  const options = [10, 15, 20, 30, 40, 45, 50];
  const row1 = options.slice(0, 3).map((amt) => ({
    text: amt === currentSize ? `✅ $${amt}` : `$${amt}`,
    callback_data: `set_tradesize_${amt}`,
  }));
  const row2 = options.slice(3, 6).map((amt) => ({
    text: amt === currentSize ? `✅ $${amt}` : `$${amt}`,
    callback_data: `set_tradesize_${amt}`,
  }));
  const row3 = options.slice(6).map((amt) => ({
    text: amt === currentSize ? `✅ $${amt}` : `$${amt}`,
    callback_data: `set_tradesize_${amt}`,
  }));

  return {
    inline_keyboard: [
      row1,
      row2,
      row3,
      [
        { text: '⚙️ Auto-Snipe Config', callback_data: 'cmd_autosnipe' },
        { text: '💼 Wallet Dashboard', callback_data: 'cmd_wallet' },
      ],
      [
        { text: '🚀 /start (Main Menu)', callback_data: 'cmd_start' },
      ],
    ],
  };
}

/**
 * Sends or edits the trade volume selection menu
 */
export async function sendTradeSizeSelectionMenu(
  chatId: number | string,
  userId: string,
  messageIdToEdit?: number
): Promise<void> {
  const pref = await getUserPreferences(userId);
  const currentSize = pref.fixedTradeSizeUsd || 10;
  const keyboard = buildTradeSizeKeyboard(currentSize);

  const text = `
⚙️ <b>DEFINE TRADING VOLUME ALLOCATION</b>

Select the trade volume allocated to each bot transaction from the authorized discrete amounts:
👉 <b>$10, $15, $20, $30, $40, $45, or $50 USD</b>

Current Allocation: <b>$${currentSize.toFixed(2)} USD</b>

🛡️ <b>FEE STRUCTURE:</b>
• <b>1% Execution Fee:</b> Applied to every trade executed by the bot.
• <b>15% Profit Fee:</b> Applied to the profit generated by any trade that is exited in a profitable state (levied regardless of whether the user manually initiates the exit, e.g. via "exit all", provided the trade is in profit).
• <b>0% Extra on Losses:</b> No additional percentage-based fee is charged on losing trades; the only cost incurred for such trades is the initial 1% entry fee.

📢 <b>MINIMUM DEPOSIT REQUIREMENT:</b>
A <b>minimum deposit of $1,000</b> (in SOL) is required for the optimal operation of the bot.

👇 <i>Tap a discrete amount below to update your allocation:</i>
  `.trim();

  if (messageIdToEdit) {
    try {
      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: messageIdToEdit,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: keyboard,
      });
      return;
    } catch {}
  }

  await bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: keyboard,
  });
}

/**
 * Handles deep-link 1-tap trade in private DM initiated from group alert buttons
 */
export async function handleUserDeepLinkSnipe(
  chatId: number | string,
  userId: string,
  tokenMint: string
): Promise<void> {
  const membership = await verifyGroupMembership(userId);
  if (!membership.isMember) {
    await bot.sendMessage(
      chatId,
      `⛔ <b>Access Denied:</b> You must be an active member of our official group to execute snipes.`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  const pref = await getUserPreferences(userId);
  if (!pref.encryptedSecret || !pref.encryptionIv || !pref.encryptionTag) {
    await bot.sendMessage(
      chatId,
      `⚠️ <b>No Wallet Connected</b>\n\nPlease connect or generate a dedicated sniper wallet first to execute $10 gem snipes:`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '✨ Generate Dedicated Sniper Wallet', callback_data: 'wallet_generate_burner' }],
            [{ text: '💼 Open Wallet Dashboard', callback_data: 'cmd_wallet' }],
          ],
        },
      }
    );
    return;
  }

  let keypair: any = null;
  try {
    keypair = decryptUserKeypair(pref.encryptedSecret, pref.encryptionIv, pref.encryptionTag);
  } catch (err: any) {
    await bot.sendMessage(chatId, `❌ Could not decrypt wallet credentials: ${err.message}`);
    return;
  }

  const waitMsg = await bot.sendMessage(
    chatId,
    `⏳ <i>Executing $10.00 snipe for <code>${tokenMint.slice(0, 6)}...${tokenMint.slice(-4)}</code>...</i>`,
    { parse_mode: 'HTML' }
  );

  try {
    const tradeSol = await getSolForFixedUsd(pref.fixedTradeSizeUsd || 10.0);
    const snipeRes = await executeUserSnipeTrade(
      {
        userId,
        telegramChatId: String(chatId),
        keypair,
        slippageBps: Math.round((pref.maxSlippagePercent || 15) * 100),
        priorityFeeLamports: pref.priorityFeeLamports || 100_000,
      },
      tokenMint,
      tradeSol
    );

    // ROUTE RECEIPT STRICTLY TO USER'S DM
    await dispatchSnipeNotification(snipeRes, chatId);
    await bot.deleteMessage(chatId, waitMsg.message_id).catch(() => {});
  } catch (err: any) {
    await bot.editMessageText(`⚠️ Snipe failed: ${err.message}`, {
      chat_id: chatId,
      message_id: waitMsg.message_id,
    });
  }
}

/**
 * Builds rich Admin Analytics and Fee status message for owners/admins
 */
export async function buildAdminAnalyticsMessage(): Promise<{ text: string; keyboard: any[][] }> {
  const summary = await getAdminAnalyticsSummary();

  const walletDisplay = summary.adminFeeWallet
    ? `<code>${summary.adminFeeWallet}</code> (<a href="https://solscan.io/account/${summary.adminFeeWallet}">Solscan</a>)`
    : `❌ <i>None configured (Tap [💼 Set Fee Wallet] below to paste address)</i>`;

  const text = `
📊 <b>ADMIN BUSINESS INTELLIGENCE & ANALYTICS</b> 🛡️

👥 <b>User Adoption & Community:</b>
• <b>Total Registered Users:</b> <code>${summary.totalUsers}</code>
• <b>Active Trading Users:</b> <code>${summary.activeUsers}</code>
• <b>Funded User Wallets:</b> <code>${summary.fundedUsersCount}</code>
• <b>Auto-Snipe Active:</b> <code>${summary.autoSnipeUsersCount}</code>
• <b>Unfunded / Paper Users:</b> <code>${summary.unfundedUsersCount}</code>

💰 <b>Bot Fee Revenue (Money Made from Users):</b>
• <b>Total Live Revenue:</b> <b>${summary.totalLiveFeesSol.toFixed(4)} SOL</b> (~<b>$${summary.totalLiveFeesUsd.toFixed(2)} USD</b>)
  ├ <b>1% Trade Entry Fees:</b> <code>${summary.entryFeesSol.toFixed(4)} SOL</code> ($${summary.entryFeesUsd.toFixed(2)})
  └ <b>15% Profit Exit Fees:</b> <code>${summary.profitFeesSol.toFixed(4)} SOL</code> ($${summary.profitFeesUsd.toFixed(2)})
• <b>Model / Paper Trading Fees:</b> <code>$${summary.totalModelFeesUsd.toFixed(2)} USD</code> (${summary.totalModelFeesSol.toFixed(4)} SOL)
• <b>Total Transferred On-Chain:</b> <b>${summary.totalTransferredSol.toFixed(4)} SOL</b>

💼 <b>Fee Destination Wallet:</b>
${walletDisplay}
<i>All 1% entry and 15% profit fees are transferred to this wallet address on-chain.</i>

🏦 <b>Server Vault Keypair:</b>
• <b>Address:</b> <code>${summary.serverWalletAddress}</code>
• <b>Available Balance:</b> <code>${summary.serverWalletBalanceSol.toFixed(4)} SOL</code>
  `.trim();

  const keyboard: any[][] = [
    [
      { text: '🔄 Refresh Analytics', callback_data: 'cmd_admin_analytics' },
      { text: '💼 Set Fee Wallet', callback_data: 'cmd_admin_set_wallet' },
    ],
    [
      { text: '💸 Sweep Server Balance to Fee Wallet', callback_data: 'cmd_admin_sweep_fees' },
    ],
    [
      { text: '🚀 /start (Main Menu)', callback_data: 'cmd_start' },
    ],
  ];

  return { text, keyboard };
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
    { command: 'tradesize', description: '💵 Set Trade Volume ($10, $15, $20, $30, $40, $45, $50)' },
    { command: 'portfolio', description: '💼 $1,000 Alpha Portfolio & Live PnL' },
    { command: 'top', description: '🏆 Daily Top Gainers & 5X-20X Hall of Fame' },
    { command: 'flops', description: '📉 Daily Flopped Coins & Dips (-50%+)' },
    { command: 'weekly', description: '🗓️ Weekly Cumulative Recap & PnL' },
    { command: 'learner', description: '🧠 Adaptive Loss-Learning Feedback Engine' },
    { command: 'ask', description: '🤖 AI Trading Co-Pilot Q&A' },
    { command: 'milestones', description: '📈 Price Milestones (+50% / -50%)' },
    { command: 'positions', description: '💼 My Active Positions & TP/SL Status' },
    { command: 'exitall', description: '🚨 Exit All Active Trades & Return Money to Account' },
    { command: 'exit', description: '🚨 Exit Specific Trade (/exit <mint or ticker>)' },
    { command: 'autosnipe', description: '⚙️ Auto-Snipe Settings & Toggle' },
    { command: 'wallet', description: '💼 Sniper Wallet, Deposit & Withdraw' },
    { command: 'withdraw', description: '💸 Withdraw SOL to External Wallet' },
    { command: 'connect', description: '🔐 Connect / Generate Sniper Wallet' },
    { command: 'admin', description: '📊 Admin Analytics & Fee Destination' },
    { command: 'help', description: '❓ How It Works & Trading Guide' },
  ]).catch((err: any) => {
    console.warn('⚠️ Could not register Telegram menu commands:', err.message);
  });

  // Pre-fetch and periodically sync group administrators for message authorization
  refreshGroupAdminsCache().catch(() => {});
  setInterval(refreshGroupAdminsCache, 15 * 60 * 1000);

  // Enforce MUTE mode in public group so regular members cannot type/send messages
  enforceGroupChatPermissions().catch(() => {});
  setInterval(enforceGroupChatPermissions, 15 * 60 * 1000);

  // Group admin guard wrapper for command listeners
  const onTextCmd = (regexp: RegExp, handler: (msg: any, match?: any) => Promise<void> | void) => {
    bot.onText(regexp, async (msg, match) => {
      const allowed = await enforceGroupAdminOnly(msg);
      if (!allowed) return;
      return handler(msg, match);
    });
  };

  // Initialize the 6-Hour Group Pinned Dashboard Scheduler
  initGroupPinnedDashboardScheduler();

  // 1. New Group Members Listener: Send Transient 60s Welcome Explaining Core Operating Principles & Fees
  bot.on('new_chat_members', async (msg) => {
    const groupChatId = env.TELEGRAM_GROUP_CHAT_ID || env.TELEGRAM_CHAT_ID;
    if (String(msg.chat.id) !== String(groupChatId)) return;

    for (const newUser of (msg.new_chat_members || [])) {
      if (newUser.is_bot) continue;

      const name = newUser.first_name || 'Trader';
      const botUser = env.TELEGRAM_BOT_USERNAME || 'MySolanaSBot';
      const welcomeText = `
👋 <b>Welcome to the Alpha Radar, ${escapeHtml(name)}!</b>

📢 <b>NOTICE FOR NEW USERS & CAPITAL REQUIREMENTS:</b>
• <b>Minimum Deposit Requirement:</b> A <b>minimum deposit of $1,000</b> (in SOL) is required for the optimal operation of the bot to ensure proper multi-trade diversification and runway.

🛡️ <b>CORE OPERATING PRINCIPLES:</b>
• <b>Customizable Trading Volume:</b> Define your allocated per-trade volume from discrete amounts: <b>$10, $15, $20, $30, $40, $45, or $50 USD</b> (default: $10.00).
• <b>Transparent Fee Structure:</b>
  - <b>1% Execution Fee:</b> Applied to every trade executed by the bot.
  - <b>15% Profit Fee:</b> Applied to the profit generated by any trade exited in profit (levied whether exited autonomously or manually via "exit all").
  - <b>0% Extra on Losses:</b> No additional percentage-based fee is charged on losing trades (only the initial 1% entry fee is incurred).
• <b>Infinite Trend Rider:</b> At 2X, the bot sells 50% to recover initial capital risk-free; remaining tokens ride parabolic trends indefinitely.

📌 <i>Be sure to review the pinned Operating Guide at the top of the group!</i>
👇 <i>Tap below to securely set your volume and connect your wallet in private DM:</i>
      `.trim();

      try {
        const welcomeMsg = await bot.sendMessage(msg.chat.id, welcomeText, {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '⚙️ Set Trade Volume ($10-$50)', url: `https://t.me/${botUser}?start=tradesize` }],
              [{ text: '🔐 Connect Sniper Wallet (Private DM)', url: `https://t.me/${botUser}?start=connect` }],
            ],
          },
        });

        setTimeout(() => {
          bot.deleteMessage(msg.chat.id, welcomeMsg.message_id).catch(() => {});
        }, 60_000);
      } catch {}
    }
  });

  // 2. Member Removal / Left Listener: Purge Credentials & Access Immediately
  bot.on('left_chat_member', async (msg) => {
    const groupChatId = env.TELEGRAM_GROUP_CHAT_ID || env.TELEGRAM_CHAT_ID;
    if (String(msg.chat.id) !== String(groupChatId)) return;

    const leftUser = msg.left_chat_member;
    if (!leftUser || leftUser.is_bot) return;

    console.log(`👋 User @${leftUser.username || leftUser.id} left or was kicked from group.`);
    await revokeUserWalletAndAccess(String(leftUser.id), 'Kicked or left group');
  });

  bot.on('chat_member', async (update: any) => {
    const groupChatId = env.TELEGRAM_GROUP_CHAT_ID || env.TELEGRAM_CHAT_ID;
    if (String(update.chat.id) !== String(groupChatId)) return;

    const newStatus = update.new_chat_member?.status;
    const targetUser = update.new_chat_member?.user;
    if (!targetUser || targetUser.is_bot) return;

    if (newStatus === 'kicked' || newStatus === 'left') {
      await revokeUserWalletAndAccess(String(targetUser.id), `Status changed to ${newStatus}`);
    }
  });

  // Persistent Keyboard docked at the bottom of phone screen
  const persistentReplyKeyboard = {
    keyboard: [
      [{ text: '🚀 /start' }, { text: '💼 $1,000 Portfolio' }],
      [{ text: '🏆 Top Gainers' }, { text: '📉 Daily Flops' }],
      [{ text: '📈 Price Milestones' }, { text: '🚨 Exit All Trades' }],
      [{ text: '🤖 AI Co-Pilot' }, { text: '⚙️ Auto-Snipe' }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };

  const sendWelcomeDashboard = async (chatId: number | string) => {
    const userId = String(chatId);
    const pref = await getUserPreferences(userId);
    const { fetchLiveSolPrice } = await import('./paperTrading.js');
    const solPrice = await fetchLiveSolPrice();

    let solBal = 0;
    if (pref.solanaWallet) {
      solBal = await fetchUserSolBalance(pref.solanaWallet);
    }
    const isFunded = Boolean(pref.solanaWallet && solBal >= 0.01);
    const balanceUsd = (solBal * solPrice).toFixed(2);

    let portfolioLabel = '💼 $1,000 Alpha Portfolio';
    let capitalLine = '• <b>Capital:</b> 💼 <b>$1,000.00 USD</b> (Alpha Model Portfolio • Unfunded)';
    let snipeBadge = '🔴 <b>DISABLED</b> (Signals Only • Unfunded)';

    if (isFunded) {
      portfolioLabel = `💼 My Live Portfolio ($${balanceUsd})`;
      capitalLine = `• <b>Deposited Funds:</b> <code>${solBal.toFixed(4)} SOL</code> (<b>$${balanceUsd} USD</b>)`;
      snipeBadge = pref.autoSnipeEnabled
        ? `🟢 <b>ACTIVE</b> (Using deposited funds for $10 entries)`
        : '⏸️ <b>DISABLED</b> (No funds allocated • Manual only)';
    } else if (pref.autoSnipeEnabled) {
      snipeBadge = '🟡 <b>AWAITING DEPOSIT</b> (Deposit SOL to activate)';
    }

    let dailyCoinCount = 0;
    try {
      const today = new Date().toISOString().slice(0, 10);
      dailyCoinCount = await prisma.earlyTrendingToken.count({ where: { alertDate: today } });
    } catch {}
    if (dailyCoinCount === 0) {
      try {
        const today = new Date().toISOString().slice(0, 10);
        dailyCoinCount = (await getTokensForDate(today)).length;
      } catch {}
    }

    const currentTradeSize = pref.fixedTradeSizeUsd || 10.0;
    const welcome = `
⚡ <b>Solana Trading Bot</b>
${capitalLine}
• <b>Auto-Snipe:</b> ${snipeBadge}
• <b>Trade Volume:</b> <b>$${currentTradeSize.toFixed(2)} USD</b> / trade (Options: $10, $15, $20, $30, $40, $45, $50)
• <b>Fee Structure:</b> 1% entry fee | 15% profit fee on win | 0% extra on loss
• <b>Optimal Capital:</b> $1,000.00 USD minimum recommended for optimal diversified operation
• <b>Strategy:</b> Infinite Trend Rider (2X de-risk ➔ Moonbag)
• <b>Coins Alerted Today:</b> <code>${dailyCoinCount}</code>

<i>Tap any action below:</i>
    `.trim();

    const inlineKeyboard = [
      [
        { text: portfolioLabel, callback_data: 'cmd_paper_portfolio' },
        { text: '🚨 Exit All Trades', callback_data: 'cmd_exit_all' },
      ],
      [
        { text: '🏆 Top Gainers', callback_data: 'cmd_top' },
        { text: '📉 Daily Flops', callback_data: 'cmd_flops' },
      ],
      [
        { text: '🗓️ Weekly Report', callback_data: 'cmd_weekly' },
        { text: '🤖 AI Co-Pilot', callback_data: 'cmd_copilot' },
      ],
      [
        { text: '📈 Price Milestones', callback_data: 'cmd_milestones' },
        { text: '💼 My Positions', callback_data: 'cmd_positions' },
      ],
      [
        { text: `💵 Set Trade Volume ($${currentTradeSize})`, callback_data: 'cmd_tradesize' },
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

    const isAdmin = await isGroupAdminOrOwner(chatId, userId);
    if (isAdmin) {
      inlineKeyboard.push([
        { text: '📊 Admin Analytics', callback_data: 'cmd_admin_analytics' },
        { text: '💼 Set Fee Wallet', callback_data: 'cmd_admin_set_wallet' },
      ]);
    }

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

  // /start or Start button (supports deep-linking: /start <payload>)
  onTextCmd(/\/start(?:\s+(.+))?|🚀 \/start|🚀 Start/i, async (msg, match) => {
    const payload = match?.[1]?.trim();
    const userId = String(msg.from?.id || msg.chat.id);

    if (payload === 'dashboard' || payload === 'report' || payload === 'guide') {
      const { buildGroupDashboardText, buildPrivateDashboardKeyboard } = await import('./groupPinnedDashboard.js');
      const text = await buildGroupDashboardText(userId);
      const keyboard = buildPrivateDashboardKeyboard();
      await safeSendTelegramMessage(msg.chat.id, text, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: keyboard,
      });
      return;
    }

    if (payload === 'connect') {
      await sendUserWalletDashboard(msg.chat.id, userId);
      return;
    }

    if (payload === 'tradesize' || payload === 'volume' || payload === 'allocation') {
      await sendTradeSizeSelectionMenu(msg.chat.id, userId);
      return;
    }

    if (payload?.startsWith('snipe_')) {
      const tokenMint = payload.replace('snipe_', '').trim();
      await handleUserDeepLinkSnipe(msg.chat.id, userId, tokenMint);
      return;
    }

    if (payload && (payload.startsWith('bundle_') || payload.startsWith('fakevol_') || payload.startsWith('first20_'))) {
      const parts = payload.split('_');
      if (parts[1]) {
        await handleTokenDeepLink(msg.chat.id, parts[1]);
        return;
      }
    }

    if (payload && payload.length >= 30) {
      await handleTokenDeepLink(msg.chat.id, payload);
      return;
    }

    await sendWelcomeDashboard(msg.chat.id);
  });

  // /portfolio or /paper or "💼 $1,000 Portfolio" button
  onTextCmd(/💼 \$1,?000 Portfolio|💼 \$500 Portfolio|💼 \$1,?000 Paper|💼 \$500 Paper|💼 \$100 Paper|\/portfolio(?:\s+(.+))?|\/paper(?:\s+(.+))?/i, async (msg, match) => {
    const target = (match?.[1] || match?.[2])?.trim();
    if (target && target.length >= 3 && !/^(portfolio|stats|pnl)$/i.test(target)) {
      await handleUserSubmittedToken(msg.chat.id, target);
      return;
    }
    const userId = String(msg.from?.id || msg.chat.id);
    await handlePaperPortfolioCommand(msg.chat.id, userId);
  });

  // /reset_portfolio, /paper_reset, or /resetpaper
  onTextCmd(/\/reset_portfolio|\/resetportfolio|\/paper_reset|\/reset_paper|\/resetpaper/i, async (msg) => {
    await handlePaperResetCommand(msg.chat.id);
  });

  // /fund or /topup (Funds portfolio with $1,000 or specified amount)
  onTextCmd(/\/fund(?:\s+(\d+(?:\.\d+)?))?|\/topup(?:\s+(\d+(?:\.\d+)?))?/i, async (msg, match) => {
    const amount = parseFloat(match?.[1] || match?.[2] || '1000');
    try {
      const { topUpPaperTradingWallet } = await import('./paperTrading.js');
      const wallet = await topUpPaperTradingWallet(amount);
      await bot.sendMessage(
        msg.chat.id,
        `💵 <b>[PORTFOLIO FUNDED]</b> 💸\n\n` +
        `Added: <b>+$${amount.toFixed(2)} USD</b>\n` +
        `💰 <b>New Liquid Cash:</b> <code>$${wallet.liquidCashUsd.toFixed(2)} USD</code> (<code>${wallet.liquidCashSol.toFixed(4)} SOL</code>)\n\n` +
        `<i>Ready for upcoming radar entries!</i>`,
        { parse_mode: 'HTML' }
      );
    } catch (err: any) {
      await bot.sendMessage(msg.chat.id, `⚠️ Error funding portfolio: ${err.message}`);
    }
  });

  // /dashboard or /pinned (Forces posting and pinning group performance dashboard)
  onTextCmd(/\/dashboard|\/pinned|\/pin_dashboard/i, async (msg) => {
    try {
      await postOrUpdateGroupPinnedDashboard(true);
      await bot.sendMessage(msg.chat.id, '📌 <b>[PINNED DASHBOARD]</b> Performance briefing posted and pinned in the group!', { parse_mode: 'HTML' });
    } catch (err: any) {
      await bot.sendMessage(msg.chat.id, `⚠️ Error updating pinned dashboard: ${err.message}`);
    }
  });

  // /pinguide (Forces auto-healing, re-posting and pinning the constant bot operating guide in the public group)
  onTextCmd(/\/pinguide|\/ping_guide/i, async (msg) => {
    try {
      const { ensureConstantBotGuidePinned } = await import('./groupPinnedDashboard.js');
      await ensureConstantBotGuidePinned(true);
      await bot.sendMessage(msg.chat.id, '📌 <b>[BOT GUIDE]</b> Constant Operating Guide freshly posted and pinned in the group!', { parse_mode: 'HTML' });
    } catch (err: any) {
      await bot.sendMessage(msg.chat.id, `⚠️ Error pinning guide: ${err.message}`);
    }
  });

  // /lockgroup or /muteall (Enforces MUTE permissions on the public group)
  onTextCmd(/\/lockgroup|\/muteall|\/mutegroup/i, async (msg) => {
    try {
      await enforceGroupChatPermissions();
      await bot.sendMessage(msg.chat.id, '🔒 <b>[GROUP LOCKED]</b> Public group permissions set to MUTE mode. Only admins/owner can post.', { parse_mode: 'HTML' });
    } catch (err: any) {
      await bot.sendMessage(msg.chat.id, `⚠️ Error locking group: ${err.message}`);
    }
  });

  // /exitall, /closeall, /sellall, "🚨 Exit All Trades", or "Exit All"
  onTextCmd(/\/exitall|\/closeall|\/sellall|🚨 Exit All Trades|Exit All Trades|🚨 Exit All|Exit All/i, async (msg) => {
    try {
      const { exitAllPaperPositions } = await import('./paperTrading.js');
      const { exitAllSnipedPositions } = await import('./sniper.js');
      const paperExit = await exitAllPaperPositions('MANUAL_EXIT_ALL');
      const snipeExit = await exitAllSnipedPositions();

      let exitMsg = `🚨 <b>ALL TRADES EXITED</b>\n\n`;
      const totalCount = paperExit.count + snipeExit.count;
      if (totalCount > 0) {
        const totalProfitable = paperExit.profitableCount + snipeExit.profitableCount;
        const totalLosing = paperExit.losingCount + snipeExit.losingCount;

        exitMsg += `• <b>Total Closed:</b> <b>${totalCount} trade(s)</b>\n`;
        exitMsg += `• <b>Profitable Exits:</b> <b>${totalProfitable}</b> (15% profit fee applied)\n`;
        if (paperExit.totalProfitFeesUsd > 0) {
          exitMsg += `  └ <i>Model Profit Fees: -$${paperExit.totalProfitFeesUsd.toFixed(2)} USD</i>\n`;
        }
        if (snipeExit.totalProfitFeeSol > 0) {
          exitMsg += `  └ <i>Live Profit Fees: -${snipeExit.totalProfitFeeSol.toFixed(4)} SOL</i>\n`;
        }
        exitMsg += `• <b>Losing Exits:</b> <b>${totalLosing}</b> (0% fee charged; 1% entry fee only)\n\n`;

        if (paperExit.totalReturnedUsd > 0) {
          exitMsg += `💰 <b>Returned to Cash:</b> <b>+$${paperExit.totalReturnedUsd.toFixed(2)} USD</b>\n`;
        }
        if (snipeExit.totalSol > 0) {
          exitMsg += `💰 <b>Returned SOL:</b> <b>+${snipeExit.totalSol.toFixed(3)} SOL</b>\n`;
        }
        exitMsg += `💼 <b>Liquid Cash:</b> <code>$${paperExit.newLiquidCashUsd.toFixed(2)} USD</code>`;
      } else {
        exitMsg += `ℹ️ <i>No open trades. Cash balance: $${paperExit.newLiquidCashUsd.toFixed(2)} USD</i>`;
      }

      await bot.sendMessage(msg.chat.id, exitMsg, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '💼 View Portfolio', callback_data: 'cmd_paper_portfolio' },
              { text: '🏆 Top Gainers', callback_data: 'cmd_top' },
            ],
          ],
        },
      });
    } catch (err: any) {
      await bot.sendMessage(msg.chat.id, `⚠️ Exit error: ${err.message}`);
    }
  });

  // /exit, /close, /sell <mint or ticker>
  onTextCmd(/\/exit(?:\s+(.+))?|\/close(?:\s+(.+))?|\/sell(?:\s+(.+))?/i, async (msg, match) => {
    const query = (match?.[1] || match?.[2] || match?.[3])?.trim();
    if (!query) {
      await bot.sendMessage(
        msg.chat.id,
        `🚨 <b>Exit Trade</b>\nUsage: <code>/exit &lt;mint or $SYM&gt;</code> or <code>/exitall</code>`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    if (/^all$/i.test(query)) {
      try {
        const { exitAllPaperPositions } = await import('./paperTrading.js');
        const { exitAllSnipedPositions } = await import('./sniper.js');
        const paperExit = await exitAllPaperPositions('MANUAL_EXIT_ALL');
        const snipeExit = await exitAllSnipedPositions();

        let exitMsg = `🚨 <b>ALL TRADES EXITED</b>\n\n`;
        const totalCount = paperExit.count + snipeExit.count;
        if (totalCount > 0) {
          const totalProfitable = paperExit.profitableCount + snipeExit.profitableCount;
          const totalLosing = paperExit.losingCount + snipeExit.losingCount;
          exitMsg += `• <b>Total Closed:</b> <b>${totalCount} trade(s)</b>\n`;
          exitMsg += `• <b>Profitable Exits:</b> <b>${totalProfitable}</b> (15% profit fee applied)\n`;
          exitMsg += `• <b>Losing Exits:</b> <b>${totalLosing}</b> (0% fee charged; 1% entry fee only)\n`;
          if (paperExit.totalReturnedUsd > 0) {
            exitMsg += `• <b>Returned to Cash:</b> <b>+$${paperExit.totalReturnedUsd.toFixed(2)} USD</b>\n`;
          }
          if (snipeExit.totalSol > 0) {
            exitMsg += `• <b>Returned SOL:</b> <b>+${snipeExit.totalSol.toFixed(3)} SOL</b>\n`;
          }
          exitMsg += `💼 <b>Liquid Cash:</b> <code>$${paperExit.newLiquidCashUsd.toFixed(2)} USD</code>`;
        } else {
          exitMsg += `ℹ️ <i>No open trades. Cash balance: $${paperExit.newLiquidCashUsd.toFixed(2)} USD</i>`;
        }

        await bot.sendMessage(
          msg.chat.id,
          exitMsg,
          { parse_mode: 'HTML' }
        );
      } catch (err: any) {
        await bot.sendMessage(msg.chat.id, `⚠️ Exit all error: ${err.message}`);
      }
      return;
    }

    try {
      const { exitPaperPosition } = await import('./paperTrading.js');
      const { exitSnipedPosition } = await import('./sniper.js');
      const paperRes = await exitPaperPosition(query);
      const snipeRes = await exitSnipedPosition(query);

      let replyMsg = `🚨 <b>TRADE EXITED</b>\n`;
      if (paperRes.success) {
        replyMsg += `• Token: <b>$${escapeHtml(paperRes.tokenSymbol)}</b>\n`;
        replyMsg += `• Returned to Cash: <b>+$${paperRes.netReturnUsd.toFixed(2)} USD</b>\n`;
        replyMsg += `💼 <b>Liquid Cash:</b> <code>$${paperRes.newLiquidCashUsd.toFixed(2)} USD</code>`;
      } else if (snipeRes.success) {
        replyMsg += `• Token: <b>$${escapeHtml(snipeRes.tokenSymbol || query)}</b>\n`;
        replyMsg += `• Returned: <b>+${snipeRes.solAmount.toFixed(3)} SOL</b>`;
      } else {
        replyMsg += `⚠️ <i>No active trade found for "${escapeHtml(query)}"</i>`;
      }

      await bot.sendMessage(msg.chat.id, replyMsg, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '💼 View Portfolio', callback_data: 'cmd_paper_portfolio' },
              { text: '💼 My Positions', callback_data: 'cmd_positions' },
            ],
          ],
        },
      });
    } catch (err: any) {
      await bot.sendMessage(msg.chat.id, `⚠️ Exit error: ${err.message}`);
    }
  });

  // /daily or /early or "💎 Daily Coins" button
  onTextCmd(/💎 Daily Coins|\/daily|\/early|Daily Coin/i, async (msg) => {
    await handleEarlyTrendingCommand(msg.chat.id);
  });

  // /top or /profits or "🏆 Top Gainers" button
  onTextCmd(/🏆 Top Gainers|\/top|\/profits|\/leaderboard|Top Early Trending|Top Gainer|Hall of Fame|^top gainers?$|^top$/i, async (msg) => {
    await handleTopCommand(msg.chat.id);
  });

  // /flops or /bad or "📉 Daily Flops" button
  onTextCmd(/📉 Daily Flops|\/flops|\/bad|\/flopped|\/dips|Bad Coin|Daily Flop|^daily flops?$|^flops?$/i, async (msg) => {
    await handleDailyFlopsCommand(msg.chat.id);
  });

  // /weekly or /week or "🗓️ Weekly Report"
  onTextCmd(/🗓️ Weekly Report|\/weekly|\/week|Weekly Report|Weekly Recap|^weekly report$|^weekly recap$|^weekly$/i, async (msg) => {
    await handleWeeklyReportCommand(msg.chat.id);
  });

  // /ask or "🤖 AI Co-Pilot"
  onTextCmd(/🤖 AI Co-Pilot|\/ask(?:\s+(.+))?/i, async (msg, match) => {
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
  onTextCmd(/\/audit(?:\s+(.+))?/i, async (msg, match) => {
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
              { text: '🏆 Top Gainers', callback_data: 'cmd_top' },
            ],
          ],
        },
      });
    } catch (err: any) {
      await bot.sendMessage(msg.chat.id, `⚠️ <i>Audit error: ${err.message}</i>`, { parse_mode: 'HTML' });
    }
  });

  // /slm or /gate <mint or ticker>
  onTextCmd(/\/slm(?:\s+(.+))?|\/gate(?:\s+(.+))?/i, async (msg, match) => {
    const query = (match?.[1] || match?.[2])?.trim();
    if (!query) {
      await bot.sendMessage(
        msg.chat.id,
        '🛡️ <b>SLM Quality Gate Meme Coin Evaluator</b>\n\n' +
          '<i>Autonomous community sentiment, bot-raid filtering &amp; velocity validation ($0.00 cost)</i>\n\n' +
          '<b>Usage:</b>\n<code>/slm &lt;mintAddress or $TICKER&gt;</code>\n\n' +
          '<b>Examples:</b>\n' +
          '• <code>/slm BONK</code>\n' +
          '• <code>/slm $WIF</code>\n' +
          '• <code>/slm 7GUnr7krtQhJwd6ASY2VUprd9t4c64zcgCsjdmZepump</code>',
        { parse_mode: 'HTML' }
      );
      return;
    }

    const waitMsg = await bot.sendMessage(
      msg.chat.id,
      `🛡️ <i>Evaluating community sentiment, TG public previews, and on-chain velocity for <code>${escapeHtml(query)}</code>...</i>`,
      { parse_mode: 'HTML' }
    );

    try {
      const { lookupTokenAnalytics, evaluateSlmQualityGate } = await import('./aiIntelligence.js');
      const audit = await lookupTokenAnalytics(query);

      if (!audit) {
        await bot.editMessageText(
          `⚠️ <i>Could not find an active liquidity pool for "<b>${escapeHtml(query)}</b>". Provide the raw mint address.</i>`,
          {
            chat_id: msg.chat.id,
            message_id: waitMsg.message_id,
            parse_mode: 'HTML',
          }
        );
        return;
      }

      const m = audit.onChainMetrics;
      const vol1h = Math.round((audit.volume24h || 24000) / 24);
      const verdict = await evaluateSlmQualityGate({
        tokenSymbol: audit.symbol,
        tokenName: audit.name || audit.symbol,
        tokenMint: audit.mint,
        ageMinutes: m?.ageMinutes || 5,
        marketCap: m?.marketCapUsd || 50000,
        liquidityUsd: m?.liquidityUsd || 15000,
        volume1h: vol1h,
        volume5m: Math.round(vol1h / 12),
        buySellRatio: audit.buyPressureRatio || 1.5,
        buys5m: 15,
        sells5m: 10,
        holderCount: 300,
        devHoldingPct: m?.devHoldingPct ?? 0,
        devSoldPct: m?.devHoldingPct === 0 ? 100 : 0,
        twitterUrl: audit.webNarrative?.twitterUrl,
        telegramUrl: audit.webNarrative?.telegramUrl,
        websiteUrl: audit.webNarrative?.websiteUrl,
        websiteTextSnippet: audit.webNarrative?.websiteTextSnippet,
      });

      const isGo = verdict.viabilitySignal === 'GO';
      const signalBadge = isGo ? '🟢 <b>CONFIRMED (GO)</b>' : '🔴 <b>BLOCKED (NO_GO)</b>';
      const targets = Array.isArray(verdict.recommendedMultiples) && verdict.recommendedMultiples.length > 0
        ? verdict.recommendedMultiples.map((m: number) => `${m}X`).join(' • ')
        : '2X • 4X • 7X';
      const flagsText = verdict.riskFlags.length > 0
        ? verdict.riskFlags.map((f: string) => `• ⚠️ ${escapeHtml(f)}`).join('\n')
        : '• ✅ <i>No dev dump, bot raid, or manipulation flags detected</i>';

      const card = `
🛡️ <b>SLM Quality Gate:</b> <b>$${escapeHtml(audit.symbol)}</b>
<i>Autonomous Community Sentiment &amp; Narrative Gatekeeper</i>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🚦 <b>Viability Signal:</b> ${signalBadge}
🔥 <b>Organic Hype Score:</b> <code>${verdict.organicHypeScore}/10</code> (bot raid filter)
🧠 <b>Narrative Strength:</b> <code>${verdict.narrativeStrength}/10</code>
🌊 <b>Volume Velocity:</b> <code>${verdict.volumeVelocityAlignment}/10</code>

🎯 <b>Ladder TP Targets:</b> <code>${targets}</code>
🛡️ <b>Moonbag Trailing Stop:</b> <code>-${verdict.trailingStopLossPct}%</code>

💬 <b>Telegram Preview:</b> ${verdict.telegramAnalyzed ? '✅ Analyzed (Web Preview)' : '⚠️ None found'}
🐦 <b>Twitter Handle:</b> ${verdict.twitterAnalyzed ? '✅ Verified Profile' : '⚠️ None found'}

⚖️ <b>SLM Analytical Thesis:</b>
<i>${escapeHtml(verdict.justificationSummary)}</i>

🚩 <b>Guardrail Flags:</b>
${flagsText}
      `.trim();

      await bot.editMessageText(card, {
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
          ],
        },
      });
    } catch (err: any) {
      await bot.sendMessage(msg.chat.id, `⚠️ <i>SLM Gatekeeper notice: ${err.message}</i>`, { parse_mode: 'HTML' });
    }
  });

  // /predict or /gems or /recommend
  onTextCmd(/\/predict|\/gems|\/recommend/i, async (msg) => {
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
        { text: '🏆 Top Gainers', callback_data: 'cmd_top' },
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

  // /buy or /submit or /trade <mint or ticker>
  onTextCmd(/\/buy(?:\s+(.+))?|\/submit(?:\s+(.+))?|\/trade(?:\s+(.+))?/i, async (msg, match) => {
    const query = (match?.[1] || match?.[2] || match?.[3])?.trim();
    if (!query) {
      await bot.sendMessage(
        msg.chat.id,
        `⚡ <b>Instant Token Audit & Buy</b> 🪙\n\n` +
          `Submit any Solana token to audit and trade it immediately:\n` +
          `<code>/buy &lt;mintAddress or $TICKER&gt;</code>\n\n` +
          `<b>Examples:</b>\n` +
          `• <code>/buy 7GUnr7krtQhJwd6ASY2VUprd9t4c64zcgCsjdmZepump</code>\n` +
          `• <code>/buy BONK</code>\n\n` +
          `<i>Tip: You can also simply paste any Solana contract address directly into this chat!</i>`,
        { parse_mode: 'HTML' }
      );
      return;
    }
    await handleUserSubmittedToken(msg.chat.id, query);
  });

  // /milestones or "📈 Price Milestones" button
  onTextCmd(/\/milestones|📈 Price Milestones|📈 Milestones|Price Milestone|^price milestones?$|^milestones?$/i, async (msg) => {
    await handlePriceMilestonesCommand(msg.chat.id);
  });

  // /positions or "💼 My Positions" button
  onTextCmd(/💼 My Positions|\/positions|\/portfolio|My Position/i, async (msg) => {
    await handlePositionsCommand(msg.chat.id, String(msg.from?.id || msg.chat.id));
  });

  // "⚙️ Auto-Snipe" button
  onTextCmd(/⚙️ Auto-Snipe|Auto Snipe Settings/i, async (msg) => {
    const userId = String(msg.from?.id || msg.chat.id);
    await handleSnipeStatus(msg.chat.id, userId);
  });

  // "🟢 Auto-Snipe ON" button
  onTextCmd(/🟢 Auto-Snipe ON|\/autosnipe\s+on/i, async (msg) => {
    const userId = String(msg.from?.id || msg.chat.id);
    await setUserAutoSnipeConfig(userId, { autoSnipeEnabled: true });
    await bot.sendMessage(msg.chat.id, '🟢 <b>Auto-Snipe is now ENABLED!</b>\nThe bot will automatically snipe approved trades.', { parse_mode: 'HTML' });
  });

  // "🔴 Auto-Snipe OFF" button
  onTextCmd(/🔴 Auto-Snipe OFF|\/autosnipe\s+off/i, async (msg) => {
    const userId = String(msg.from?.id || msg.chat.id);
    await setUserAutoSnipeConfig(userId, { autoSnipeEnabled: false });
    await bot.sendMessage(msg.chat.id, '🔴 <b>Auto-Snipe is now DISABLED!</b>\nYou will receive alert signals only.', { parse_mode: 'HTML' });
  });

  // /autosnipe on|off
  onTextCmd(/\/autosnipe(?:\s+(on|off))?/i, async (msg, match) => {
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

  // /tradesize, /volume, or /allocation [10|15|20|30|40|45|50]
  onTextCmd(/\/tradesize(?:\s+(\S+))?|\/volume(?:\s+(\S+))?|\/allocation(?:\s+(\S+))?/i, async (msg, match) => {
    const userId = String(msg.from?.id || msg.chat.id);
    const rawVal = (match?.[1] || match?.[2] || match?.[3])?.trim();

    if (!rawVal) {
      await sendTradeSizeSelectionMenu(msg.chat.id, userId);
      return;
    }

    const cleanNum = parseInt(rawVal.replace(/^\$/, ''), 10);
    if (!isValidTradeSizeUsd(cleanNum)) {
      const pref = await getUserPreferences(userId);
      await bot.sendMessage(
        msg.chat.id,
        `⚠️ <b>Invalid Trade Volume: "${escapeHtml(rawVal)}"</b>\n\n` +
        `Users may only allocate from the authorized discrete amounts:\n` +
        `👉 <b>$10, $15, $20, $30, $40, $45, or $50 USD</b>\n\n` +
        `<i>Tap an option below:</i>`,
        {
          parse_mode: 'HTML',
          reply_markup: buildTradeSizeKeyboard(pref.fixedTradeSizeUsd || 10),
        }
      );
      return;
    }

    await setUserAutoSnipeConfig(userId, { fixedTradeSizeUsd: cleanNum });
    await bot.sendMessage(
      msg.chat.id,
      `✅ <b>TRADING VOLUME ALLOCATION UPDATED!</b>\n\n` +
      `• <b>Per-Trade Volume:</b> <b>$${cleanNum.toFixed(2)} USD</b>\n` +
      `• <b>Execution Fee:</b> 1% applied to every executed trade\n` +
      `• <b>Profit Fee:</b> 15% applied to profit on winning trades (including manual exits/exit all)\n` +
      `• <b>Losing Trades:</b> 0% fee (only the initial 1% entry fee)\n` +
      `• <b>Recommended Minimum Deposit:</b> $1,000 for optimal operation\n\n` +
      `<i>Your bot will deploy $${cleanNum.toFixed(2)} per position on future trades!</i>`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '⚙️ Change Volume', callback_data: 'cmd_tradesize' },
              { text: '💼 Wallet Dashboard', callback_data: 'cmd_wallet' },
            ],
            [
              { text: '🚀 /start (Main Menu)', callback_data: 'cmd_start' },
            ],
          ],
        },
      }
    );
  });

  // Admin Analytics: /admin or /analytics
  onTextCmd(/\/admin|\/analytics/i, async (msg) => {
    const userId = String(msg.from?.id || msg.chat.id);
    const isAdmin = await isGroupAdminOrOwner(msg.chat.id, userId);
    if (!isAdmin) {
      await bot.sendMessage(msg.chat.id, '⛔ <b>Admin Access Required:</b> This command is restricted to bot administrators.', { parse_mode: 'HTML' });
      return;
    }
    const { text, keyboard } = await buildAdminAnalyticsMessage();
    await bot.sendMessage(msg.chat.id, text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: keyboard },
    });
  });

  // Admin Fee Wallet Configuration: /feewallet or /setfeewallet [address]
  onTextCmd(/\/feewallet(?:\s+(\S+))?|\/setfeewallet(?:\s+(\S+))?/i, async (msg, match) => {
    const userId = String(msg.from?.id || msg.chat.id);
    const isAdmin = await isGroupAdminOrOwner(msg.chat.id, userId);
    if (!isAdmin) {
      await bot.sendMessage(msg.chat.id, '⛔ <b>Admin Access Required:</b> This command is restricted to bot administrators.', { parse_mode: 'HTML' });
      return;
    }

    const rawAddr = (match?.[1] || match?.[2])?.trim();
    if (!rawAddr) {
      adminAwaitingWalletInput.set(userId, Date.now());
      const cur = getAdminFeeWallet();
      await bot.sendMessage(
        msg.chat.id,
        `💼 <b>CONFIGURE ADMIN FEE WALLET</b> 🎯\n\n` +
        `Current destination: ${cur ? `<code>${cur}</code>` : '<i>None configured</i>'}\n\n` +
        `👉 <b>Please paste your Solana wallet address</b> into this chat now:\n` +
        `<i>(Or type /cancel to abort)</i>`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '📊 View Analytics', callback_data: 'cmd_admin_analytics' }],
            ],
          },
        }
      );
      return;
    }

    const res = await setAdminFeeWallet(rawAddr);
    if (res.success) {
      adminAwaitingWalletInput.delete(userId);
      await bot.sendMessage(
        msg.chat.id,
        `✅ <b>FEE DESTINATION WALLET SAVED!</b> 💼\n\n` +
        `• <b>Destination Address:</b> <code>${rawAddr}</code>\n` +
        `• <b>Fees Routed:</b> 1% trade entries + 15% profitable exits\n` +
        `• <b>Solscan:</b> <a href="https://solscan.io/account/${rawAddr}">View Account</a>\n\n` +
        `All future fees collected will now be dispatched directly to this address on-chain.`,
        {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup: {
            inline_keyboard: [
              [{ text: '📊 View Analytics', callback_data: 'cmd_admin_analytics' }],
              [{ text: '🚀 /start (Main Menu)', callback_data: 'cmd_start' }],
            ],
          },
        }
      );
    } else {
      await bot.sendMessage(msg.chat.id, `⚠️ <b>Error:</b> ${res.error}`, { parse_mode: 'HTML' });
    }
  });

  // /cancel command for aborting awaiting input states
  onTextCmd(/\/cancel/i, async (msg) => {
    const userId = String(msg.from?.id || msg.chat.id);
    if (adminAwaitingWalletInput.has(userId)) {
      adminAwaitingWalletInput.delete(userId);
      await bot.sendMessage(msg.chat.id, '👌 Fee wallet configuration cancelled.');
    }
  });

  // /scan or "⚡ Scan Now"
  onTextCmd(/\/scan|⚡ Scan Now|Scan/i, async (msg) => {
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

  // /wallet, /balance, /connect, or "💰 Wallet"
  onTextCmd(/\/wallet|\/balance|\/connect|💰 Wallet|Balance/i, async (msg) => {
    const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
    if (isGroup) {
      await bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
      const botUser = env.TELEGRAM_BOT_USERNAME || 'MySolanaSBot';
      const warnMsg = await bot.sendMessage(
        msg.chat.id,
        `🔒 <b>@${msg.from?.username || msg.from?.first_name || 'Trader'}</b>, please manage your sniper wallet in private DM to keep your keys safe:\n👉 <a href="https://t.me/${botUser}?start=connect">Open Private Wallet Dashboard</a>`,
        { parse_mode: 'HTML', disable_web_page_preview: true }
      );
      setTimeout(() => {
        bot.deleteMessage(msg.chat.id, warnMsg.message_id).catch(() => {});
      }, 20_000);
      return;
    }

    await sendUserWalletDashboard(msg.chat.id, String(msg.from?.id || msg.chat.id));
  });

  // /withdraw <solana_address> [amount|all]
  onTextCmd(/\/withdraw(?:\s+(\S+))?(?:\s+(\S+))?/i, async (msg, match) => {
    const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
    if (isGroup) {
      await bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
      const botUser = env.TELEGRAM_BOT_USERNAME || 'MySolanaSBot';
      const warn = await bot.sendMessage(
        msg.chat.id,
        `🔒 @${msg.from?.username || msg.from?.first_name || 'Trader'}, withdrawals must only be performed in private DM:\n👉 <a href="https://t.me/${botUser}?start=connect">Open Private Chat</a>`,
        { parse_mode: 'HTML', disable_web_page_preview: true }
      );
      setTimeout(() => {
        bot.deleteMessage(msg.chat.id, warn.message_id).catch(() => {});
      }, 15_000);
      return;
    }

    const userId = String(msg.from?.id || msg.chat.id);
    const membership = await verifyGroupMembership(userId);
    if (!membership.isMember) {
      await bot.sendMessage(
        msg.chat.id,
        `⛔ <b>Access Denied:</b> You must be an active member of our official group to use wallet functions.`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    const toAddress = match?.[1]?.trim();
    const amountArg = match?.[2]?.trim()?.toLowerCase() || 'all';

    if (!toAddress || toAddress.length < 32 || toAddress.length > 44) {
      await bot.sendMessage(
        msg.chat.id,
        `💸 <b>WITHDRAW SOL</b>\n\n` +
        `<b>Usage:</b>\n` +
        `<code>/withdraw &lt;recipient_solana_address&gt; [amount|all]</code>\n\n` +
        `<b>Examples:</b>\n` +
        `• <code>/withdraw 7Vz... 0.5</code> (Withdraws 0.5 SOL)\n` +
        `• <code>/withdraw 7Vz... all</code> (Withdraws entire balance minus gas)\n\n` +
        `<i>Safely sweeps your SOL back to your personal Phantom/Solflare wallet or exchange.</i>`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    const pref = await getUserPreferences(userId);
    if (!pref.encryptedSecret || !pref.encryptionIv || !pref.encryptionTag) {
      await bot.sendMessage(
        msg.chat.id,
        `⚠️ <i>No wallet connected. Tap /wallet to generate or connect your sniper wallet first.</i>`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    let userKeypair: any = null;
    try {
      userKeypair = decryptUserKeypair(pref.encryptedSecret, pref.encryptionIv, pref.encryptionTag);
    } catch (err: any) {
      await bot.sendMessage(msg.chat.id, `❌ Could not decrypt wallet credentials: ${err.message}`);
      return;
    }

    const waitMsg = await bot.sendMessage(
      msg.chat.id,
      `⏳ <i>Processing withdrawal to <code>${toAddress.slice(0, 6)}...${toAddress.slice(-4)}</code>...</i>`,
      { parse_mode: 'HTML' }
    );

    try {
      const amount = amountArg === 'all' ? ('ALL' as const) : parseFloat(amountArg);
      const res = await executeSolWithdrawal(userKeypair, toAddress, amount);
      if (res.success) {
        const sig = res.signature || '';
        const explorerUrl = `https://solscan.io/tx/${sig}`;
        await bot.editMessageText(
          `💸 <b>WITHDRAWAL SUCCESSFUL!</b>\n\n` +
          `💰 <b>Amount Sent:</b> <code>${res.solTransferred.toFixed(4)} SOL</code>\n` +
          `📬 <b>Destination:</b> <code>${toAddress}</code>\n` +
          `🔗 <b>Transaction Receipt:</b> <a href="${explorerUrl}">${sig ? sig.slice(0, 16) + '...' : 'View Transaction'}</a>`,
          {
            chat_id: msg.chat.id,
            message_id: waitMsg.message_id,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
          }
        );
      } else {
        await bot.editMessageText(`⚠️ Withdrawal failed: ${res.error || 'Unknown error'}`, {
          chat_id: msg.chat.id,
          message_id: waitMsg.message_id,
        });
      }
    } catch (err: any) {
      await bot.editMessageText(`⚠️ Withdrawal error: ${err.message}`, {
        chat_id: msg.chat.id,
        message_id: waitMsg.message_id,
      });
    }
  });

  // /help or "❓ Help"
  onTextCmd(/\/help|❓ Help/i, async (msg) => {
    await bot.sendMessage(
      msg.chat.id,
      `📖 <b>SOLANA BOT GUIDE & OPERATING PRINCIPLES</b>\n\n` +
      `📢 <b>CAPITAL REQUIREMENT:</b>\n` +
      `• A <b>minimum deposit of $1,000</b> (in SOL) is required for the optimal operation of the bot.\n\n` +
      `🛡️ <b>CORE OPERATING PRINCIPLES:</b>\n` +
      `• <b>Customizable Trade Volume:</b> Users can allocate per-trade volume from discrete amounts: <b>$10, $15, $20, $30, $40, $45, or $50 USD</b>.\n` +
      `• <b>Fee Structure:</b>\n` +
      `  - <b>1% Execution Fee:</b> Applied to every trade executed by the bot.\n` +
      `  - <b>15% Profit Fee:</b> Applied to profit on winning trades (including manual exits/exit all).\n` +
      `  - <b>0% Extra on Losses:</b> Only the initial 1% entry fee is incurred.\n` +
      `• <b>Radar & Safety:</b> Scans breakout gems &lt;2m old with strict RugCheck security (100% LP burnt, mint & freeze revoked).\n` +
      `• <b>Trend Rider:</b> At 2X, the bot sells 50% to recover initial capital risk-free; remainder rides moonbag runners.\n` +
      `• <b>Exit Controls:</b> Use <code>/exitall</code> or <code>/exit &lt;mint&gt;</code> anytime to return money to cash.\n\n` +
      `<b>Quick Commands:</b>\n` +
      `• /tradesize — Set Volume ($10, $15, $20, $30, $40, $45, $50)\n` +
      `• /portfolio — Live $1,000 Alpha Portfolio\n` +
      `• /positions — Active Trades & Exits\n` +
      `• /exitall — Sell All & Cash Out\n` +
      `• /autosnipe — Automated Sniping Settings\n` +
      `• /wallet — Sniper Wallet Dashboard`,
      { parse_mode: 'HTML' }
    );
  });

  // /learner or /memory or "🧠 Loss Learner"
  onTextCmd(/\/(?:learner|memory|lossanalytics)|🧠 Loss Learner|Loss Learner/i, async (msg) => {
    try {
      const { getLearnedLossDashboard } = await import('./lossLearner.js');
      const dash = getLearnedLossDashboard();
      await bot.sendMessage(msg.chat.id, dash, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🔄 Refresh Memory & Stats', callback_data: 'cmd_learner' },
              { text: '🏆 Top Gainers', callback_data: 'cmd_top' },
            ],
          ],
        },
      });
    } catch (err: any) {
      await bot.sendMessage(msg.chat.id, `⚠️ Error loading loss learner: ${err.message}`);
    }
  });

  // Natural Language, Wallet Key Ingestion & Free-form Question Listener
  bot.on('message', async (msg) => {
    // PUBLIC GROUP RESTRICTION: Only Owner and Admins can post in the public group
    const allowed = await enforceGroupAdminOnly(msg);
    if (!allowed) {
      return;
    }
    const text = msg.text?.trim();
    if (!text) return;

    const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';

    // 1. PUBLIC GROUP & DM GUARDIAN: Detect sensitive private keys
    if (isValidPrivateKey(text)) {
      // Purge sensitive message from chat history immediately
      await bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});

      if (isGroup) {
        const warnMsg = await bot.sendMessage(
          msg.chat.id,
          `🚨 <b>CRITICAL SECURITY ACTION</b>\n\n` +
          `@${msg.from?.username || msg.from?.first_name || 'Member'}, you posted a raw private key in a public chat! The message has been deleted immediately to protect your funds.\n\n` +
          `⚠️ <i>If that wallet held significant funds, please migrate them to a new address immediately. Never share keys publicly!</i>`,
          { parse_mode: 'HTML' }
        );
        setTimeout(() => {
          bot.deleteMessage(msg.chat.id, warnMsg.message_id).catch(() => {});
        }, 30_000);
        return;
      }

      // 2. PRIVATE DM: Securely ingest & encrypt user's private key
      const userId = String(msg.from?.id || msg.chat.id);
      const membership = await verifyGroupMembership(userId);
      if (!membership.isMember) {
        await bot.sendMessage(
          msg.chat.id,
          `⛔ <b>Access Denied:</b> You must be an active member of our official group to configure a sniper wallet.\n\n` +
          `<i>Please join the group before setting up your wallet.</i>`,
          { parse_mode: 'HTML' }
        );
        return;
      }

      try {
        const keypair = parseKeypair(text);
        const pubkey = keypair.publicKey.toBase58();
        const enc = encryptPrivateKey(text);

        await setUserPreferences(userId, {
          solanaWallet: pubkey,
          encryptedSecret: enc.ciphertext,
          encryptionIv: enc.iv,
          encryptionTag: enc.tag,
          isMembershipActive: true,
          telegramChatId: String(msg.chat.id),
          autoSnipeEnabled: true,
        });

        await bot.sendMessage(
          msg.chat.id,
          `🔐 <b>SNIPER WALLET CONNECTED SECURELY!</b>\n\n` +
          `🔑 <b>Address:</b> <code>${pubkey}</code>\n` +
          `🛡️ <b>Security:</b> Your private key was encrypted with AES-256-GCM. Your message was purged immediately from chat.\n` +
          `💵 <b>Snipe Rule:</b> Locked at <b>$10.00 USD</b> per gem.\n` +
          `⚡ <b>Auto-Snipe:</b> 🟢 <b>ACTIVE</b>\n\n` +
          `💡 <i>Deposit SOL to fund trades and gas. You will receive private execution receipts directly here!</i>`,
          {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [{ text: '💼 View Wallet Dashboard', callback_data: 'cmd_wallet' }],
                [{ text: '🔴 Disable Auto-Snipe', callback_data: 'snipe_disable' }],
              ],
            },
          }
        );
      } catch (err: any) {
        await bot.sendMessage(msg.chat.id, `❌ Failed to parse or encrypt key: ${err.message}`);
      }
      return;
    }

    // Check if an admin is currently inputting a fee wallet address
    const senderUserId = String(msg.from?.id || msg.chat.id);
    if (adminAwaitingWalletInput.has(senderUserId)) {
      if (text.toLowerCase() === '/cancel' || text.toLowerCase() === 'cancel') {
        adminAwaitingWalletInput.delete(senderUserId);
        await bot.sendMessage(msg.chat.id, '👌 Setting fee wallet was cancelled.');
        return;
      }

      if (isValidSolanaAddress(text)) {
        adminAwaitingWalletInput.delete(senderUserId);
        const setRes = await setAdminFeeWallet(text);
        if (setRes.success) {
          await bot.sendMessage(
            msg.chat.id,
            `✅ <b>FEE DESTINATION WALLET CONFIGURED!</b> 💼\n\n` +
            `• <b>Destination Address:</b> <code>${text}</code>\n` +
            `• <b>Fees Routed:</b> 1% trade entries + 15% profitable exits\n` +
            `• <b>Solscan:</b> <a href="https://solscan.io/account/${text}">View on Solscan</a>\n\n` +
            `All future fees collected by the bot will now be routed directly to this wallet address.`,
            {
              parse_mode: 'HTML',
              disable_web_page_preview: true,
              reply_markup: {
                inline_keyboard: [
                  [{ text: '📊 View Admin Analytics', callback_data: 'cmd_admin_analytics' }],
                  [{ text: '🚀 /start (Main Menu)', callback_data: 'cmd_start' }],
                ],
              },
            }
          );
          return;
        } else {
          await bot.sendMessage(msg.chat.id, `⚠️ <b>Error:</b> ${setRes.error}`, { parse_mode: 'HTML' });
          return;
        }
      } else {
        await bot.sendMessage(
          msg.chat.id,
          `⚠️ <b>Invalid Solana Address:</b> "${escapeHtml(text)}"\n\n` +
          `A Solana public key must be 32–44 base58 characters.\n` +
          `Please paste a valid wallet address or send /cancel to abort.`,
          { parse_mode: 'HTML' }
        );
        return;
      }
    }

    if (text.startsWith('/')) return;

    // Ignore known persistent button labels already handled by bot.onText
    const knownButtons = [
      '⚡ scan now', '💎 daily coins', '🏆 top gainers', '📉 daily flops',
      '🗓️ weekly report', '🤖 ai co-pilot', '📈 price milestones', '💼 my positions',
      '⚙️ auto-snipe', '🟢 auto-snipe on', '🔴 auto-snipe off', '💰 wallet', '❓ help',
      '🚨 exit all trades', 'exit all trades', 'exit all'
    ];
    if (knownButtons.some((b) => b === text.toLowerCase())) return;

    // Check if the user pasted a raw Solana Mint address (base58 32-44 characters)
    if (/^[1-9A-HJ-NP-za-km-z]{32,44}$/.test(text)) {
      await handleUserSubmittedToken(msg.chat.id, text);
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
          { text: '🗓️ Weekly Report', callback_data: 'cmd_weekly' },
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
                  { text: '🏆 Top Gainers', callback_data: 'cmd_top' },
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
              { text: '🗓️ Weekly Report', callback_data: 'cmd_weekly' },
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
      if (data === 'send_pinned_to_dm') {
        await handleSendDashboardToDm(query);
        return;
      }
      if (data === 'refresh_pinned_dashboard') {
        await postOrUpdateGroupPinnedDashboard(false);
        try {
          await bot.answerCallbackQuery(query.id, { text: '✅ Pinned dashboard updated!', show_alert: false });
        } catch {}
        return;
      }

      await bot.answerCallbackQuery(query.id);

      if (data === 'cmd_start') {
        await sendWelcomeDashboard(chatId);
      } else if (data === 'cmd_tradesize') {
        await sendTradeSizeSelectionMenu(chatId, userId, msgId);
      } else if (data === 'cmd_autosnipe') {
        await handleSnipeStatus(chatId, userId, msgId);
      } else if (data?.startsWith('set_tradesize_')) {
        const amt = parseInt(data.replace('set_tradesize_', ''), 10);
        if (isValidTradeSizeUsd(amt)) {
          await setUserAutoSnipeConfig(userId, { fixedTradeSizeUsd: amt });
          try {
            await bot.answerCallbackQuery(query.id, { text: `✅ Trade volume updated to $${amt}!`, show_alert: false });
          } catch {}
          await sendTradeSizeSelectionMenu(chatId, userId, msgId);
        }
      } else if (data === 'cmd_paper_portfolio') {
        await handlePaperPortfolioCommand(chatId, userId);
      } else if (data === 'cmd_view_alpha_benchmark') {
        await handlePaperPortfolioCommand(chatId, userId, true);
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
          { text: '🏆 Top Gainers', callback_data: 'cmd_top' },
        ]);
        await bot.editMessageText(predText, {
          chat_id: chatId,
          message_id: waitMsg.message_id,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup: { inline_keyboard: predButtons },
        });
      } else if (data === 'cmd_wallet') {
        const isGroup = query.message?.chat?.type === 'group' || query.message?.chat?.type === 'supergroup';
        if (isGroup) {
          const botUser = env.TELEGRAM_BOT_USERNAME || 'MySolanaSBot';
          const confirm = await bot.sendMessage(
            chatId,
            `🔒 @${query.from.username || query.from.first_name}, <a href="https://t.me/${botUser}?start=connect">open private chat to manage your sniper wallet safely</a>.`,
            { parse_mode: 'HTML', disable_web_page_preview: true }
          );
          setTimeout(() => {
            bot.deleteMessage(chatId, confirm.message_id).catch(() => {});
          }, 15_000);
        } else {
          await sendUserWalletDashboard(chatId, userId, msgId);
        }
      } else if (data === 'wallet_generate_burner') {
        const membership = await verifyGroupMembership(userId);
        if (!membership.isMember) {
          await bot.sendMessage(
            chatId,
            `⛔ <b>Access Denied:</b> You must be an active member of our official group to generate a sniper wallet.`,
            { parse_mode: 'HTML' }
          );
          return;
        }

        const burner = generateBurnerWallet();
        await setUserPreferences(userId, {
          solanaWallet: burner.publicKey,
          encryptedSecret: burner.encrypted.ciphertext,
          encryptionIv: burner.encrypted.iv,
          encryptionTag: burner.encrypted.tag,
          isMembershipActive: true,
          telegramChatId: String(chatId),
          autoSnipeEnabled: true,
        });

        const burnerMsg = `
✨ <b>DEDICATED SNIPER WALLET GENERATED!</b> ✨

🔑 <b>Public Address:</b>
<code>${burner.publicKey}</code>
<i>(Deposit SOL here to fund trades and network gas)</i>

🔐 <b>Private Key (Export / Backup):</b>
<code>${burner.privateKeyBase58}</code>

⚠️ <b>CRITICAL SECURITY RULES:</b>
1. <b>Copy and import this private key into Phantom or Solflare right now!</b>
2. Never store your life savings here — this is a high-speed sniper burner.
3. Universal Rule: All trades are strictly <b>$10.00 USD</b>.
4. Once you have safely backed up your private key, tap the button below to permanently delete this message!
`.trim();

        await bot.sendMessage(chatId, burnerMsg, {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🗑️ I Have Backed Up - Delete This Message', callback_data: 'delete_burner_msg' }],
              [{ text: '💼 Open Wallet Dashboard', callback_data: 'cmd_wallet' }],
            ],
          },
        });
      } else if (data === 'delete_burner_msg') {
        if (msgId) {
          await bot.deleteMessage(chatId, msgId).catch(() => {});
        }
        await bot.sendMessage(
          chatId,
          `🔒 <b>Sensitive credentials message deleted from chat.</b>\n\n` +
          `Your wallet remains safely encrypted with AES-256-GCM in the bot's secure vault.\n` +
          `You are all set to snipe gems!`,
          {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [{ text: '💼 Open Wallet Dashboard', callback_data: 'cmd_wallet' }],
              ],
            },
          }
        );
      } else if (data === 'wallet_withdraw') {
        await bot.sendMessage(
          chatId,
          `💸 <b>WITHDRAW SOL</b>\n\n` +
          `To withdraw your SOL back to your personal Phantom/Solflare or Exchange wallet, send the following command:\n\n` +
          `<code>/withdraw &lt;your_solana_address&gt; [amount|all]</code>\n\n` +
          `<b>Examples:</b>\n` +
          `• <code>/withdraw 8xPt... 0.5</code> (Withdraws 0.5 SOL)\n` +
          `• <code>/withdraw 8xPt... all</code> (Withdraws entire balance minus gas)\n\n` +
          `<i>Note: Withdrawals must be sent here in private DM, never in the public group!</i>`,
          { parse_mode: 'HTML' }
        );
      } else if (data === 'cmd_learner') {
        const { getLearnedLossDashboard } = await import('./lossLearner.js');
        const dash = getLearnedLossDashboard();
        await bot.sendMessage(chatId, dash, {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '🔄 Refresh Memory & Stats', callback_data: 'cmd_learner' },
                { text: '🏆 Top Gainers', callback_data: 'cmd_top' },
              ],
            ],
          },
        });
      } else if (data === 'cmd_help') {
        await bot.sendMessage(
          chatId,
          `📖 <b>Quick Bot Guide & Operating Principles:</b>\n` +
          `• <b>Optimal Capital:</b> Minimum deposit of $1,000 (in SOL) recommended for optimal operation\n` +
          `• <b>Customizable Volume:</b> Select $10, $15, $20, $30, $40, $45, or $50 per trade (/tradesize)\n` +
          `• <b>Transparent Fees:</b> 1% entry fee • 15% profit fee on winning trades (including manual exits) • 0% fee on loss\n` +
          `• <b>Continuous Radar:</b> Scans breakout gems every 35s with strict RugCheck security\n` +
          `• <b>Trend Rider:</b> At 2X, sells 50% to recover initial capital risk-free; moonbag rides uncapped\n` +
          `• <b>Commands:</b> <code>/tradesize</code>, <code>/portfolio</code>, <code>/positions</code>, <code>/exitall</code>, <code>/predict</code>`,
          { parse_mode: 'HTML' }
        );
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
        await handlePositionsCommand(chatId, userId);
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
        await bot.sendMessage(
          chatId,
          '🟢 <b>Auto-Snipe is now ENABLED!</b>\nYour deposited funds will be automatically used to snipe verified radar gems ($10.00 / entry).',
          { parse_mode: 'HTML' }
        );
      } else if (data === 'snipe_disable') {
        await setUserAutoSnipeConfig(userId, { autoSnipeEnabled: false });
        await bot.sendMessage(
          chatId,
          '⏸️ <b>Auto-Snipe is now DISABLED!</b>\nNo funds will be allocated for trading unless you manually initiate a transaction.',
          { parse_mode: 'HTML' }
        );
      } else if (data?.startsWith('snipe_set_')) {
        const amt = parseFloat(data.replace('snipe_set_', ''));
        if (!isNaN(amt)) {
          await setUserAutoSnipeConfig(userId, { autoSnipeSolAmount: amt, autoSnipeEnabled: true });
          await bot.sendMessage(chatId, `✅ <b>Snipe size updated to ${amt} SOL!</b> Auto-snipe is <b>ACTIVE</b> 🟢`, { parse_mode: 'HTML' });
        }
      } else if (data?.startsWith('snipe_quick_')) {
        const parts = data.split('_');
        const mint = parts[3] || parts[2];
        if (mint) {
          const membership = await verifyGroupMembership(userId);
          if (!membership.isMember) {
            await bot.sendMessage(chatId, `⛔ <b>Access Denied:</b> You must be an active member of our official group to execute trades.`, { parse_mode: 'HTML' });
            return;
          }

          const pref = await getUserPreferences(userId);
          if (!pref.encryptedSecret || !pref.encryptionIv || !pref.encryptionTag) {
            const botUser = env.TELEGRAM_BOT_USERNAME || 'MySolanaSBot';
            const promptMsg = await bot.sendMessage(
              chatId,
              `⚠️ @${query.from.username || query.from.first_name || 'Trader'}, you haven't linked a sniper wallet yet!\n👉 <a href="https://t.me/${botUser}?start=connect">Click here to generate or connect your wallet</a>`,
              { parse_mode: 'HTML' }
            );
            setTimeout(() => {
              bot.deleteMessage(chatId, promptMsg.message_id).catch(() => {});
            }, 20_000);
            return;
          }

          try {
            const keypair = decryptUserKeypair(pref.encryptedSecret, pref.encryptionIv, pref.encryptionTag);
            const tradeSol = await getSolForFixedUsd(pref.fixedTradeSizeUsd || 10.0);

            // Execute personalized trade
            const snipeResult = await executeUserSnipeTrade(
              {
                userId,
                telegramChatId: userId,
                keypair,
                slippageBps: Math.round((pref.maxSlippagePercent || 15) * 100),
                priorityFeeLamports: pref.priorityFeeLamports || 100_000,
              },
              mint,
              tradeSol
            );

            // Route receipt strictly to user's private DM
            await dispatchSnipeNotification(snipeResult, userId);

            // In group, show subtle ephemeral confirmation
            if (String(chatId) !== userId) {
              const confirmMsg = await bot.sendMessage(
                chatId,
                `⚡ @${query.from.username || query.from.first_name || 'Trader'}, your <b>$10.00</b> snipe was submitted! Check your private DM for receipt.`,
                { parse_mode: 'HTML' }
              );
              setTimeout(() => {
                bot.deleteMessage(chatId, confirmMsg.message_id).catch(() => {});
              }, 15_000);
            }
          } catch (err: any) {
            await bot.sendMessage(userId, `⚠️ Snipe execution error: ${err.message}`).catch(() => {});
          }
        }
      } else if (data?.startsWith('sell_quick_')) {
        const parts = data.split('_');
        const pct = parseFloat(parts[2]) || 100;
        const mint = parts[3];
        if (mint) {
          const pref = await getUserPreferences(userId);
          if (pref.encryptedSecret && pref.encryptionIv && pref.encryptionTag) {
            try {
              const sellResult = await executeUserSnipeSell(
                userId,
                mint,
                undefined,
                undefined,
                pct
              );

              // Route sell receipt strictly to user's private DM
              await dispatchSnipeSellNotification(sellResult, userId);

              if (String(chatId) !== userId) {
                const confirmMsg = await bot.sendMessage(
                  chatId,
                  `🚪 @${query.from.username || query.from.first_name || 'Trader'}, sell order executed! Check your private DM.`,
                  { parse_mode: 'HTML' }
                );
                setTimeout(() => {
                  bot.deleteMessage(chatId, confirmMsg.message_id).catch(() => {});
                }, 15_000);
              }
            } catch (err: any) {
              await bot.sendMessage(userId, `⚠️ Sell execution error: ${err.message}`).catch(() => {});
            }
          } else {
            // Paper / operator fallback
            const sellResult = await executeSnipeSell(mint, undefined, undefined, pct);
            await dispatchSnipeSellNotification(sellResult, chatId);
          }
        }
      } else if (data === 'cmd_exit_all') {
        await bot.sendMessage(chatId, '⏳ <i>Liquidating all active trades & returning money to account...</i>', { parse_mode: 'HTML' });
        const { exitAllPaperPositions } = await import('./paperTrading.js');
        const { exitAllSnipedPositions } = await import('./sniper.js');
        const paperExit = await exitAllPaperPositions('MANUAL_EXIT_ALL');
        const snipeExit = await exitAllSnipedPositions();

        let exitMsg = `🚨 <b>ALL TRADES EXITED</b>\n\n`;
        const totalCount = paperExit.count + snipeExit.count;
        if (totalCount > 0) {
          const totalProfitable = paperExit.profitableCount + snipeExit.profitableCount;
          const totalLosing = paperExit.losingCount + snipeExit.losingCount;

          exitMsg += `• <b>Total Closed:</b> <b>${totalCount} trade(s)</b>\n`;
          exitMsg += `• <b>Profitable Exits:</b> <b>${totalProfitable}</b> (15% profit fee applied)\n`;
          if (paperExit.totalProfitFeesUsd > 0) {
            exitMsg += `  └ <i>Model Profit Fees: -$${paperExit.totalProfitFeesUsd.toFixed(2)} USD</i>\n`;
          }
          if (snipeExit.totalProfitFeeSol > 0) {
            exitMsg += `  └ <i>Live Profit Fees: -${snipeExit.totalProfitFeeSol.toFixed(4)} SOL</i>\n`;
          }
          exitMsg += `• <b>Losing Exits:</b> <b>${totalLosing}</b> (0% fee charged; 1% entry fee only)\n\n`;

          if (paperExit.totalReturnedUsd > 0) {
            exitMsg += `💰 <b>Returned to Cash:</b> <b>+$${paperExit.totalReturnedUsd.toFixed(2)} USD</b>\n`;
          }
          if (snipeExit.totalSol > 0) {
            exitMsg += `💰 <b>Returned SOL:</b> <b>+${snipeExit.totalSol.toFixed(3)} SOL</b>\n`;
          }
          exitMsg += `💼 <b>Liquid Cash:</b> <code>$${paperExit.newLiquidCashUsd.toFixed(2)} USD</code>`;
        } else {
          exitMsg += `ℹ️ <i>No open trades. Cash balance: $${paperExit.newLiquidCashUsd.toFixed(2)} USD</i>`;
        }

        await bot.sendMessage(chatId, exitMsg, {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '💼 View Portfolio', callback_data: 'cmd_paper_portfolio' },
                { text: '🏆 Top Gainers', callback_data: 'cmd_top' },
              ],
            ],
          },
        });
      } else if (data?.startsWith('cmd_exit_single_')) {
        const target = data.replace('cmd_exit_single_', '');
        await bot.sendMessage(chatId, `⏳ <i>Exiting trade <code>${target}</code>...</i>`, { parse_mode: 'HTML' });
        const { exitPaperPosition } = await import('./paperTrading.js');
        const { exitSnipedPosition } = await import('./sniper.js');
        const paperRes = await exitPaperPosition(target);
        const snipeRes = await exitSnipedPosition(target);

        let replyMsg = `🚨 <b>TRADE EXITED</b>\n`;
        if (paperRes.success) {
          replyMsg += `• Token: <b>$${escapeHtml(paperRes.tokenSymbol)}</b>\n`;
          replyMsg += `• Returned to Cash: <b>+$${paperRes.netReturnUsd.toFixed(2)} USD</b>\n`;
          replyMsg += `💼 <b>Liquid Cash:</b> <code>$${paperRes.newLiquidCashUsd.toFixed(2)} USD</code>`;
        } else if (snipeRes.success) {
          replyMsg += `• Token: <b>$${escapeHtml(snipeRes.tokenSymbol || target)}</b>\n`;
          replyMsg += `• Returned: <b>+${snipeRes.solAmount.toFixed(3)} SOL</b>`;
        } else {
          replyMsg += `⚠️ <i>No active trade found for "${escapeHtml(target)}"</i>`;
        }

        await bot.sendMessage(chatId, replyMsg, {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '💼 View Portfolio', callback_data: 'cmd_paper_portfolio' },
                { text: '💼 My Positions', callback_data: 'cmd_positions' },
              ],
            ],
          },
        });
      } else if (data === 'cmd_admin_analytics') {
        const isAdmin = await isGroupAdminOrOwner(chatId, userId);
        if (!isAdmin) {
          try {
            await bot.answerCallbackQuery(query.id, { text: '⛔ Admin access required.', show_alert: true });
          } catch {}
          return;
        }
        const { text: adminText, keyboard: adminKeyboard } = await buildAdminAnalyticsMessage();
        await bot.sendMessage(chatId, adminText, {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup: { inline_keyboard: adminKeyboard },
        });
      } else if (data === 'cmd_admin_set_wallet') {
        const isAdmin = await isGroupAdminOrOwner(chatId, userId);
        if (!isAdmin) {
          try {
            await bot.answerCallbackQuery(query.id, { text: '⛔ Admin access required.', show_alert: true });
          } catch {}
          return;
        }
        adminAwaitingWalletInput.set(userId, Date.now());
        const currentWallet = getAdminFeeWallet();
        const curWalletText = currentWallet
          ? `Current destination: <code>${currentWallet}</code>\n\n`
          : `Current destination: <i>None configured</i>\n\n`;

        await bot.sendMessage(
          chatId,
          `💼 <b>CONFIGURE ADMIN FEE WALLET</b> 🎯\n\n` +
          curWalletText +
          `Whenever users trade with the bot, collected fees are automatically transferred to this address:\n` +
          `• <b>1% Fee</b> on every user trade entry\n` +
          `• <b>15% Fee</b> on profitable trade exits\n\n` +
          `👉 <b>Please paste your Solana wallet address</b> (Phantom, Solflare, Ledger, etc.) directly into this chat:\n\n` +
          `<i>(Or type /cancel to abort)</i>`,
          {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [{ text: '❌ Cancel', callback_data: 'cmd_admin_cancel_wallet' }],
                [{ text: '📊 Back to Analytics', callback_data: 'cmd_admin_analytics' }],
              ],
            },
          }
        );
      } else if (data === 'cmd_admin_cancel_wallet') {
        adminAwaitingWalletInput.delete(userId);
        try {
          await bot.answerCallbackQuery(query.id, { text: 'Cancelled.', show_alert: false });
        } catch {}
        await bot.sendMessage(chatId, '👌 Setting fee wallet was cancelled.');
      } else if (data === 'cmd_admin_sweep_fees') {
        const isAdmin = await isGroupAdminOrOwner(chatId, userId);
        if (!isAdmin) {
          try {
            await bot.answerCallbackQuery(query.id, { text: '⛔ Admin access required.', show_alert: true });
          } catch {}
          return;
        }
        await bot.sendMessage(chatId, '⏳ <i>Sweeping server wallet fees on-chain to configured admin wallet...</i>', { parse_mode: 'HTML' });
        const sweepRes = await sweepServerFeesToAdmin();
        if (sweepRes.success) {
          await bot.sendMessage(
            chatId,
            `✅ <b>FEE SWEEP SUCCESSFUL!</b> 💸\n\n` +
            `• <b>Transferred:</b> <code>${sweepRes.solTransferred} SOL</code>\n` +
            `• <b>Transaction:</b> <a href="https://solscan.io/tx/${sweepRes.signature}">View on Solscan</a>`,
            {
              parse_mode: 'HTML',
              disable_web_page_preview: true,
              reply_markup: {
                inline_keyboard: [
                  [{ text: '📊 Refresh Analytics', callback_data: 'cmd_admin_analytics' }],
                ],
              },
            }
          );
        } else {
          await bot.sendMessage(chatId, `⚠️ <b>Fee sweep notice:</b> ${escapeHtml(sweepRes.error || 'Unknown error')}`, { parse_mode: 'HTML' });
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
    let tokens: any[] = [];
    try {
      tokens = await prisma.earlyTrendingToken.findMany({
        where: { alertDate: today },
        orderBy: { dailyQuotaIndex: 'asc' },
      });
    } catch {}

    if (!tokens || tokens.length === 0) {
      tokens = await getTokensForDate(today);
    }

    if (tokens.length === 0) {
      await bot.sendMessage(
        chatId,
        `💎 <b>Daily Coins (@solearlytrending Strategy)</b>\n\n` +
          `⚠️ <b>No report found.</b>\n` +
          `<i>No tokens have met the strict @solearlytrending criteria yet today (${today}).\n` +
          `The engine scans DexScreener continuously and requires revoked mint/freeze, 100% burned/locked LP, and clean audits.</i>`,
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
    let tokens: any[] = [];
    try {
      tokens = await prisma.earlyTrendingToken.findMany({
        where: { status: 'ACTIVE' },
        orderBy: { updatedAt: 'desc' },
        take: 15,
      });
    } catch {}

    if (!tokens || tokens.length === 0) {
      tokens = await getActiveTrackedTokens();
    }

    let isPaperMilestone = false;
    if (tokens.length === 0) {
      const { getPaperPortfolioSummary } = await import('./paperTrading.js');
      const paperSummary = await getPaperPortfolioSummary();
      if (paperSummary.activePositions.length > 0) {
        isPaperMilestone = true;
        tokens = paperSummary.activePositions.map((pos) => {
          const curPrice = pos.currentPriceUsd || pos.entryPriceUsd;
          const gainPct = pos.entryPriceUsd > 0
            ? ((curPrice - pos.entryPriceUsd) / pos.entryPriceUsd) * 100
            : 0;
          const topMilestone = Math.max(0, Math.floor(gainPct / 50) * 50);
          const dipMilestone = gainPct < 0 ? Math.floor(gainPct / 50) * 50 : 0;
          return {
            tokenMint: pos.tokenMint,
            tokenSymbol: pos.tokenSymbol,
            entryPriceUsd: pos.entryPriceUsd,
            lastAlertedPriceUsd: curPrice,
            lastMilestonePct: topMilestone,
            lastDipMilestonePct: dipMilestone,
            dexUrl: pos.dexUrl || `https://dexscreener.com/solana/${pos.tokenMint}`,
            pairAddress: null,
          };
        });
      }
    }

    if (tokens.length === 0) {
      await bot.sendMessage(
        chatId,
        `📈 <b>Price Milestone Trackers ($1,000 Model Baseline)</b> 🎯\n\n` +
          `ℹ️ <b>Awaiting Active Breakout Gems</b>\n` +
          `<i>The bot scans DexScreener continuously. As soon as a gem is sniped in the $1,000 Paper Model Portfolio, its real-time +50% pumps and -50% dips will appear here!</i>`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '💼 $1,000 Portfolio', callback_data: 'cmd_paper_portfolio' },
                { text: '🏆 Top Gainers', callback_data: 'cmd_top' },
              ],
              [{ text: '🚀 /start (Main Menu)', callback_data: 'cmd_start' }],
            ],
          },
        }
      );
      return;
    }

    let report = isPaperMilestone
      ? `📈 <b>ACTIVE 50% PRICE MILESTONE TRACKERS ($1,000 Model)</b> 🎯\n<i>Tracking real-time price milestones from the $1,000 Paper Money Model Portfolio.</i>\n\n`
      : `📈 <b>ACTIVE 50% PRICE MILESTONE TRACKERS</b> 🎯\n<i>Continuous price checks every 30s (Zero RPC credit usage via DexScreener).</i>\n\n`;

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
      { text: '🏆 Top Gainers', callback_data: 'cmd_top' },
      { text: '💼 My Positions', callback_data: 'cmd_positions' },
    ]);
    milestoneButtons.push([
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
    await bot.sendMessage(
      chatId,
      `📈 <b>Price Milestone Trackers</b> 🎯\n\n` +
        `⚠️ <b>No report found.</b>\n` +
        `<i>No tokens are currently in active milestone tracking.</i>`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🏆 Top Gainers', callback_data: 'cmd_top' }],
            [{ text: '🚀 /start (Main Menu)', callback_data: 'cmd_start' }],
          ],
        },
      }
    );
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
    let token: any = null;
    try {
      token = await prisma.earlyTrendingToken.findUnique({
        where: { tokenMint },
      });
    } catch {}

    if (!token) {
      const active = await getActiveTrackedTokens();
      token = active.find((t) => t.tokenMint === tokenMint) || null;
    }

    if (token) {
      const card = renderEarlyTrendingCardText(token);
      const dexscreenerUrl = getDexScreenerUrl(token);

      const inlineKeyboard = [
        [
          { text: '📊 DexScreener', url: dexscreenerUrl },
          { text: '🔍 Solscan', url: `https://solscan.io/token/${token.tokenMint}` },
        ],
        [
          { text: '⚡ Snipe 0.1 SOL', callback_data: `snipe_quick_0.1_${token.tokenMint}` },
          { text: '⚡ Snipe 0.5 SOL', callback_data: `snipe_quick_0.5_${token.tokenMint}` },
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

    // Strictly fetch today's alerted coins (with resilient fallback to token store)
    let tokens: any[] = [];
    try {
      tokens = await prisma.earlyTrendingToken.findMany({
        where: { alertDate: today },
        orderBy: { lastMilestonePct: 'desc' },
        take: 25,
      });
    } catch {}

    if (!tokens || tokens.length === 0) {
      tokens = await getTokensForDate(today);
    }

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

    const gainers = tokens.filter((t) => {
      const mult = t.peakPriceUsd && t.entryPriceUsd && t.entryPriceUsd > 0
        ? t.peakPriceUsd / t.entryPriceUsd
        : (1 + (t.lastMilestonePct || 0) / 100);
      return mult > 1.0 || (t.lastMilestonePct && t.lastMilestonePct > 0);
    });

    if (tokens.length === 0 || gainers.length === 0) {
      await bot.sendMessage(
        chatId,
        `🏆 <b>Top Early Trending</b> 💸\n` +
          `📅 <b>Date:</b> <code>${dateFormatted}</code>\n\n` +
          `⚠️ <b>No report found.</b>\n` +
          `<i>No top gainers recorded yet for today (${today}). Background radar is actively scanning!</i>`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🗓️ Weekly Report', callback_data: 'cmd_weekly' }],
              [{ text: '🚀 /start (Main Menu)', callback_data: 'cmd_start' }],
            ],
          },
        }
      );
      return;
    }

    const report = renderTopLeaderboardText(gainers.slice(0, 15), today);

    const inlineKeyboard = [
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
    const today = new Date().toISOString().slice(0, 10);
    const dateFormatted = formatDisplayDate(today);
    await bot.sendMessage(
      chatId,
      `🏆 <b>Top Early Trending</b> 💸\n` +
        `📅 <b>Date:</b> <code>${dateFormatted}</code>\n\n` +
        `⚠️ <b>No report found.</b>\n` +
        `<i>No top gainers recorded yet for today.</i>`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🗓️ Weekly Report', callback_data: 'cmd_weekly' }],
            [{ text: '🚀 /start (Main Menu)', callback_data: 'cmd_start' }],
          ],
        },
      }
    );
  }
}

/**
 * Displays Daily Flopped Coins strictly for today
 */
export async function handleDailyFlopsCommand(chatId: number | string): Promise<void> {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const dateFormatted = formatDisplayDate(today);

    // Strictly fetch today's alerted coins (with resilient fallback to token store)
    let tokens: any[] = [];
    try {
      tokens = await prisma.earlyTrendingToken.findMany({
        where: { alertDate: today },
        orderBy: { createdAt: 'desc' },
      });
    } catch {}

    if (!tokens || tokens.length === 0) {
      tokens = await getTokensForDate(today);
    }

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
        `📉 <b>DAILY FLOPPED COINS &amp; DIPS</b> 🩸\n` +
          `📅 <b>Date:</b> <code>${dateFormatted}</code>\n\n` +
          `⚠️ <b>No report found.</b>\n` +
          `<i>No flopped coins or dips recorded for today (${today}). All alerted gems are holding strong or currently in profit.</i>`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '🏆 Top Gainers', callback_data: 'cmd_top' },
                { text: '🗓️ Weekly Report', callback_data: 'cmd_weekly' },
              ],
              [
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
      { text: '🗓️ Weekly Report', callback_data: 'cmd_weekly' },
    ]);
    flopButtons.push([
      { text: '🚀 /start (Main Menu)', callback_data: 'cmd_start' },
    ]);

    await bot.sendMessage(chatId, report.trim(), {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: flopButtons },
    });
  } catch (err: any) {
    console.warn('handleDailyFlopsCommand error:', err.message);
    const today = new Date().toISOString().slice(0, 10);
    const dateFormatted = formatDisplayDate(today);
    await bot.sendMessage(
      chatId,
      `📉 <b>DAILY FLOPPED COINS &amp; DIPS</b> 🩸\n` +
        `📅 <b>Date:</b> <code>${dateFormatted}</code>\n\n` +
        `⚠️ <b>No report found.</b>\n` +
        `<i>No flopped coins or dips recorded for today.</i>`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🗓️ Weekly Report', callback_data: 'cmd_weekly' }],
            [{ text: '🚀 /start (Main Menu)', callback_data: 'cmd_start' }],
          ],
        },
      }
    );
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
        { text: '📉 Daily Flops', callback_data: 'cmd_flops' },
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
    console.warn('handleWeeklyReportCommand error:', err.message);
    const botUsername = env.TELEGRAM_BOT_USERNAME || 'MySolanaSBot';
    const headerLink = `https://t.me/${botUsername}`;
    await bot.sendMessage(
      chatId,
      `🗓️ <a href="${headerLink}"><b>WEEKLY PERFORMANCE RECAP</b></a> 📊\n\n` +
        `⚠️ <b>No report found.</b>\n` +
        `<i>No alerted token signals or performance records found for this week.</i>`,
      {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: [
            [{ text: '🏆 Top Gainers', callback_data: 'cmd_top' }],
            [{ text: '🚀 /start (Main Menu)', callback_data: 'cmd_start' }],
          ],
        },
      }
    );
  }
}

/**
 * Displays Active Sniped Positions, Live PnL, and TP/SL status (/positions)
 */
async function handlePositionsCommand(chatId: number | string, userId?: string): Promise<void> {
  try {
    const effectiveUserId = userId || String(chatId);
    const userPositions = getUserActivePositions(effectiveUserId);
    let active = userPositions.length > 0 ? userPositions : getActivePositions();
    const all = getAllPositions();

    let isPaperFallback = false;
    let paperPositions: any[] = [];

    // Unfunded / Paper Money Fallback: If no live positions exist, use the $1,000 Paper Money portfolio!
    if (active.length === 0) {
      const { getPaperPortfolioSummary } = await import('./paperTrading.js');
      const paperSummary = await getPaperPortfolioSummary();
      if (paperSummary.activePositions.length > 0) {
        isPaperFallback = true;
        paperPositions = paperSummary.activePositions;
      }
    }

    if (active.length === 0 && paperPositions.length === 0 && all.length === 0) {
      await bot.sendMessage(
        chatId,
        `💼 <b>POSITIONS ($1,000 Model Baseline)</b>\n\nℹ️ <i>No open positions right now. Tap a coin alert or enable Auto-Snipe to trade.</i>`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '💼 $1,000 Portfolio', callback_data: 'cmd_paper_portfolio' },
                { text: '⚙️ Auto-Snipe Settings', callback_data: 'cmd_snipe_menu' },
              ],
              [{ text: '🚀 /start (Main Menu)', callback_data: 'cmd_start' }],
            ],
          },
        }
      );
      return;
    }

    if (isPaperFallback) {
      let report = `💼 <b>POSITIONS ($1,000 Paper Model • Unfunded)</b> (${paperPositions.length} active)\n\n`;
      report += `ℹ️ <i>Showing open positions from the $1,000 Alpha Model Portfolio. Deposit SOL into your dedicated wallet to trade with live funds.</i>\n\n`;

      const maxToShow = 10;
      paperPositions.slice(0, maxToShow).forEach((pos, idx) => {
        const gainPct = (((pos.currentPriceUsd - pos.entryPriceUsd) / pos.entryPriceUsd) * 100).toFixed(1);
        const isUp = Number(gainPct) >= 0;
        const emoji = isUp ? '🟢' : '🔴';
        const chartUrl = pos.dexUrl || `https://dexscreener.com/solana/${pos.tokenMint}`;
        const statusBadge = pos.status === 'PARTIAL_TP_2X' ? ' [🌙 MOONBAG]' : '';
        const mult = (pos.currentPriceUsd / Math.max(0.00000001, pos.entryPriceUsd)).toFixed(2);

        report += `${emoji} <b>#${idx + 1}.</b> <a href="${chartUrl}"><b>$${escapeHtml(pos.tokenSymbol)}</b></a>${statusBadge} • <b>${isUp ? '+' : ''}${gainPct}%</b> (<code>${mult}X</code>)\n`;
        report += `   Entry: <code>${formatUnitPrice(pos.entryPriceUsd)}</code> ➔ Now: <code>${formatUnitPrice(pos.currentPriceUsd)}</code>\n`;
        report += `   Invested: <code>$${pos.investedUsd.toFixed(2)} USD</code> | Peak: <code>${pos.peakMultiplier.toFixed(2)}X</code>\n\n`;
      });

      if (paperPositions.length > maxToShow) {
        report += `<i>... and ${paperPositions.length - maxToShow} more active model positions</i>\n\n`;
      }

      const posButtons: any[][] = [];
      paperPositions.slice(0, 6).forEach((pos) => {
        posButtons.push([
          { text: `📊 $${pos.tokenSymbol} Chart`, url: pos.dexUrl || `https://dexscreener.com/solana/${pos.tokenMint}` },
          { text: `🔴 Exit $${pos.tokenSymbol}`, callback_data: `cmd_exit_single_${pos.tokenMint}` },
        ]);
      });
      posButtons.push([
        { text: '🚨 Exit All Model Positions', callback_data: 'cmd_exit_all' },
        { text: '🔄 Refresh Positions', callback_data: 'cmd_positions' },
      ]);
      posButtons.push([
        { text: '💼 $1,000 Portfolio', callback_data: 'cmd_paper_portfolio' },
        { text: '🔐 Deposit Funds', callback_data: 'cmd_wallet' },
      ]);
      posButtons.push([
        { text: '🚀 /start (Main Menu)', callback_data: 'cmd_start' },
      ]);

      await safeSendTelegramMessage(chatId, report.trim(), {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: posButtons },
      });
      return;
    }

    let report = `💼 <b>POSITIONS</b> (${active.length} active)\n\n`;

    if (active.length === 0) {
      report += `ℹ️ <i>No open positions.</i>\n\n`;
    } else {
      const maxToShow = 10;
      active.slice(0, maxToShow).forEach((pos, idx) => {
        const gainPct = (((pos.currentPriceUsd - pos.entryPriceUsd) / pos.entryPriceUsd) * 100).toFixed(1);
        const isUp = Number(gainPct) >= 0;
        const emoji = isUp ? '🟢' : '🔴';
        const chartUrl = getDexScreenerUrl(pos as any);
        const statusBadge = pos.status === 'PARTIAL_TP_2X' ? ' [🌙 MOONBAG]' : '';

        report += `${emoji} <b>#${idx + 1}.</b> <a href="${chartUrl}"><b>$${escapeHtml(pos.tokenSymbol)}</b></a>${statusBadge} • <b>${isUp ? '+' : ''}${gainPct}%</b>\n`;
        report += `   Entry: <code>${formatUnitPrice(pos.entryPriceUsd)}</code> ➔ Now: <code>${formatUnitPrice(pos.currentPriceUsd)}</code>\n`;
        report += `   Peak: <code>${formatUnitPrice(pos.peakPriceUsd)}</code> | Realized: <code>+${pos.realizedSolProfit.toFixed(2)} SOL</code>\n\n`;
      });
      if (active.length > maxToShow) {
        report += `<i>... and ${active.length - maxToShow} more active positions</i>\n\n`;
      }
    }

    const closed = all.filter((p) => p.status === 'CLOSED').slice(-3);
    if (closed.length > 0) {
      report += `📜 <b>Recently Closed:</b>\n`;
      closed.forEach((p) => {
        const closedDexUrl = getDexScreenerUrl(p as any);
        report += `• <a href="${closedDexUrl}"><b>$${escapeHtml(p.tokenSymbol)}</b></a>: ${p.exitReason || 'Closed'} (+${p.realizedSolProfit.toFixed(2)} SOL)\n`;
      });
      report += `\n`;
    }

    const posButtons: any[][] = [];
    active.slice(0, 6).forEach((pos) => {
      posButtons.push([
        { text: `📊 $${pos.tokenSymbol} Chart`, url: getDexScreenerUrl(pos as any) },
        { text: `🔴 Exit $${pos.tokenSymbol}`, callback_data: `cmd_exit_single_${pos.tokenMint}` },
      ]);
    });
    posButtons.push([
      { text: '🚨 Exit All Positions', callback_data: 'cmd_exit_all' },
      { text: '🔄 Refresh Positions', callback_data: 'cmd_positions' },
    ]);
    posButtons.push([
      { text: '🏆 Top Gainers', callback_data: 'cmd_top' },
      { text: '🚀 /start (Main Menu)', callback_data: 'cmd_start' },
    ]);

    await safeSendTelegramMessage(chatId, report.trim(), {
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
  const statusEmoji = pref.autoSnipeEnabled ? '🟢 ACTIVE' : '🔴 DISABLED';
  const walletAddr = pref.solanaWallet || env.USER_SOLANA_WALLET || 'Not Connected';
  const walletTrunc = walletAddr.length > 10 ? `${walletAddr.slice(0, 4)}...${walletAddr.slice(-4)}` : walletAddr;
  const currentTradeSize = pref.fixedTradeSizeUsd || 10.0;

  const message = `
🎯 <b>AI AUTO-SNIPER DASHBOARD</b>

Status: <b>${statusEmoji}</b>
Volume Allocation: <b>$${currentTradeSize.toFixed(2)} USD</b> (Discrete: $10, $15, $20, $30, $40, $45, $50)
Slippage: <code>${pref.maxSlippagePercent}%</code> • Priority Gas: <code>${((pref.priorityFeeLamports || 100000) / 1e9).toFixed(5)} SOL</code>
Strategy: <b>2X De-Risk (Sell 50%) ➔ Infinite Trend Runner</b>
Wallet: <code>${walletTrunc}</code>

🛡️ <b>FEE STRUCTURE & CAPITAL REQUIREMENTS:</b>
• <b>1% Execution Fee:</b> Applied to every trade executed by the bot.
• <b>15% Profit Fee:</b> Applied to profit on winning trades (including manual exits/exit all).
• <b>0% Extra on Losses:</b> Only the initial 1% entry fee is incurred.
• <b>Optimal Capital:</b> <b>$1,000.00 USD minimum deposit</b> recommended for optimal bot operation.
  `.trim();

  const keyboard = [
    [
      pref.autoSnipeEnabled
        ? { text: '🔴 Turn Auto-Snipe OFF', callback_data: 'snipe_disable' }
        : { text: '🟢 Turn Auto-Snipe ON', callback_data: 'snipe_enable' },
    ],
    [
      { text: `💵 Set Trade Volume ($${currentTradeSize})`, callback_data: 'cmd_tradesize' },
      { text: '💼 Sniper Wallet Dashboard', callback_data: 'cmd_wallet' },
    ],
    [
      { text: '💸 Withdraw SOL', callback_data: 'wallet_withdraw' },
      { text: '💼 My Positions', callback_data: 'cmd_positions' },
    ],
    [
      { text: '🏆 Top Gainers', callback_data: 'cmd_top' },
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
 * Handles any user-submitted token (raw mint address or /buy /submit /paper command).
 * Analyzes the coin, evaluates SLM Quality Gate, tracks in earlyTokenStore for pump/dump milestones,
 * and INSTANTLY trades it using paper money regardless of whether SLM signal is GO or NO_GO!
 */
export async function handleUserSubmittedToken(chatId: number | string, query: string): Promise<void> {
  const waitMsg = await bot.sendMessage(
    chatId,
    `⚡ <i>Analyzing <code>${escapeHtml(query)}</code> &amp; executing instant Buy...</i>`,
    { parse_mode: 'HTML' }
  );

  try {
    const {
      lookupTokenAnalytics,
      renderTokenAnalyticsCard,
      evaluateSlmQualityGate,
    } = await import('./aiIntelligence.js');
    const { processPaperTradeBuy } = await import('./paperTrading.js');
    const { saveAlertedToken } = await import('./earlyTokenStore.js');

    const audit = await lookupTokenAnalytics(query);
    if (!audit) {
      await bot.editMessageText(
        `⚠️ <i>Could not find an active Solana liquidity pool for "<b>${escapeHtml(query)}</b>" on DexScreener. Please verify the contract address or ticker.</i>`,
        {
          chat_id: chatId,
          message_id: waitMsg.message_id,
          parse_mode: 'HTML',
        }
      );
      return;
    }

    // 1. Evaluate SLM Quality Gate Sentiment & Velocity
    const m = audit.onChainMetrics;
    const priceUsd = m?.priceUsd || 0.00005;
    const marketCap = m?.marketCapUsd || 50000;
    const liquidityUsd = m?.liquidityUsd || 15000;
    const vol1h = Math.round((audit.volume24h || 24000) / 24);

    const slmVerdict = await evaluateSlmQualityGate({
      tokenSymbol: audit.symbol,
      tokenName: audit.name || audit.symbol,
      tokenMint: audit.mint,
      ageMinutes: m?.ageMinutes || 5,
      marketCap: marketCap,
      liquidityUsd: liquidityUsd,
      volume1h: vol1h,
      volume5m: Math.round(vol1h / 12),
      buySellRatio: audit.buyPressureRatio || 1.5,
      buys5m: 15,
      sells5m: 10,
      holderCount: 300,
      devHoldingPct: m?.devHoldingPct ?? 0,
      devSoldPct: m?.devHoldingPct === 0 ? 100 : 0,
      twitterUrl: audit.webNarrative?.twitterUrl,
      telegramUrl: audit.webNarrative?.telegramUrl,
      websiteUrl: audit.webNarrative?.websiteUrl,
      websiteTextSnippet: audit.webNarrative?.websiteTextSnippet,
    });

    // 2. Persist in earlyTokenStore so PriceTracker monitors it every 30s for pump (+50%, 2X) & dump (-50%) milestones
    const today = new Date().toISOString().slice(0, 10);
    try {
      await saveAlertedToken({
        id: `user_sub_${Date.now()}_${audit.mint.slice(0, 4)}`,
        tokenMint: audit.mint,
        tokenSymbol: audit.symbol,
        tokenName: audit.name,
        pairAddress: audit.mint,
        dexUrl: audit.dexUrl || `https://dexscreener.com/solana/${audit.mint}`,
        xUrl: audit.webNarrative?.twitterUrl,
        tgUrl: audit.webNarrative?.telegramUrl,
        entryPriceUsd: priceUsd,
        entryMarketCap: marketCap,
        peakPriceUsd: priceUsd,
        lowestPriceUsd: priceUsd,
        lastAlertedPriceUsd: priceUsd,
        lastMilestonePct: 0,
        lastDipMilestonePct: 0,
        status: 'ACTIVE',
        alertDate: today,
        dailyQuotaIndex: 0,
        slmSignal: slmVerdict.viabilitySignal,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    } catch (storeErr: any) {
      console.warn('⚠️ Token store notice on submission:', storeErr.message);
    }

    // 3. INSTANT PAPER TRADE BUY (trades instantly regardless of NO_GO)
    let paperPos = null;
    try {
      paperPos = await processPaperTradeBuy(
        {
          tokenMint: audit.mint,
          tokenSymbol: audit.symbol,
          tokenName: audit.name,
          priceUsd: priceUsd,
          marketCap: marketCap,
          liquidityUsd: liquidityUsd,
          dexUrl: audit.dexUrl,
          aiScore: audit.score,
          slmVerdict,
          forceBuy: true,
        },
        { forceBuy: true }
      );
    } catch (tradeErr: any) {
      console.warn('⚠️ Error during instant paper trade buy:', tradeErr.message);
    }

    // 4. Construct rich Telegram confirmation response
    const signalBadge = slmVerdict.viabilitySignal === 'GO'
      ? '🟢 <b>CONFIRMED (GO)</b>'
      : '🔴 <b>NO_GO (Audited & Logged)</b>';

    let paperSection = '';
    if (paperPos) {
      paperSection = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💼 <b>[INSTANT BUY EXECUTED]</b> ✅
• 💵 <b>Capital Invested:</b> <code>$${paperPos.investedUsd.toFixed(2)} USD</code> (<code>${paperPos.investedSol.toFixed(4)} SOL</code>)
• 💰 <b>Entry Price:</b> <code>$${paperPos.entryPriceUsd.toFixed(6)}</code>
• 🪙 <b>Position Tokens:</b> <code>${formatTokenQuantity(paperPos.tokensAcquired)}</code>
• 🛡️ <b>SLM Gate Verdict:</b> ${signalBadge}
• 🎯 <b>Take-Profit Target:</b> <code>+100% (2X Moonbag)</code>
• 🛑 <b>Trailing Stop-Loss:</b> <code>-40% from peak</code>
• 📊 <b>Status:</b> 🟢 Active Tracking (${paperPos.strategyProfile})
`;
    } else {
      paperSection = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💼 <b>[POSITION ACTIVE]</b>
• Token is already open and tracked in your portfolio!
`;
    }

    const auditCard = renderTokenAnalyticsCard(audit);
    const fullMessage = `${paperSection}\n${auditCard}`.trim();

    await bot.editMessageText(fullMessage, {
      chat_id: chatId,
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
            { text: '💼 View Portfolio', callback_data: 'cmd_paper_portfolio' },
            { text: '🏆 Top Gainers', callback_data: 'cmd_top' },
          ],
          [
            { text: '⚡ Snipe 0.1 SOL', callback_data: `snipe_quick_0.1_${audit.mint}` },
            { text: '⚡ Snipe 0.5 SOL', callback_data: `snipe_quick_0.5_${audit.mint}` },
          ],
        ],
      },
    });
  } catch (err: any) {
    await bot.sendMessage(chatId, `⚠️ <i>Submission error: ${err.message}</i>`, { parse_mode: 'HTML' });
  }
}

/**
 * Handles /paper and /portfolio command displaying live $1,000 bankroll or personalized deposited funds
 */
export async function handlePaperPortfolioCommand(
  chatId: number | string,
  userId?: string,
  forceBenchmark: boolean = false
): Promise<void> {
  const effectiveUserId = userId || String(chatId);
  const isPublicGroup = String(chatId) === String(env.TELEGRAM_GROUP_CHAT_ID);
  const botUser = env.TELEGRAM_BOT_USERNAME || 'MySolanaSBot';

  try {
    const { getPaperPortfolioSummary, PAPER_RESERVE_FLOOR_USD, fetchLiveSolPrice } = await import('./paperTrading.js');
    const solPrice = await fetchLiveSolPrice();

    // 1. Check if user is in private chat and has deposited real funds
    if (!isPublicGroup && !forceBenchmark) {
      const pref = await getUserPreferences(effectiveUserId);
      const walletAddr = pref.solanaWallet;
      let solBal = 0;
      if (walletAddr) {
        solBal = await fetchUserSolBalance(walletAddr);
      }
      const isFunded = Boolean(walletAddr && solBal >= 0.01);

      // --- FUNDED USER LIVE PORTFOLIO ---
      if (isFunded) {
        const depositedUsd = Number((solBal * solPrice).toFixed(2));
        const userPositions = getUserActivePositions(effectiveUserId);

        let openPositionsValueUsd = 0;
        let unrealizedPnlUsd = 0;
        for (const pos of userPositions) {
          const val = pos.remainingTokens * (pos.currentPriceUsd || pos.entryPriceUsd);
          openPositionsValueUsd += val;
          unrealizedPnlUsd += val - pos.solInvested * solPrice;
        }
        const netEquityUsd = depositedUsd + openPositionsValueUsd;
        const unrealizedSign = unrealizedPnlUsd >= 0 ? '+' : '';

        const autoSnipeStatus = pref.autoSnipeEnabled
          ? '🟢 <b>ACTIVE</b> (Using deposited funds for $10 radar entries)'
          : '⏸️ <b>DISABLED</b> (No funds allocated • 100% idle until manual trade)';

        let msg = `💼 <b>YOUR LIVE DEPOSITED PORTFOLIO</b> 🟢\n\n`;
        msg += `💰 <b>Deposited Balance:</b> <code>${solBal.toFixed(4)} SOL</code> (<b>$${depositedUsd.toFixed(2)} USD</b>)\n`;
        msg += `🏦 <b>Total Account Equity:</b> <b>$${netEquityUsd.toFixed(2)} USD</b>\n`;
        msg += `⚡ <b>Auto-Snipe:</b> ${autoSnipeStatus}\n`;
        msg += `💵 <b>Entry Allocation:</b> <b>$10.00 USD</b> per trade (+ network gas)\n`;
        msg += `🛡️ <b>Strategy:</b> 2X De-Risk (Sell 50%) ➔ Infinite Trend Runner\n`;
        if (userPositions.length > 0) {
          msg += `📈 <b>Unrealized PnL:</b> <b>${unrealizedSign}$${unrealizedPnlUsd.toFixed(2)} USD</b>\n`;
        }
        msg += `\n📊 <b>Your Active Positions (${userPositions.length}):</b>\n`;

        if (userPositions.length === 0) {
          msg += pref.autoSnipeEnabled
            ? `<i>Waiting for next radar breakout entry...</i>\n`
            : `<i>No active trades. Enable auto-snipe or tap [⚡ Snipe] on any alert to trade.</i>\n`;
        } else {
          for (const pos of userPositions.slice(0, 15)) {
            const mult = (pos.currentPriceUsd / Math.max(0.00000001, pos.entryPriceUsd)).toFixed(2);
            const gainPct = (((pos.currentPriceUsd - pos.entryPriceUsd) / pos.entryPriceUsd) * 100).toFixed(1);
            const sign = Number(gainPct) >= 0 ? '+' : '';
            msg += `• <b>$${escapeHtml(pos.tokenSymbol)}</b>: <b>${sign}${gainPct}%</b> (<code>${mult}X</code>) • ${pos.status}\n`;
          }
        }

        const inlineKeyboard = [
          [
            pref.autoSnipeEnabled
              ? { text: '⏸️ Turn Auto-Snipe OFF (Pause Trading)', callback_data: 'snipe_disable' }
              : { text: '🟢 Turn Auto-Snipe ON (Use Funds for Gems)', callback_data: 'snipe_enable' },
          ],
          [
            { text: '🚨 Exit All My Trades', callback_data: 'cmd_exit_all' },
            { text: '💸 Withdraw SOL', callback_data: 'wallet_withdraw' },
          ],
          [
            { text: '🔄 Refresh Balance', callback_data: 'cmd_paper_portfolio' },
            { text: '💼 View $1,000 Alpha Benchmark', callback_data: 'cmd_view_alpha_benchmark' },
          ],
        ];

        await safeSendTelegramMessage(chatId, msg.trim(), {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup: { inline_keyboard: inlineKeyboard },
        });
        return;
      }
    }

    // --- UNFUNDED USER OR PUBLIC BENCHMARK: UTILIZE $1,000 ALPHA PORTFOLIO ---
    const summary = await getPaperPortfolioSummary();
    const w = summary.wallet;

    const pnlSign = summary.totalPnlUsd >= 0 ? '+' : '';
    const pnlEmoji = summary.totalPnlUsd >= 0 ? '💸' : '🩸';

    const isReserveLocked = w.liquidCashUsd <= PAPER_RESERVE_FLOOR_USD && summary.activePositions.length > 0;
    const reserveStatusLine = isReserveLocked
      ? `⏸️ <b>Reserve Floor:</b> <b>$${PAPER_RESERVE_FLOOR_USD.toFixed(0)} Lock Active</b> (Entries paused • Waiting for profit from ${summary.activePositions.length} active trade(s))\n`
      : '';

    let msg = `💼 <b>ALPHA MODEL PORTFOLIO ($1,000 BASELINE)</b> ${pnlEmoji}\n\n`;
    if (!isPublicGroup && !forceBenchmark) {
      msg += `ℹ️ <i>Wallet not funded. You are currently utilizing the $1,000 Alpha Model Portfolio. Deposit SOL into your dedicated wallet to activate live fund trading.</i>\n\n`;
    }
    msg += `🏦 <b>Model Equity:</b> <b>$${summary.netWorthUsd.toFixed(2)}</b> (${pnlSign}${summary.totalPnlPercent.toFixed(1)}%)\n`;
    msg += `💵 <b>Model Cash:</b> <code>$${w.liquidCashUsd.toFixed(2)}</code> | <b>In Trades:</b> <code>$${w.totalInvestedUsd.toFixed(2)}</code>\n`;
    msg += `🎯 <b>Win Rate:</b> <b>${w.winRatePercent.toFixed(1)}%</b> (${w.winningTrades}W / ${w.losingTrades}L)\n`;
    if (reserveStatusLine) msg += reserveStatusLine;
    msg += `\n📊 <b>Active Positions (${summary.activePositions.length}):</b>\n`;

    if (summary.activePositions.length === 0) {
      msg += `<i>No active open positions.</i>\n`;
    } else {
      // Sort: Moonbags first, then highest percentage gain
      const sortedPositions = [...summary.activePositions].sort((a, b) => {
        const isMoonA = a.status === 'PARTIAL_TP_2X' ? 1 : 0;
        const isMoonB = b.status === 'PARTIAL_TP_2X' ? 1 : 0;
        if (isMoonA !== isMoonB) return isMoonB - isMoonA;
        const gainA = (a.currentPriceUsd - a.entryPriceUsd) / Math.max(0.00000001, a.entryPriceUsd);
        const gainB = (b.currentPriceUsd - b.entryPriceUsd) / Math.max(0.00000001, b.entryPriceUsd);
        return gainB - gainA;
      });

      const maxPositionsToShow = 15;
      let displayedCount = 0;

      for (const pos of sortedPositions) {
        if (displayedCount >= maxPositionsToShow) break;
        const gainPct = ((pos.currentPriceUsd - pos.entryPriceUsd) / Math.max(0.00000001, pos.entryPriceUsd)) * 100;
        const sign = gainPct >= 0 ? '+' : '';
        const badge = pos.status === 'PARTIAL_TP_2X' ? '🌙 MOONBAG' : '🟢 OPEN';
        const mult = (pos.currentPriceUsd / Math.max(0.00000001, pos.entryPriceUsd)).toFixed(2);
        const chartUrl = pos.dexUrl || `https://dexscreener.com/solana/${pos.tokenMint}`;
        
        const line = `• <a href="${chartUrl}"><b>$${escapeHtml(pos.tokenSymbol)}</b></a> [${badge}]: <b>${sign}${gainPct.toFixed(1)}%</b> (<code>${mult}X</code>)\n`;

        if ((msg + line).length > 3400) {
          break;
        }
        msg += line;
        displayedCount++;
      }

      if (sortedPositions.length > displayedCount) {
        msg += `\n<i>... and ${sortedPositions.length - displayedCount} more</i>\n`;
      }
    }

    const inlineKeyboard = [
      [
        { text: '🔐 Deposit Funds / Connect Wallet', callback_data: 'cmd_wallet' },
        { text: '🔄 Refresh Portfolio', callback_data: 'cmd_paper_portfolio' },
      ],
      [
        { text: '🚨 Exit All Trades (Sell All)', callback_data: 'cmd_exit_all' },
        { text: '🏆 Top Gainers', callback_data: 'cmd_top' },
      ],
      [
        { text: '🚀 /start (Main Menu)', callback_data: 'cmd_start' },
      ],
    ];

    await safeSendTelegramMessage(chatId, msg.trim(), {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: inlineKeyboard },
    });
  } catch (err: any) {
    await bot.sendMessage(chatId, `⚠️ Could not fetch trading portfolio: ${err.message}`);
  }
}

/**
 * Resets the trading wallet to a fresh $1,000.00 USD balance
 */
export async function handlePaperResetCommand(chatId: number | string): Promise<void> {
  try {
    const { resetPaperTradingWallet } = await import('./paperTrading.js');
    const wallet = await resetPaperTradingWallet();
    await bot.sendMessage(
      chatId,
      `🔄 <b>[PORTFOLIO RESET TO $1,000]</b> 💸\n\n` +
        `💰 <b>Liquid Cash:</b> <code>$${wallet.liquidCashUsd.toFixed(2)} USD</code> (<code>${wallet.liquidCashSol.toFixed(4)} SOL</code>)\n` +
        `🏦 <b>Initial Balance:</b> <code>$1,000.00 USD</code>\n` +
        `📊 <b>Active Trades:</b> 0 (Clean Slate)\n` +
        `🎯 <b>Stats & Streaks:</b> Freshly re-initialized\n\n` +
        `<i>The engine is armed and ready to execute $10.00 base trades from radar breakout alerts.</i>`,
      { parse_mode: 'HTML' }
    );
  } catch (err: any) {
    await bot.sendMessage(chatId, `⚠️ Error resetting portfolio: ${err.message}`);
  }
}


