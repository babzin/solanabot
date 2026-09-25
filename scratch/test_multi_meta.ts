import axios from 'axios';

async function inspectTokenMeta(mint: string) {
  try {
    const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { timeout: 4000 });
    const pair = res.data?.pairs?.[0];
    console.log(`\n=== Token: ${pair?.baseToken?.symbol} (${pair?.baseToken?.name}) ===`);
    console.log('Websites:', pair?.info?.websites);
    console.log('Socials:', pair?.info?.socials);
    if (pair?.info?.websites?.[0]?.url) {
      try {
        const site = await axios.get(pair.info.websites[0].url, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          timeout: 4000
        });
        const descMatch = site.data.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i) ||
                          site.data.match(/<meta[^>]*content=["']([^"']*)["'][^>]*name=["']description["']/i) ||
                          site.data.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']*)["']/i);
        const titleMatch = site.data.match(/<title[^>]*>(.*?)<\/title>/i);
        const bodySnippet = site.data.replace(/<script[\s\S]*?<\/script>/gi, '')
                                     .replace(/<style[\s\S]*?<\/style>/gi, '')
                                     .replace(/<[^>]+>/g, ' ')
                                     .replace(/\s+/g, ' ')
                                     .slice(0, 400);
        console.log('Site Title:', titleMatch?.[1]);
        console.log('Site Description:', descMatch?.[1]);
        console.log('Site Body Preview:', bodySnippet.slice(0, 200));
      } catch (err: any) {
        console.log('Site fetch error:', err.message);
      }
    }
  } catch (err: any) {
    console.log('Token error:', err.message);
  }
}

async function run() {
  await inspectTokenMeta('3tzkdxJ1qVCaPAuWmd8FjRFKUbwMYpLUAq5gg4Vopump'); // UNTXD
  await inspectTokenMeta('J6QTngAJdsRnVy9h3t9BqUxT7Q4EcRv3JjCwb6Cmpump'); // CHROME
  await inspectTokenMeta('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'); // BONK
}

run();
