import axios from 'axios';

export interface TelegramSentimentData {
  channelSlug?: string;
  hasPublicChannel: boolean;
  messageCount: number;
  recentMessages: string[];
  organicRatio: number; // 0.0 (all spam/bots) to 1.0 (all organic human dialogue)
  isRaidSpam: boolean;
  totalReactionsDetected: number;
  sentimentSummary: string;
}

export interface TwitterSentimentData {
  handle?: string;
  url?: string;
  isBrandedHandle: boolean;
  isSuspiciousHandle: boolean;
  legitimacyScore: number; // 1 to 10
}

export interface CommunityIntelligenceBundle {
  tokenSymbol: string;
  tokenName: string;
  tokenMint: string;
  telegram: TelegramSentimentData;
  twitter: TwitterSentimentData;
  websiteTextSnippet?: string;
  onChainMetrics: {
    ageMinutes: number;
    marketCap: number;
    volume1h: number;
    volume5m: number;
    buySellRatio: number;
    buys5m: number;
    sells5m: number;
    holderCount: number;
    devHoldingPct: number;
    devSoldPct: number;
  };
  rawBriefing: string;
}

/**
 * 100% Free / Zero-Cost Telegram Public Community Scraper
 * Uses official public web mirror (https://t.me/s/{channel}) without Telethon, phone logins, or API keys.
 */
export async function fetchTelegramCommunitySentiment(telegramUrl?: string): Promise<TelegramSentimentData> {
  const result: TelegramSentimentData = {
    hasPublicChannel: false,
    messageCount: 0,
    recentMessages: [],
    organicRatio: 0.5,
    isRaidSpam: false,
    totalReactionsDetected: 0,
    sentimentSummary: 'No Telegram link provided.',
  };

  if (!telegramUrl || typeof telegramUrl !== 'string') {
    return result;
  }

  // Extract channel slug (e.g., https://t.me/pepe -> pepe)
  const cleanUrl = telegramUrl.trim();
  const slugMatch = cleanUrl.match(/(?:t\.me\/(?:s\/)?|telegram\.me\/|@)([A-Za-z0-9_]{3,32})/i);
  if (!slugMatch || !slugMatch[1]) {
    result.sentimentSummary = 'Invalid or non-public Telegram format.';
    return result;
  }

  const slug = slugMatch[1].toLowerCase();
  result.channelSlug = slug;

  try {
    const webMirrorUrl = `https://t.me/s/${slug}`;
    const res = await axios.get(webMirrorUrl, {
      timeout: 3500,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });

    if (res.status === 200 && typeof res.data === 'string') {
      result.hasPublicChannel = true;

      // Extract message texts from Telegram web widget
      const rawMatches = res.data.match(/<div class="tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/g) || [];
      const messages: string[] = [];

      for (const m of rawMatches.slice(-15)) {
        // Strip HTML tags and normalize whitespace
        const cleanText = m
          .replace(/<br\s*\/?>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (cleanText.length > 3) {
          messages.push(cleanText);
        }
      }

      result.messageCount = messages.length;
      result.recentMessages = messages;

      // Analyze for Bot Raids vs Organic Human Engagement
      if (messages.length > 0) {
        const uniqueMessages = new Set(messages.map((m) => m.toLowerCase().slice(0, 40)));
        const repetitionFactor = uniqueMessages.size / messages.length;

        // Count raid command patterns & generic copypasta shills
        let raidBotHits = 0;
        const botPatterns = [
          /\/raid/i,
          /smash the raid/i,
          /click here to verify/i,
          /join now.*bot/i,
          /portal.*verify/i,
          /retweet.*comment/i,
          /lfg.*lfg/i,
          /buy.*pump.*now/i,
          /automated.*system/i,
        ];

        for (const msg of messages) {
          if (botPatterns.some((pattern) => pattern.test(msg))) {
            raidBotHits++;
          }
        }

        const raidDensity = raidBotHits / messages.length;
        result.isRaidSpam = raidDensity > 0.45 || repetitionFactor < 0.40;

        // Organic dialogue ratio (0.0 to 1.0)
        result.organicRatio = Number(Math.max(0.1, Math.min(1.0, repetitionFactor * (1 - raidDensity))).toFixed(2));

        // Reaction analysis
        const reactionMatches = res.data.match(/class="tgme_reaction[^>]*>.*?<\/span>/g) || [];
        result.totalReactionsDetected = reactionMatches.length;

        result.sentimentSummary = result.isRaidSpam
          ? `⚠️ Coordinated raid or bot spam detected (${Math.round((1 - result.organicRatio) * 100)}% bot noise).`
          : `✅ Active community stream (${messages.length} recent posts, ${Math.round(result.organicRatio * 100)}% organic dialogue).`;
      } else {
        result.sentimentSummary = 'Public channel active, but no recent text messages rendered.';
      }
    }
  } catch (err: any) {
    result.sentimentSummary = `Telegram preview notice: ${err.message}`;
  }

  return result;
}

/**
 * 100% Free / Zero-Cost Twitter/X Metadata & Handle Evaluator
 * Evaluates authenticity without expensive Enterprise Developer keys.
 */
export function fetchTwitterCommunitySentiment(
  twitterUrl?: string,
  tokenSymbol?: string,
  tokenName?: string
): TwitterSentimentData {
  const result: TwitterSentimentData = {
    isBrandedHandle: false,
    isSuspiciousHandle: false,
    legitimacyScore: 5,
  };

  if (!twitterUrl || typeof twitterUrl !== 'string') {
    result.legitimacyScore = 2;
    return result;
  }

  result.url = twitterUrl;
  const match = twitterUrl.match(/(?:twitter\.com|x\.com)\/([A-Za-z0-9_]{1,32})/i);
  if (!match || !match[1]) {
    result.legitimacyScore = 3;
    return result;
  }

  const handle = match[1];
  result.handle = `@${handle}`;

  const cleanHandle = handle.toLowerCase();
  const cleanSymbol = (tokenSymbol || '').toLowerCase();
  const cleanName = (tokenName || '').toLowerCase().replace(/[^a-z0-9]/g, '');

  // 1. Check for branded handle match
  if (cleanSymbol && cleanHandle.includes(cleanSymbol)) {
    result.isBrandedHandle = true;
    result.legitimacyScore += 2;
  } else if (cleanName && cleanHandle.includes(cleanName.slice(0, 5))) {
    result.isBrandedHandle = true;
    result.legitimacyScore += 2;
  }

  // 2. Check for disposable / suspicious bot handle pattern (e.g., random numbers: user_98234812)
  if (/[0-9]{5,}$/.test(cleanHandle) || /^user[0-9]+/i.test(cleanHandle)) {
    result.isSuspiciousHandle = true;
    result.legitimacyScore -= 4;
  }

  // Clamp score
  result.legitimacyScore = Math.max(1, Math.min(10, result.legitimacyScore));
  return result;
}

/**
 * Aggregates all community, on-chain, and social streams into a single briefing for the SLM.
 */
export async function aggregateCommunityIntelligence(params: {
  tokenSymbol: string;
  tokenName: string;
  tokenMint: string;
  telegramUrl?: string;
  twitterUrl?: string;
  websiteTextSnippet?: string;
  ageMinutes: number;
  marketCap: number;
  volume1h: number;
  volume5m: number;
  buySellRatio: number;
  buys5m: number;
  sells5m: number;
  holderCount: number;
  devHoldingPct: number;
  devSoldPct: number;
}): Promise<CommunityIntelligenceBundle> {
  const [telegram, twitter] = await Promise.all([
    fetchTelegramCommunitySentiment(params.telegramUrl),
    Promise.resolve(fetchTwitterCommunitySentiment(params.twitterUrl, params.tokenSymbol, params.tokenName)),
  ]);

  const onChainMetrics = {
    ageMinutes: params.ageMinutes,
    marketCap: params.marketCap,
    volume1h: params.volume1h,
    volume5m: params.volume5m,
    buySellRatio: params.buySellRatio,
    buys5m: params.buys5m,
    sells5m: params.sells5m,
    holderCount: params.holderCount,
    devHoldingPct: params.devHoldingPct,
    devSoldPct: params.devSoldPct,
  };

  // Compile prompt-ready intelligence briefing
  const briefingLines: string[] = [
    `=== COMMUNITY & SOCIAL INTELLIGENCE BRIEFING ===`,
    `Token: $${params.tokenSymbol} (${params.tokenName}) | Mint: ${params.tokenMint}`,
    `Pool Age: ${params.ageMinutes}m | Market Cap: $${Math.round(params.marketCap)} | Holders: ${params.holderCount}`,
    `On-Chain Velocity: 5m Vol: $${Math.round(params.volume5m)} (${params.buys5m} Buys / ${params.sells5m} Sells, Buy/Sell Ratio: ${params.buySellRatio.toFixed(2)})`,
    `Dev State: Dev Holding: ${params.devHoldingPct.toFixed(1)}% | Dev Sold: ${params.devSoldPct.toFixed(1)}%`,
    ``,
    `[TELEGRAM COMMUNITY SIGNALS]`,
    `• Public Channel: ${telegram.hasPublicChannel ? `@${telegram.channelSlug}` : 'None or Private'}`,
    `• Community Activity: ${telegram.sentimentSummary}`,
    `• Organic vs Bot Noise Ratio: ${Math.round(telegram.organicRatio * 100)}% Organic`,
    telegram.recentMessages.length > 0
      ? `• Recent Community Discussion Sample:\n  - "${telegram.recentMessages.slice(-5).join('"\n  - "')}"`
      : `• No recent public messages available.`,
    ``,
    `[TWITTER / X NARRATIVE SIGNALS]`,
    `• Handle: ${twitter.handle || 'None'} | Branded Match: ${twitter.isBrandedHandle ? 'YES' : 'NO'} | Suspicious Disposable: ${twitter.isSuspiciousHandle ? 'YES' : 'NO'}`,
    `• Profile Legitimacy Score: ${twitter.legitimacyScore}/10`,
    ``,
    `[WEBSITE & NARRATIVE SNIPPET]`,
    params.websiteTextSnippet
      ? `• Content Preview: "${params.websiteTextSnippet.slice(0, 300)}..."`
      : `• No website or content preview found.`,
    `================================================`,
  ];

  return {
    tokenSymbol: params.tokenSymbol,
    tokenName: params.tokenName,
    tokenMint: params.tokenMint,
    telegram,
    twitter,
    websiteTextSnippet: params.websiteTextSnippet,
    onChainMetrics,
    rawBriefing: briefingLines.join('\n'),
  };
}
