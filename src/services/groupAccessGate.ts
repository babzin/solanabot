import { bot } from './telegram.js';
import { prisma } from './db.js';
import { env } from '../config/env.js';
import { clearUserCredentialsInMemory, closeUserPositionsInMemory } from './sniper.js';

export interface MembershipStatus {
  isMember: boolean;
  status: string; // 'creator' | 'administrator' | 'member' | 'restricted' | 'left' | 'kicked'
}

/**
 * Checks in real time whether a user is an active member of the designated Telegram group
 */
export async function verifyGroupMembership(telegramUserId: string): Promise<MembershipStatus> {
  const sUserId = String(telegramUserId);
  const ownerId = String(env.TELEGRAM_CHAT_ID || '');

  // Owner and configured admins are always verified with full access
  if (sUserId && ownerId && (sUserId === ownerId || ownerId.split(',').map((x) => x.trim()).includes(sUserId))) {
    return { isMember: true, status: 'creator' };
  }

  // If no group chat ID configured or testing with dummy, allow access
  const groupChatId = env.TELEGRAM_GROUP_CHAT_ID || env.TELEGRAM_CHAT_ID;
  if (!groupChatId || groupChatId === '0' || env.TELEGRAM_BOT_TOKEN.includes('dummy')) {
    return { isMember: true, status: 'member' };
  }

  try {
    const member = await bot.getChatMember(groupChatId, Number(telegramUserId));
    const activeStatuses = ['creator', 'administrator', 'member', 'restricted'];
    const isMember = activeStatuses.includes(member.status);
    return { isMember, status: member.status };
  } catch (err: any) {
    // If the user was kicked or never joined, Telegram throws an error (e.g., "PARTICIPANT_ID_INVALID" or "chat not found")
    console.warn(`[GroupAccessGate] User ${telegramUserId} membership check failed: ${err.message}`);
    return { isMember: false, status: 'kicked_or_not_found' };
  }
}

/**
 * Completely purges user wallet credentials, private keys, and auto-snipe configuration
 * when removed from the Telegram group.
 */
export async function revokeUserWalletAndAccess(telegramUserId: string, reason: string = 'Removed from group'): Promise<void> {
  console.log(`🔒 [ACCESS REVOKED] User ${telegramUserId} lost group access (${reason}). Wiping credentials...`);

  // 1. Wipe in-memory and file-based state immediately
  try {
    clearUserCredentialsInMemory(telegramUserId);
    closeUserPositionsInMemory(telegramUserId, `ACCESS_REVOKED: ${reason}`);
  } catch (memErr: any) {
    console.warn(`[GroupAccessGate] In-memory wipe note: ${memErr.message}`);
  }

  // 2. Wipe database credentials if DB is reachable
  try {
    await prisma.userPreference.updateMany({
      where: { telegramUserId },
      data: {
        autoSnipeEnabled: false,
        solanaWallet: null,
        encryptedSecret: null,
        encryptionIv: null,
        encryptionTag: null,
        isMembershipActive: false,
      },
    });

    await prisma.userPosition.updateMany({
      where: { user: { telegramUserId }, status: { in: ['OPEN', 'PARTIAL_TP_2X'] } },
      data: {
        status: 'CLOSED',
        exitReason: `ACCESS_REVOKED: ${reason}`,
        closedAt: new Date(),
      },
    });
  } catch (dbErr: any) {
    console.warn(`[GroupAccessGate] Database wipe note: ${dbErr.message}`);
  }

  // 3. Notify the user in their private DM
  if (env.TELEGRAM_BOT_TOKEN && !env.TELEGRAM_BOT_TOKEN.includes('dummy')) {
    try {
      await bot.sendMessage(
        telegramUserId,
        `🚫 <b>Access Revoked & Wallet Purged</b>\n\n` +
        `You are no longer an active member of the trading group.\n` +
        `• Your encrypted private key and wallet address have been <b>permanently deleted</b> from our servers.\n` +
        `• All auto-sniping has been terminated.\n\n` +
        `<i>If you are re-admitted to the group in the future, you will need to re-connect your wallet as a new user.</i>`,
        { parse_mode: 'HTML' }
      );
    } catch (msgErr: any) {
      console.warn(`[GroupAccessGate] Could not deliver DM notice to user ${telegramUserId}: ${msgErr.message}`);
    }
  }
}

