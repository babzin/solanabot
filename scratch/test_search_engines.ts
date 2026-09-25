import axios from 'axios';

async function testDexScreenerCommunity(mint: string) {
  try {
    const res = await axios.get(`https://api.dexscreener.com/orders/v1/solana/${mint}`);
    console.log('Orders/Profile:', JSON.stringify(res.data, null, 2));
  } catch (err: any) {
    console.log('Orders error:', err.message);
  }
}

async function testSearchEngines(q: string) {
  // Try duckduckgo lite
  try {
    const res = await axios.get(`https://lite.duckduckgo.com/lite/`, {
      params: { q },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 5000
    });
    console.log('Lite DDG status:', res.status, 'Length:', res.data.length);
    const snippets = (res.data.match(/<td class="result-snippet">([\s\S]*?)<\/td>/g) || [])
      .slice(0, 4)
      .map((s: string) => s.replace(/<[^>]+>/g, '').trim());
    console.log('DDG Lite snippets:', snippets);
  } catch (err: any) {
    console.log('DDG lite error:', err.message);
  }
}

async function testWebsiteFetch(url: string) {
  try {
    const res = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 5000
    });
    // extract meta description or title or text
    const titleMatch = res.data.match(/<title[^>]*>(.*?)<\/title>/i);
    const descMatch = res.data.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i) ||
                      res.data.match(/<meta[^>]*content=["']([^"']*)["'][^>]*name=["']description["']/i);
    const ogDescMatch = res.data.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']*)["']/i);
    
    // clean text
    const bodyText = res.data.replace(/<script[\s\S]*?<\/script>/gi, '')
                             .replace(/<style[\s\S]*?<\/style>/gi, '')
                             .replace(/<[^>]+>/g, ' ')
                             .replace(/\s+/g, ' ')
                             .slice(0, 800);

    console.log('Website title:', titleMatch?.[1]);
    console.log('Website desc:', descMatch?.[1] || ogDescMatch?.[1]);
    console.log('Website text snippet:', bodyText.slice(0, 300));
  } catch (err: any) {
    console.log('Website fetch error:', err.message);
  }
}

async function run() {
  await testDexScreenerCommunity('7GUnr7krtQhJwd6ASY2VUprd9t4c64zcgCsjdmZepump');
  await testSearchEngines('NPC solana memecoin narrative');
  await testWebsiteFetch('https://wenpc.family/');
}
run();
