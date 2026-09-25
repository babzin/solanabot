import axios from 'axios';

async function testBing(query: string) {
  try {
    const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
    const res = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 5000,
    });
    console.log('Bing status:', res.status, 'Length:', res.data.length);
    // Find snippets in bing: <p class="b_lineclamp..."> or <div class="b_caption"><p>
    const matches = res.data.match(/<div class="b_caption">[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/gi) || [];
    const snippets = matches.slice(0, 4).map((m: string) => m.replace(/<[^>]+>/g, '').trim());
    console.log('Bing snippets count:', snippets.length);
    console.log(snippets);
    return snippets;
  } catch (err: any) {
    console.log('Bing error:', err.message);
    return [];
  }
}

async function testGoogle(query: string) {
  try {
    const url = `https://html.duckduckgo.com/html/`;
    // Try Google web
    const res = await axios.get(`https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      timeout: 5000,
    });
    console.log('Google status:', res.status, 'Length:', res.data.length);
    const matches = res.data.match(/<div class="BNeawe s3v9rd AP7Wnd"[^>]*>([\s\S]*?)<\/div>/gi) || [];
    const snippets = matches.slice(0, 4).map((m: string) => m.replace(/<[^>]+>/g, '').trim());
    console.log('Google snippets count:', snippets.length);
    console.log(snippets);
    return snippets;
  } catch (err: any) {
    console.log('Google error:', err.message);
    return [];
  }
}

async function run() {
  await testBing('NPC solana token meme coin narrative');
  await testGoogle('NPC solana token meme coin narrative');
}

run();
