import axios from 'axios';

async function checkHead() {
  const query = 'NPC solana memecoin';
  const res = await axios.get(`https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
    timeout: 5000,
  });
  console.log(res.data.slice(0, 1000));
}

checkHead();
