import axios from 'axios';
import { spawn } from 'child_process';

async function testServer() {
  console.log('🚀 Booting Unified Server for E2E validation...');
  const server = spawn('npx', ['tsx', 'src/index.ts'], {
    shell: true,
    env: {
      ...process.env,
      PORT: '3005',
      NODE_ENV: 'test',
      TELEGRAM_BOT_TOKEN: 'dummy_bot_token',
      TELEGRAM_ENABLE_POLLING: 'false',
    },
  });

  let serverOutput = '';
  server.stdout?.on('data', (data) => {
    const text = data.toString();
    serverOutput += text;
    process.stdout.write(`[SERVER] ${text}`);
  });
  server.stderr?.on('data', (data) => {
    const text = data.toString();
    serverOutput += text;
    process.stderr.write(`[SERVER ERR] ${text}`);
  });

  // Wait 6 seconds for Fastify to bind
  await new Promise((r) => setTimeout(r, 6000));

  try {
    const baseUrl = 'http://127.0.0.1:3005';
    console.log('📡 Testing Root Terminal UI (GET /)...');
    const rootRes = await axios.get(baseUrl, { timeout: 3000 });
    console.log(`  -> Status: ${rootRes.status}, Content Length: ${rootRes.data.length} bytes`);
    if (!rootRes.data.includes('SOUL TERMINAL')) {
      throw new Error('Soul Terminal HTML title/header not found in GET /');
    }

    console.log('📡 Testing Token Terminal UI (GET /token/:mint)...');
    const tokenUiRes = await axios.get(`${baseUrl}/token/9vByBALakH19cSvaqvxAXPJHw1m2xYHC34kaR33zpump`, { timeout: 3000 });
    console.log(`  -> Status: ${tokenUiRes.status}`);

    console.log('📡 Testing Trending API (GET /api/trending)...');
    const trendingRes = await axios.get(`${baseUrl}/api/trending`, { timeout: 3000 });
    console.log(`  -> Status: ${trendingRes.status}, Found: ${trendingRes.data.candidates?.length ?? 0} candidates`);

    console.log('📡 Testing 24h Radar Stats API (GET /api/stats/24h)...');
    const statsRes = await axios.get(`${baseUrl}/api/stats/24h`, { timeout: 3000 });
    console.log(`  -> Status: ${statsRes.status}, Scanned: ${statsRes.data.scanned24h}`);

    console.log('📡 Testing Token Forensics API (GET /api/token/:mint)...');
    const tokenApiRes = await axios.get(`${baseUrl}/api/token/9vByBALakH19cSvaqvxAXPJHw1m2xYHC34kaR33zpump`, { timeout: 4000 });
    console.log(`  -> Status: ${tokenApiRes.status}, Symbol: ${tokenApiRes.data?.candidate?.tokenSymbol || 'N/A'}`);

    console.log('\n🌟 ALL E2E ENDPOINTS VALIDATED SUCCESSFULLY!');
  } finally {
    server.kill('SIGTERM');
  }
}

testServer()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ E2E Validation Failed:', err.message);
    process.exit(1);
  });
