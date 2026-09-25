import axios from 'axios';

async function testDexScreenerEndpoints(mint: string) {
  const endpoints = [
    `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
    `https://api.dexscreener.com/orders/v1/solana/${mint}`,
    `https://api.dexscreener.com/tokens/v1/solana/${mint}`,
  ];

  for (const ep of endpoints) {
    try {
      const res = await axios.get(ep, { timeout: 4000 });
      console.log(`Endpoint: ${ep} -> Status: ${res.status}`);
      if (Array.isArray(res.data)) {
        console.log(`Array length: ${res.data.length}, First item keys: ${Object.keys(res.data[0] || {})}`);
        if (res.data[0]?.description) console.log('Description:', res.data[0].description);
        if (res.data[0]?.info) console.log('Info:', JSON.stringify(res.data[0].info));
      } else {
        console.log('Object keys:', Object.keys(res.data));
        if (res.data.pairs?.[0]?.info) {
          console.log('Pairs[0].info:', JSON.stringify(res.data.pairs[0].info, null, 2));
        }
      }
    } catch (err: any) {
      console.log(`Endpoint ${ep} failed:`, err.message);
    }
  }
}

testDexScreenerEndpoints('7GUnr7krtQhJwd6ASY2VUprd9t4c64zcgCsjdmZepump');
