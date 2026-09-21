import axios from 'axios';
import { env } from '../config/env.js';
import { KNOWN_PROGRAMS } from '../config/strategies.js';
import { HeliusParsedTransaction, SwapEvent } from '../types/index.js';
import { isWalletTracked } from './redis.js';

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * Updates the Helius Webhook's tracked account addresses dynamically
 */
export async function updateHeliusWebhookAddresses(
  webhookId: string,
  accountAddresses: string[]
): Promise<boolean> {
  if (!env.HELIUS_API_KEY || !webhookId || env.HELIUS_API_KEY.includes('dummy')) {
    console.warn('⚠️ Helius API Key or Webhook ID not configured. Skipping remote webhook sync.');
    return false;
  }

  try {
    const url = `https://api.helius.xyz/v0/webhooks/${webhookId}?api-key=${env.HELIUS_API_KEY}`;

    // First fetch existing webhook configuration
    const getRes = await axios.get(url);
    const existingConfig = getRes.data;

    // Update with new addresses
    await axios.put(url, {
      webhookURL: existingConfig.webhookURL,
      transactionTypes: existingConfig.transactionTypes || ['SWAP'],
      accountAddresses: accountAddresses.slice(0, env.MAX_TRACKED_WALLETS),
      webhookType: existingConfig.webhookType || 'enhanced',
      authHeader: existingConfig.authHeader || env.WEBHOOK_AUTH_TOKEN,
    });

    console.log(`✅ Successfully updated Helius Webhook [${webhookId}] with ${accountAddresses.length} addresses.`);
    return true;
  } catch (err: any) {
    console.error('⚠️ Failed to update Helius Webhook:', err.response?.data || err.message);
    return false;
  }
}

/**
 * Updates the Helius Webhook destination URL
 */
export async function updateHeliusWebhookUrl(
  webhookId: string,
  newWebhookUrl: string
): Promise<boolean> {
  if (!env.HELIUS_API_KEY || !webhookId || env.HELIUS_API_KEY.includes('dummy')) {
    return false;
  }

  try {
    const url = `https://api.helius.xyz/v0/webhooks/${webhookId}?api-key=${env.HELIUS_API_KEY}`;
    const getRes = await axios.get(url);
    const existingConfig = getRes.data;

    await axios.put(url, {
      webhookURL: newWebhookUrl,
      transactionTypes: existingConfig.transactionTypes || ['SWAP'],
      accountAddresses: existingConfig.accountAddresses || [],
      webhookType: existingConfig.webhookType || 'enhanced',
      authHeader: existingConfig.authHeader || env.WEBHOOK_AUTH_TOKEN,
    });

    console.log(`✅ Updated Helius Webhook [${webhookId}] destination to: ${newWebhookUrl}`);
    return true;
  } catch (err: any) {
    console.error('⚠️ Failed to update Helius Webhook URL:', err.response?.data || err.message);
    return false;
  }
}

/**
 * Extracts and normalizes swap events from Helius parsed transactions
 * Supports native SOL, Wrapped SOL (WSOL), and calculates accurate sell percentages
 */
export async function parseHeliusSwapTransaction(
  tx: HeliusParsedTransaction,
  knownWallet?: string
): Promise<SwapEvent | null> {
  // 1. Identify which tracked wallet was involved
  let matchingWallet: string | null = knownWallet || null;

  if (!matchingWallet) {
    // Check fee payer
    if (await isWalletTracked(tx.feePayer)) {
      matchingWallet = tx.feePayer;
    }

    // Check accountData if feePayer wasn't in tracked set (e.g. bot relayer / telegram bot)
    if (!matchingWallet && tx.accountData) {
      for (const acc of tx.accountData) {
        if (await isWalletTracked(acc.account)) {
          matchingWallet = acc.account;
          break;
        }
      }
    }
  }

  if (!matchingWallet) {
    return null;
  }

  // 2. Identify the Program ID (Pump.fun or Raydium or Jupiter)
  let programId = KNOWN_PROGRAMS.RAYDIUM_AMM_V4;
  if (tx.instructions) {
    for (const ix of tx.instructions) {
      if (ix.programId === KNOWN_PROGRAMS.PUMP_FUN) {
        programId = KNOWN_PROGRAMS.PUMP_FUN;
        break;
      } else if (ix.programId === KNOWN_PROGRAMS.RAYDIUM_CPMM) {
        programId = KNOWN_PROGRAMS.RAYDIUM_CPMM;
        break;
      } else if (ix.programId === KNOWN_PROGRAMS.RAYDIUM_CLMM) {
        programId = KNOWN_PROGRAMS.RAYDIUM_CLMM;
        break;
      }
    }
  }

  // 3. Fast-path: Check if Helius enhanced swap event was already decoded
  if (tx.events?.swap) {
    const swapEvent = tx.events.swap;
    let side: 'BUY' | 'SELL' = 'BUY';
    let solAmount = 0;
    let tokenMint = '';
    let tokenAmount = 0;

    // Check native input/output
    if (swapEvent.nativeInput && swapEvent.nativeInput.userAccount === matchingWallet) {
      side = 'BUY';
      solAmount = parseFloat(swapEvent.nativeInput.amount) / 1e9;
      if (swapEvent.tokenOutputs && swapEvent.tokenOutputs.length > 0) {
        const out = swapEvent.tokenOutputs[0];
        tokenMint = out.mint;
        tokenAmount = parseFloat(out.rawTokenAmount.tokenAmount) / Math.pow(10, out.rawTokenAmount.decimals || 6);
      }
    } else if (swapEvent.nativeOutput && swapEvent.nativeOutput.userAccount === matchingWallet) {
      side = 'SELL';
      solAmount = parseFloat(swapEvent.nativeOutput.amount) / 1e9;
      if (swapEvent.tokenInputs && swapEvent.tokenInputs.length > 0) {
        const inp = swapEvent.tokenInputs[0];
        tokenMint = inp.mint;
        tokenAmount = parseFloat(inp.rawTokenAmount.tokenAmount) / Math.pow(10, inp.rawTokenAmount.decimals || 6);
      }
    }

    if (tokenMint && solAmount >= 0.005) {
      return {
        signature: tx.signature,
        walletAddress: matchingWallet,
        tokenMint,
        side,
        solAmount: Number(solAmount.toFixed(3)),
        tokenAmount,
        soldPercent: side === 'SELL' ? 100 : undefined,
        programId,
        timestamp: tx.timestamp || Math.floor(Date.now() / 1000),
      };
    }
  }

  // 4. Comprehensive Balance Delta Parsing (Native SOL + WSOL + Target Token)
  let nativeSolDelta = 0;
  let wsolDelta = 0;
  let tokenMint = '';
  let tokenAmount = 0;
  let postTokenBalance = 0;
  let hasTokenBalanceChange = false;

  if (tx.accountData) {
    const userAcc = tx.accountData.find((a) => a.account === matchingWallet);
    if (userAcc) {
      // Native SOL change (1 SOL = 1e9 lamports)
      nativeSolDelta = (userAcc.nativeBalanceChange || 0) / 1e9;

      // Check for WSOL or token balance changes
      if (userAcc.tokenBalanceChanges && userAcc.tokenBalanceChanges.length > 0) {
        for (const tc of userAcc.tokenBalanceChanges) {
          const rawAmt = parseFloat(tc.rawTokenAmount.tokenAmount || '0');
          const decimals = tc.rawTokenAmount.decimals || 6;
          const adjustedAmt = rawAmt / Math.pow(10, decimals);

          if (tc.mint === WSOL_MINT) {
            wsolDelta = adjustedAmt;
          } else {
            tokenMint = tc.mint;
            tokenAmount = Math.abs(adjustedAmt);
            hasTokenBalanceChange = true;
            postTokenBalance = adjustedAmt < 0 ? 0 : adjustedAmt;
          }
        }
      }
    }
  }

  // Combine Native SOL delta + WSOL delta
  let totalSolDelta = nativeSolDelta + wsolDelta;

  // Deduct transaction fee if feePayer is the matching wallet
  if (matchingWallet === tx.feePayer && tx.fee) {
    const feeInSol = tx.fee / 1e9;
    if (totalSolDelta < 0) {
      // Buying: add back fee so solAmount only reflects tokens bought
      totalSolDelta += feeInSol;
    }
  }

  // Fallback to tokenTransfers if accountData did not contain target token mint
  if (!tokenMint && tx.tokenTransfers && tx.tokenTransfers.length > 0) {
    const transfer = tx.tokenTransfers.find((t) => t.mint !== WSOL_MINT);
    if (transfer) {
      tokenMint = transfer.mint;
      tokenAmount = transfer.amount;
    }
  }

  // Determine side from total net SOL flow
  const side: 'BUY' | 'SELL' = totalSolDelta < 0 ? 'BUY' : 'SELL';
  const solAmount = Math.abs(totalSolDelta);

  // Filter out tiny dust / airdrops / micro-fees (< 0.005 SOL) and stablecoin swaps (USDC/USDT)
  const isStable =
    tokenMint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' ||
    tokenMint === 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

  if (!tokenMint || solAmount < 0.005 || isStable) {
    return null;
  }

  // Calculate sold percentage
  let soldPercent: number | undefined = undefined;
  if (side === 'SELL') {
    // If post token balance is 0 or account is closed, 100% sold
    if (postTokenBalance <= 0 || !hasTokenBalanceChange) {
      soldPercent = 100;
    } else {
      const estimatedPre = tokenAmount + postTokenBalance;
      soldPercent = Number(Math.min(100, Math.max(1, (tokenAmount / estimatedPre) * 100)).toFixed(0));
    }
  }

  return {
    signature: tx.signature,
    walletAddress: matchingWallet,
    tokenMint,
    side,
    solAmount: Number(solAmount.toFixed(3)),
    tokenAmount,
    soldPercent,
    programId,
    timestamp: tx.timestamp || Math.floor(Date.now() / 1000),
  };
}
