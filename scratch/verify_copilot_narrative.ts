import { askTradingCoPilot, lookupTokenAnalytics, renderTokenAnalyticsCard } from '../src/services/aiIntelligence.js';

async function testQuery(question: string) {
  console.log(`\n======================================================`);
  console.log(`USER QUESTION: "${question}"`);
  console.log(`======================================================`);
  const answer = await askTradingCoPilot(question);
  console.log(answer);
}

async function run() {
  await testQuery('what is the narrative of $NPC?');
  await testQuery('what is the narrative of NPC');
  await testQuery('what is UNTXD about?');
  await testQuery('tell me the lore and narrative of BONK');

  console.log(`\n======================================================`);
  console.log(`TESTING INSTANT ANALYTICS CARD WITH WEB NARRATIVE:`);
  console.log(`======================================================`);
  const audit = await lookupTokenAnalytics('NPC');
  if (audit) {
    console.log(renderTokenAnalyticsCard(audit));
  }
}

run();
