import axios from 'axios';

async function testDDGApi(q: string) {
  try {
    const res = await axios.get(`https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 5000
    });
    console.log('Heading:', res.data.Heading);
    console.log('Abstract:', res.data.Abstract);
    console.log('AbstractText:', res.data.AbstractText);
    console.log('RelatedTopics:', res.data.RelatedTopics?.slice(0, 3));
  } catch (err: any) {
    console.log('DDG api error:', err.message);
  }
}

async function testGoogleSearchApi(q: string) {
  try {
    // Serper or Google public suggest
    const res = await axios.get(`https://suggestqueries.google.com/complete/search?client=chrome&q=${encodeURIComponent(q)}`);
    console.log('Google suggestions for', q, ':', res.data);
  } catch (err: any) {
    console.log('Google error:', err.message);
  }
}

async function run() {
  await testDDGApi('Non-Player Character meme');
  await testGoogleSearchApi('NPC solana token');
}

run();
