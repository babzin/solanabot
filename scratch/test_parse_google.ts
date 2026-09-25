import axios from 'axios';

async function parseGoogle() {
  const query = 'NPC solana memecoin twitter crypto';
  const res = await axios.get(`https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
    timeout: 5000,
  });
  
  // Search for snippets in Google HTML
  // In modern Google, text is inside spans or divs inside results
  const matches = res.data.match(/<div[^>]+data-sncf[^>]*>([\s\S]*?)<\/div>/gi) ||
                  res.data.match(/<div class="VwiC3b[^"]*"[^>]*>([\s\S]*?)<\/div>/gi) ||
                  res.data.match(/<span class="aCOpRe"[^>]*>([\s\S]*?)<\/span>/gi) || [];
  
  console.log('Matches count:', matches.length);
  const textMatches = matches.slice(0, 5).map((m: string) => m.replace(/<[^>]+>/g, '').trim());
  console.log(textMatches);
}

parseGoogle();
