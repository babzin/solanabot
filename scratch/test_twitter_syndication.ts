import axios from 'axios';

async function testTwitterSyndication(username: string) {
  try {
    const url = `https://cdn.syndication.twimg.com/widgets/followbutton/info.json?screen_names=${username}`;
    const res = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 5000
    });
    console.log('Twitter User info for', username, ':', res.data);
  } catch (err: any) {
    console.log('Twitter syndication error:', err.message);
  }
}

async function testTwitterTimeline(username: string) {
  try {
    const url = `https://syndication.twitter.com/srv/timeline-profile/screen-name/${username}`;
    const res = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 5000
    });
    console.log('Timeline status:', res.status, 'Data length:', res.data.length);
    // Find text inside tweets
    const tweets = (res.data.match(/data-tweet-id="[^"]*"[^>]*>[\s\S]*?<\/article>/g) || [])
      .slice(0, 3)
      .map((t: string) => t.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    console.log('Recent tweets:', tweets);
  } catch (err: any) {
    console.log('Timeline error:', err.message);
  }
}

async function run() {
  await testTwitterSyndication('wenpcfamily');
  await testTwitterSyndication('bonk_inu');
}

run();
