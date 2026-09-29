import axios from 'axios';

async function testPumpFun(mint: string) {
  try {
    const res = await axios.get(`https://frontend-api.pump.fun/coins/${mint}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
      timeout: 3000,
    });
    console.log('Pump.fun coin data:', {
      name: res.data?.name,
      symbol: res.data?.symbol,
      description: res.data?.description,
      twitter: res.data?.twitter,
      telegram: res.data?.telegram,
      website: res.data?.website,
    });
  } catch (err: any) {
    console.log('Pump.fun fetch notice:', err.message);
  }
}

testPumpFun('7GUnr7krtQhJwd6ASY2VUprd9t4c64zcgCsjdmZepump');
testPumpFun('3tzkdxJ1qVCaPAuWmd8FjRFKUbwMYpLUAq5gg4Vopump');
