import axios from 'axios';
import { env } from '../src/config/env.js';

async function testHeliusAsset(mint: string) {
  try {
    const url = env.HELIUS_RPC_URL;
    const res = await axios.post(url, {
      jsonrpc: '2.0',
      id: 'my-id',
      method: 'getAsset',
      params: { id: mint }
    }, { timeout: 5000 });

    console.log('Helius getAsset result:');
    const content = res.data?.result?.content;
    console.log('Metadata:', JSON.stringify(content?.metadata, null, 2));
    console.log('JSON URI:', content?.json_uri);
    console.log('Links:', content?.links);
    
    if (content?.json_uri) {
      const metaRes = await axios.get(content.json_uri, { timeout: 4000 });
      console.log('Off-chain JSON content:', metaRes.data);
    }
  } catch (err: any) {
    console.log('Helius error:', err.response?.data || err.message);
  }
}

testHeliusAsset('7GUnr7krtQhJwd6ASY2VUprd9t4c64zcgCsjdmZepump');
