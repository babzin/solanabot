import axios from 'axios';

async function testPumpWithHeaders(mint: string) {
  try {
    const res = await axios.get(`https://frontend-api.pump.fun/coins/${mint}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Referer': 'https://pump.fun/',
        'Origin': 'https://pump.fun'
      },
      timeout: 5000
    });
    console.log('PumpFun success:', res.data.name, res.data.description);
    return res.data;
  } catch (err: any) {
    console.log('PumpFun headers error:', err.message);
  }
}

async function testJupiterTokenList(mint: string) {
  try {
    const res = await axios.get(`https://tokens.jup.ag/token/${mint}`, { timeout: 4000 });
    console.log('Jupiter token data:', res.data);
  } catch (err: any) {
    console.log('Jupiter token notice:', err.message);
  }
}

async function testCoinGecko(query: string) {
  try {
    const res = await axios.get(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(query)}`, { timeout: 4000 });
    const coin = res.data?.coins?.[0];
    console.log('CoinGecko coin:', coin);
    if (coin?.id) {
      const detail = await axios.get(`https://api.coingecko.com/api/v3/coins/${coin.id}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false`, { timeout: 4000 });
      console.log('CoinGecko desc:', detail.data?.description?.en?.slice(0, 300));
    }
  } catch (err: any) {
    console.log('CoinGecko notice:', err.message);
  }
}

async function run() {
  await testPumpWithHeaders('7GUnr7krtQhJwd6ASY2VUprd9t4c64zcgCsjdmZepump');
  await testJupiterTokenList('7GUnr7krtQhJwd6ASY2VUprd9t4c64zcgCsjdmZepump');
  await testCoinGecko('Non Playable Coin');
}

run();
