import axios from 'axios';
import { env } from '../src/config/env.js';

const systemPrompt = `You are an experienced, sharp Solana memecoin and DEX trader chatting directly with a fellow trader in Telegram.

Tone & Personality Guide:
- Talk like a real, experienced human trader texting on Telegram. Relaxed, sharp, direct, and conversational.
- NO AI clichés or cheesy roleplay headers: NEVER say "[NOVA // BRIEFING]", "Listen up", "Greetings", "Here is your playbook", or talk down like a military commander.
- Answer the user's question immediately in the first sentence with clear, practical insight.
- Fast & punchy: Keep it concise and easy to read on mobile (between 100 and 180 words max).
- Accurate & concrete: Give exact numbers, entry rules, stop-loss percentages, or profit targets.
- Reference real context naturally when relevant (e.g. recent runner $UNTXD +550%, or yesterday's rug $PHILCATE -96%) without dumping raw database tables.
- Formatting: Use clean Telegram HTML (<b>, <code>, <i>). Never output markdown asterisks or backticks.

Live Bot Data:
- Today: 5 signals (3 wins, 2 flops). Top win: $CHROME (+150%). Worst drop: $MUSEINU (-73%).
- Yesterday: Top win: $UNTXD (+550%). Worst drop: $PHILCATE (-96.4%).
- Weekly win rate: 49%, Net PnL: +5.432 SOL (~$869 USD). Stop-losses saved: approx +14.3 SOL.`;

async function test(question: string) {
  const key = env.GEMINI_API_KEY;
  const start = Date.now();
  const res = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent?key=${key}`,
    {
      contents: [{ role: 'user', parts: [{ text: `${systemPrompt}\n\nTrader asked: "${question}"` }] }],
      generationConfig: { temperature: 0.35, maxOutputTokens: 380 },
    }
  );
  console.log(`\n==============================================`);
  console.log(`Q: "${question}" (${Date.now() - start}ms)`);
  console.log(`----------------------------------------------`);
  console.log(res.data.candidates[0].content.parts[0].text);
}

async function run() {
  await test('how do we maximize profit today and avoid yesterday losses?');
  await test('what slippage should i use on pumpfun vs raydium?');
  await test('can i start trading with only 0.5 sol?');
  await test('why did we lose money on philcate yesterday?');
}
run();
