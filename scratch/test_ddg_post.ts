import axios from 'axios';

async function testDDGPost(q: string) {
  try {
    const res = await axios.post(
      'https://html.duckduckgo.com/html/',
      new URLSearchParams({ q }).toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        timeout: 6000,
      }
    );
    console.log('Status:', res.status, 'HTML length:', res.data.length);
    const snippets = (res.data.match(/<a class="result__snippet[^>]*>([\s\S]*?)<\/a>/g) || [])
      .slice(0, 5)
      .map((s: string) => s.replace(/<[^>]+>/g, '').trim());
    console.log('Snippets count:', snippets.length);
    console.log(snippets);
    return snippets;
  } catch (err: any) {
    console.log('DDG POST error:', err.message);
    return [];
  }
}

testDDGPost('NPC Non Playable Coin solana meme narrative');
