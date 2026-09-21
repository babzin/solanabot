import { dispatchEarlyTrendingAlert, dispatchPricePumpMilestoneAlert } from '../src/services/telegram.js';

async function sendSampleAlert() {
  console.log('📨 Sending sample alert card to Telegram...');

  const sampleCandidate = {
    tokenMint: '9vByBALakH19cSvaqvxAXPJHw1m2xYHC34kaR33zpump',
    pairAddress: '7Rnw9QqtF2HFM6tKAegLpe96n56jMctkotBTKSHXWBEq',
    dexUrl: 'https://dexscreener.com/solana/7rnw9qqtf2hfm6tkaeglpe96n56jmctkotbtkshxwbeq',
    tokenName: 'musebook.trade',
    tokenSymbol: 'musebook',
    priceUsd: 0.0000562,
    marketCap: 56200,
    target5xMarketCap: 281000,
    target20xMarketCap: 1124000,
    liquidityUsd: 18800,
    poolReserveSol: 22.0,
    volume1h: 15400,
    volume24h: 32000,
    ageText: '2m',
    whaleSolAmount: 5.2,
    whaleConvictionReason: '⚡ 5-Minute Volume Spike ($3,200 in 5m)',
    narrativeTag: '🔥 Viral Meme / Community Cult',
    securityPassed: true,
    mintAuthorityRevoked: true,
    freezeAuthorityRevoked: true,
    lpBurnedOrLocked: true,
    potentialScore: 84.5,
    holderCount: 393,
    top20Pct: 30,
    devHoldingPct: 0,
    devAddress: '6hb1Nmj9C8xZe5oWAKYBgJcPMZnqxAGTHPBqouuy5NmM',
    topHoldersDistribution: [
      { address: '6hb1Nmj9C8xZe5oWAKYBgJcPMZnqxAGTHPBqouuy5NmM', pct: 0, type: 'dev' },
      { address: '7Rnw9QqtF2HFM6tKAegLpe96n56jMctkotBTKSHXWBEq', pct: 4.8, type: 'bundle' },
      { address: '8YwK5BvZ1xR3nL8vT2pQ9k4sJ7mF6cX5zD1aN0bV4eW9', pct: 4.2, type: 'bundle' },
      { address: '9ZaL3BxK1mY6nF8vT2pQ9k4sJ7mF6cX5zD1aN0bV4eW8', pct: 3.9, type: 'bundle' },
      { address: '5XvK1mY6nF8vT2pQ9k4sJ7mF6cX5zD1aN0bV4eW7', pct: 2.8, type: 'whale' },
      { address: '4UvK1mY6nF8vT2pQ9k4sJ7mF6cX5zD1aN0bV4eW6', pct: 1.5, type: 'fish' },
      { address: '3TvK1mY6nF8vT2pQ9k4sJ7mF6cX5zD1aN0bV4eW5', pct: 1.2, type: 'fish' },
      { address: '2SvK1mY6nF8vT2pQ9k4sJ7mF6cX5zD1aN0bV4eW4', pct: 0.9, type: 'fish' },
      { address: '1RvK1mY6nF8vT2pQ9k4sJ7mF6cX5zD1aN0bV4eW3', pct: 0.3, type: 'shrimp' },
      { address: '9QvK1mY6nF8vT2pQ9k4sJ7mF6cX5zD1aN0bV4eW2', pct: 0.8, type: 'fish' },
      { address: '8PvK1mY6nF8vT2pQ9k4sJ7mF6cX5zD1aN0bV4eW1', pct: 0.7, type: 'fish' },
      { address: '7OvK1mY6nF8vT2pQ9k4sJ7mF6cX5zD1aN0bV4eW0', pct: 0.6, type: 'fish' },
      { address: '6NvK1mY6nF8vT2pQ9k4sJ7mF6cX5zD1aN0bV4eW9', pct: 0.2, type: 'shrimp' },
      { address: '5MvK1mY6nF8vT2pQ9k4sJ7mF6cX5zD1aN0bV4eW8', pct: 0.5, type: 'fish' },
      { address: '4LvK1mY6nF8vT2pQ9k4sJ7mF6cX5zD1aN0bV4eW7', pct: 0.4, type: 'fish' },
      { address: '3KvK1mY6nF8vT2pQ9k4sJ7mF6cX5zD1aN0bV4eW6', pct: 0.4, type: 'fish' },
      { address: '2JvK1mY6nF8vT2pQ9k4sJ7mF6cX5zD1aN0bV4eW5', pct: 0.2, type: 'shrimp' },
      { address: '1IvK1mY6nF8vT2pQ9k4sJ7mF6cX5zD1aN0bV4eW4', pct: 0.4, type: 'fish' },
      { address: '9HvK1mY6nF8vT2pQ9k4sJ7mF6cX5zD1aN0bV4eW3', pct: 2.6, type: 'whale' },
      { address: '8GvK1mY6nF8vT2pQ9k4sJ7mF6cX5zD1aN0bV4eW2', pct: 0.5, type: 'fish' },
    ],
  };

  await dispatchEarlyTrendingAlert(sampleCandidate, 1);
  console.log('✅ Sent sample early trending alert card to Telegram!');

  await dispatchPricePumpMilestoneAlert({
    tokenMint: sampleCandidate.tokenMint,
    tokenSymbol: sampleCandidate.tokenSymbol,
    tokenName: sampleCandidate.tokenName,
    entryPriceUsd: 0.0000562,
    currentPriceUsd: 0.0001124,
    entryMarketCap: 56200,
    currentMarketCap: 112400,
    gainPercent: 100.0,
    milestonePercent: 100,
    multiplier: 2.0,
    elapsedTimeText: '15m',
    dexUrl: sampleCandidate.dexUrl,
  });
  console.log('✅ Sent sample 2X price pump milestone card to Telegram!');
}

sendSampleAlert()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
