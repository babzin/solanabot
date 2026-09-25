import axios from 'axios';
import { env } from '../src/config/env.js';

async function testNormalGemini() {
  const apiKey = env.GEMINI_API_KEY;
  for (const model of ['gemini-3.6-flash', 'gemini-flash-latest', 'gemini-flash-lite-latest']) {
    try {
      console.log(`Testing normal generation with ${model}...`);
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const res = await axios.post(url, {
        contents: [{ role: 'user', parts: [{ text: 'Hello, are you online?' }] }]
      }, { timeout: 5000 });
      console.log(`SUCCESS with ${model}:`, res.data.candidates[0].content.parts[0].text);
      return;
    } catch (err: any) {
      console.log(`${model} error:`, err.response?.data?.error?.message || err.message);
    }
  }
}

testNormalGemini();
