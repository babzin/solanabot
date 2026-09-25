import axios from 'axios';
import { env } from '../src/config/env.js';

async function callModelWithFallback(prompt: string) {
  const apiKey = env.GEMINI_API_KEY;
  const models = ['gemini-flash-lite-latest', 'gemini-3.6-flash', 'gemini-flash-latest'];

  for (const model of models) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const res = await axios.post(
        url,
        {
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.35, maxOutputTokens: 380 },
        },
        { timeout: 7000 }
      );
      const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) {
        console.log(`[Success with ${model}]`);
        return text;
      }
    } catch (err: any) {
      console.log(`[Model ${model} unavailable: ${err.response?.status || err.message}]`);
    }
  }
  return null;
}

async function testTokenNarrative(tokenName: string, scrapedInfo?: string) {
  const prompt = `You are a sharp, experienced Solana memecoin and DEX trader chatting directly with a fellow trader on Telegram.
The user is asking: "What is the narrative behind ${tokenName}?"

${scrapedInfo ? `LIVE TOKEN CONTEXT FROM DEX & WEBSITE:\n${scrapedInfo}\n` : ''}

Provide a deep, accurate breakdown:
1. The Core Narrative & Lore: What is this coin actually about? Where did it come from? What meme, tech, AI agent, or cultural movement is it riding?
2. Social & Community Vibe: What is the community buzz on Crypto Twitter and Telegram?
3. The Verdict / Meta: Is this a sticky narrative with legs, or a quick short-lived pump?

Tone:
- Talk like a real, experienced trader on Telegram.
- Direct, punchy, under 160 words.
- Format using clean Telegram HTML (<b>, <i>, <code>). Do not use markdown asterisks.`;

  const reply = await callModelWithFallback(prompt);
  console.log(`\n========================================`);
  console.log(`REPLY FOR: ${tokenName}`);
  console.log(`========================================`);
  console.log(reply);
}

async function run() {
  const npcContext = `Token: $NPC (NPCs)
Contract: 7GUnr7krtQhJwd6ASY2VUprd9t4c64zcgCsjdmZepump
Official Website: https://wenpc.family/
Website Title: NPCs
Website Tagline / Description: Every $10 of $NPC creator fees spawns an NPC: a wallet with its own LLM. It buys $5 of $NPC, trades pump.fun coins with the other $5, and puts every profit back into $NPC.
Twitter: https://x.com/wenpcfamily
Price: $0.00036 | MC: $347k`;

  await testTokenNarrative('$NPC (NPCs)', npcContext);
}

run();
