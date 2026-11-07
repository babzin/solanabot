import { isValidSolanaAddress } from './adminConfig.js';
import { processSingleTrendingToken } from './earlyTrending.js';

// Common Solana system & protocol addresses to ignore during extraction
const IGNORED_PROGRAM_ADDRESSES = new Set([
  '11111111111111111111111111111111',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  'ComputeBudget111111111111111111111111111111',
  'So11111111111111111111111111111111111111112', // WSOL
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', // Pump.fun program
  'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX', // OpenBook
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', // Orca Whirlpool
  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s', // Metaplex Token Metadata
]);

/**
 * Extracts candidate Solana token mint addresses from raw text (e.g. @solearlytrending posts)
 */
export function extractSolanaMints(text: string): string[] {
  if (!text || typeof text !== 'string') return [];

  const tokenMints = new Set<string>();

  // 1. Explicit token URL indicators (DexScreener, SoulTerminal, Solscan token, Pump.fun, Photon, Sniper deep-links)
  const tokenUrlRegex = /(?:dexscreener\.com\/solana\/|solscan\.io\/token\/|soulterminal\.ai\/token\/|pump\.fun\/coin\/|photon-sol\.tinyastro\.com\/en\/lp\/|(?:start=|startapp=)(?:15_et[bc]|ets|ett_track|fakevol|ivb_bundle|ivf_first20)_)([1-9A-HJ-NP-za-km-z]{32,44})/gi;
  let urlMatch;
  while ((urlMatch = tokenUrlRegex.exec(text)) !== null) {
    const mint = urlMatch[1];
    if (!IGNORED_PROGRAM_ADDRESSES.has(mint) && isValidSolanaAddress(mint)) {
      tokenMints.add(mint);
    }
  }

  // If we found explicit token mints from URLs, return them directly (ignoring holder accounts)
  if (tokenMints.size > 0) {
    return Array.from(tokenMints);
  }

  // 2. Fallback: Standalone base58 words (if no explicit URL matched)
  // Exclude solscan.io/account/ links so we don't accidentally treat holder accounts as tokens
  const textWithoutAccounts = text.replace(/solscan\.io\/account\/[1-9A-HJ-NP-za-km-z]{32,44}/gi, '');
  const potentialMatches = textWithoutAccounts.match(/\b[1-9A-HJ-NP-za-km-z]{32,44}\b/g) || [];

  for (const match of potentialMatches) {
    const trimmed = match.trim();
    if (IGNORED_PROGRAM_ADDRESSES.has(trimmed)) continue;
    if (isValidSolanaAddress(trimmed)) {
      tokenMints.add(trimmed);
    }
  }

  return Array.from(tokenMints);
}

/**
 * Checks if the text matches the structure or signature of a @solearlytrending alert
 */
export function isSolearlytrendingSignature(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return (
    lower.includes('solearlytrending') ||
    lower.includes('new trending') ||
    (lower.includes('hodls:') && lower.includes('dev:')) ||
    (lower.includes('first 20') && lower.includes('bundles')) ||
    (lower.includes('mc:') && lower.includes('liq:'))
  );
}

export interface IngestionResult {
  success: boolean;
  mintsFound: string[];
  processedMints: string[];
  errors: string[];
  message: string;
}

/**
 * Ingests and processes a trending signal message from @solearlytrending or any authorized source.
 * Extracts tokens, executes security audit, broadcasts group alert, and triggers auto-sniping.
 */
export async function ingestTrendingSignal(
  text: string,
  options?: { source?: string; senderId?: string }
): Promise<IngestionResult> {
  const source = options?.source || 'direct';
  console.log(`📥 [Signal Ingestor] Received incoming signal from [${source}] (${text.length} chars)`);

  const mints = extractSolanaMints(text);
  if (mints.length === 0) {
    return {
      success: false,
      mintsFound: [],
      processedMints: [],
      errors: ['No valid Solana mint addresses detected in the provided signal.'],
      message: 'No valid Solana mint address found.',
    };
  }

  console.log(`🔍 [Signal Ingestor] Extracted ${mints.length} token mint(s):`, mints);

  const processedMints: string[] = [];
  const errors: string[] = [];

  for (const mint of mints) {
    try {
      const res = await processSingleTrendingToken(mint);
      if (res.success && res.candidate) {
        processedMints.push(mint);
      } else {
        errors.push(`Token ${mint}: ${res.error || 'Failed evaluation'}`);
      }
    } catch (err: any) {
      errors.push(`Token ${mint}: ${err.message}`);
    }
  }

  const success = processedMints.length > 0;
  const message = success
    ? `Successfully ingested and alerted ${processedMints.length} token(s).`
    : `Could not process candidate token(s): ${errors.join(', ')}`;

  return {
    success,
    mintsFound: mints,
    processedMints,
    errors,
    message,
  };
}

