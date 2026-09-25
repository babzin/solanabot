import axios from 'axios';

async function testYahooSearch(query: string) {
  try {
    const url = `https://search.yahoo.com/search?p=${encodeURIComponent(query)}`;
    const res = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      timeout: 5000
    });
    const matches = res.data.match(/<div class="compText aAbs"[^>]*>([\s\S]*?)<\/div>/g) ||
                    res.data.match(/<p class="lh-16">([\s\S]*?)<\/p>/g) || [];
    const snippets = matches.slice(0, 4).map((m: string) => m.replace(/<[^>]+>/g, '').trim());
    console.log('Yahoo Search snippets for', query, ':');
    console.log(snippets);
    return snippets;
  } catch (err: any) {
    console.log('Yahoo error:', err.message);
    return [];
  }
}

async function testWikipedia(term: string) {
  try {
    const res = await axios.get(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(term)}`, { timeout: 4000 });
    console.log('Wiki extract for', term, ':', res.data?.extract);
    return res.data?.extract;
  } catch (err: any) {
    console.log('Wiki notice:', err.message);
  }
}

async function testKnowYourMeme(term: string) {
  try {
    const url = `https://search.yahoo.com/search?p=${encodeURIComponent('site:knowyourmeme.com ' + term)}`;
    const res = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 4000
    });
    const matches = res.data.match(/<div class="compText aAbs"[^>]*>([\s\S]*?)<\/div>/g) || [];
    console.log('KYM search for', term, ':', matches.slice(0, 2).map((m: string) => m.replace(/<[^>]+>/g, '')));
  } catch (err: any) {
    console.log('KYM notice:', err.message);
  }
}

async function run() {
  await testYahooSearch('NPC solana crypto token narrative x.com');
  await testWikipedia('NPC (meme)');
  await testYahooSearch('BONK solana coin lore history');
}

run();
