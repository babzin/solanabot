import axios from 'axios';

async function testJupToken(mint: string) {
  try {
    const res = await axios.get(`https://tokens.jup.ag/token/${mint}`, { timeout: 3000 });
    console.log('Jupiter token info for', mint, ':', res.data);
  } catch (err: any) {
    console.log('Jupiter token notice:', err.message);
  }
}

testJupToken('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'); // BONK
testJupToken('7GUnr7krtQhJwd6ASY2VUprd9t4c64zcgCsjdmZepump'); // NPC
