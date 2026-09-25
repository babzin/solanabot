import axios from 'axios';

async function checkGoogleText() {
  const query = 'NPC solana memecoin';
  const res = await axios.get(`https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
    timeout: 5000,
  });
  
  // Find all <span> or <div> tags containing text longer than 40 chars
  const allSpans = res.data.match(/<span[^>]*>([^<]{40,300})<\/span>/g) || [];
  console.log('Spans found:', allSpans.length);
  const cleanSpans = allSpans.slice(0, 8).map((s: string) => s.replace(/<[^>]+>/g, '').trim());
  console.log('Sample spans:\n', cleanSpans.join('\n---\n'));
}

checkGoogleText();
