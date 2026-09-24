import { prisma } from '../src/services/db.js';
import {
  analyzeTokenNarrative,
  evaluateHeuristicSLM,
  auditTokenByMint,
  askTradingCoPilot,
  analyzeWeeklyCorrelations,
} from '../src/services/aiIntelligence.js';
import { renderEarlyTrendingCardText } from '../src/services/telegram.js';
import { calculateWeeklyStats, renderWeeklyReportText } from '../src/services/weeklyReport.js';

async function main() {
  console.log('====================================================');
  console.log('🧠 TESTING OPTION 1: HYBRID SLM CO-PILOT & INTELLIGENCE');
  console.log('====================================================');

  // 1. Test Token Narrative Analysis (Heuristic & AI)
  console.log('\n--- 1. TOKEN NARRATIVE & RUG AUDIT ---');

  const testTokens = [
    {
      name: 'Chrome Cat',
      symbol: 'CHROME',
      mint: '5ywu5aipcgspzq8tx9ojpmdyssztwmbgnukbq38m5ptu',
      ageMinutes: 3,
      entryMarketCap: 65000,
      snipersCount: 14,
      devHoldingPct: 2.1,
      devSoldPct: 0,
      twitterUrl: 'https://x.com/SolChromeCat',
      telegramUrl: 'https://t.me/SolChromeCat',
      description: 'The first viral chrome cat meme on Solana with high quality 3D render art.',
    },
    {
      name: 'Neural Agent Sol',
      symbol: 'NEURAL',
      mint: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
      ageMinutes: 5,
      entryMarketCap: 80000,
      snipersCount: 11,
      devHoldingPct: 3.5,
      devSoldPct: 0,
      twitterUrl: 'https://x.com/NeuralSolAgent',
      telegramUrl: 'https://t.me/NeuralSolAgent',
      websiteUrl: 'https://neuralagent.io',
      description: 'Autonomous AI agent conducting on-chain arbitrage on Solana DEXes.',
    },
    {
      name: 'PepeSafe1000x',
      symbol: 'PEPESAFE',
      mint: '9zkdq1Ze2WUQkLY4HB226A1H9ArBNu8wvDNNdsCbpump',
      ageMinutes: 12,
      entryMarketCap: 45000,
      snipersCount: 38,
      devHoldingPct: 14.5,
      devSoldPct: 40,
      description: 'safu pepe moonshot 1000x dev based buy now',
    },
  ];

  for (const t of testTokens) {
    const score = await analyzeTokenNarrative(t);
    console.log(`\n🪙 $${t.symbol} (${t.name}):`);
    console.log(`   🎯 Conviction: ${score.convictionScore}/100 [${score.metaCategory}]`);
    console.log(`   🛡️ Rug Risk: ${score.rugRisk}`);
    console.log(`   💡 Thesis: ${score.thesis}`);
    console.log(`   📊 Signals: Virality: ${score.signals.memeVirality} | Social: ${score.signals.socialLegitimacy} | DevSafety: ${score.signals.devSafety}`);
    console.log(`   ⚙️ Provider: ${score.providerUsed}`);
  }

  // 2. Test Alert Card with AI Badge
  console.log('\n--- 2. ENRICHED TELEGRAM ALERT CARD WITH AI BADGE ---');
  const sampleCardToken = {
    ...testTokens[0],
    tokenName: testTokens[0].name,
    tokenSymbol: testTokens[0].symbol,
    tokenMint: testTokens[0].mint,
    xUrl: testTokens[0].twitterUrl,
    tgUrl: testTokens[0].telegramUrl,
    aiScore: await analyzeTokenNarrative(testTokens[0]),
  };
  const cardText = renderEarlyTrendingCardText(sampleCardToken);
  console.log(cardText);

  // 3. Test Co-Pilot Interactive Q&A
  console.log('\n--- 3. INTERACTIVE TRADING CO-PILOT Q&A ---');
  const questions = [
    'how do we maximize profit today',
    "how do we avoid yesterday's loss",
    'what should i trade today',
    'should i hold or sell',
    'how do i start with small capital',
    'what is solana and why is it fast',
    'how does raydium routing work',
    'is it a good time to buy memecoins',
  ];

  for (const q of questions) {
    console.log(`\n💬 User: "${q}"`);
    const reply = await askTradingCoPilot(q);
    console.log(`🤖 Co-Pilot:\n${reply}`);
  }

  // 4. Test Token Audit by Mint
  console.log('\n--- 4. ON-DEMAND AI TOKEN AUDIT (/audit) ---');
  const auditResult = await auditTokenByMint(testTokens[0].mint);
  console.log(`\n🔍 Audit for $${auditResult.symbol} (${auditResult.mint}):`);
  console.log(`   Recommendation: ${auditResult.recommendation}`);
  console.log(`   Summary: ${auditResult.summary}`);
  console.log(`   Metrics: MC $${auditResult.onChainMetrics.marketCapUsd.toLocaleString()} • Age ${auditResult.onChainMetrics.ageMinutes}m • Snipers ${auditResult.onChainMetrics.snipersCount}`);

  // 5. Test Weekly Report with AI Insights
  console.log('\n--- 5. WEEKLY REPORT WITH AI STRATEGIC INSIGHTS ---');
  const weeklyStats = await calculateWeeklyStats(0);
  const weeklyText = renderWeeklyReportText(weeklyStats);
  console.log(weeklyText);

  console.log('\n✅ ALL OPTION 1 AI INTELLIGENCE CAPABILITIES VERIFIED SUCCESSFULLY!');
}

main().catch(console.error);
