import { askTradingCoPilot, lookupTokenAnalytics, predictTopGemsToBuy, renderTokenAnalyticsCard } from '../src/services/aiIntelligence.js';

async function test() {
  console.log('--- TEST 1: Predict Top Gems to Buy ---');
  const gems = await predictTopGemsToBuy();
  console.log(gems.text);
  console.log('Gems count:', gems.tokens.length);

  console.log('\n--- TEST 2: Ask about a specific coin ($NPC) ---');
  const npcAnswer = await askTradingCoPilot('tell me about $NPC and why should I buy or not?');
  console.log(npcAnswer);

  console.log('\n--- TEST 3: Ask about any token on Solana ($BONK) ---');
  const bonkAnswer = await askTradingCoPilot('what is $BONK, can you run analytics on it?');
  console.log(bonkAnswer);

  console.log('\n--- TEST 4: Ask for coin recommendations ("what coins should I buy right now?") ---');
  const recAnswer = await askTradingCoPilot('what coins should I buy right now?');
  console.log(recAnswer);

  console.log('\n--- TEST 5: Render Analytics Card with Reasons to Buy and Not to Buy ---');
  const audit = await lookupTokenAnalytics('NPC');
  if (audit) {
    console.log(renderTokenAnalyticsCard(audit));
  }
}

test().catch(console.error);
