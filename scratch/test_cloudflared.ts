import { tunnel } from 'cloudflared';

async function testCloudflared() {
  console.log('Testing cloudflared tunnel initialization...');
  try {
    const { url, connections, child, stop } = await tunnel({ '--url': 'http://localhost:3001' });
    const publicUrl = await url;
    console.log(`✅ Cloudflare Quick Tunnel Online: ${publicUrl}`);
    console.log('Stopping test tunnel...');
    await stop();
    console.log('Test complete!');
  } catch (err: any) {
    console.error('❌ Cloudflared error:', err.message);
  }
}

testCloudflared();
