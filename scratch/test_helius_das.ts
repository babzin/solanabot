import axios from 'axios';
import { env } from '../src/config/env.js';

async function testHeliusDas(mint: string) {
  try {
    const url = `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`;
    const res = await axios.post(url, {
      jsonrpc: '2.0',
      id: 'test',
      method: 'getAsset',
      params: { id: mint },
    });
    console.log('Helius DAS for', mint, ':', {
      content: res.data?.result?.content?.metadata,
      json_uri: res.data?.result?.content?.json_uri,
      description: res.data?.result?.content?.metadata?.description,
    });
  } catch (err: any) {
    console.log('Helius DAS notice:', err.message);
  }
}

testHeliusDas('7GUnr7krtQhJwd6ASY2VUprd9t4c64zcgCsjdmZepump'); // NPC
testHeliusDas('3tzkdxJ1qVCaPAuWmd8FjRFKUbwMYpLUAq5gg4Vopump'); // UNTXD
