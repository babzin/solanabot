import axios from 'axios';

async function testJinaSearch(query: string) {
  try {
    const url = `https://s.jina.ai/${encodeURIComponent(query)}`;
    const res = await axios.get(url, {
      headers: {
        'Accept': 'text/plain',
        'User-Agent': 'Mozilla/5.0'
      },
      timeout: 8000
    });
    console.log('Jina Search Status:', res.status);
    console.log('Jina Output Preview:\n', res.data.slice(0, 1000));
    return res.data;
  } catch (err: any) {
    console.log('Jina error:', err.message);
  }
}

async function testJinaReader(urlToRead: string) {
  try {
    const url = `https://r.jina.ai/${urlToRead}`;
    const res = await axios.get(url, {
      headers: {
        'Accept': 'text/plain',
        'User-Agent': 'Mozilla/5.0'
      },
      timeout: 8000
    });
    console.log('Jina Reader Output for', urlToRead, ':\n', res.data.slice(0, 800));
  } catch (err: any) {
    console.log('Jina reader error:', err.message);
  }
}

async function run() {
  await testJinaSearch('NPC Non Playable Coin solana wenpcfamily twitter narrative');
  await testJinaReader('https://x.com/wenpcfamily');
}

run();
