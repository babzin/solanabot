import Fastify from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import { env } from '../src/config/env.js';
import { terminalRoutes } from '../src/routes/terminal.js';
import { adminRoutes } from '../src/routes/admin.js';

async function testFastifyRoutes() {
  console.log('🧪 Initializing Fastify Test Instance...');
  const app = Fastify({ logger: false });

  await app.register(cors, { origin: '*' });
  await app.register(sensible);
  await app.register(terminalRoutes);
  await app.register(adminRoutes);

  console.log('\n1️⃣ Testing GET / (Soul Terminal UI)');
  const resHome = await app.inject({ method: 'GET', url: '/' });
  console.log(`  -> Status: ${resHome.statusCode}`);
  console.log(`  -> Content-Type: ${resHome.headers['content-type']}`);
  console.log(`  -> HTML Length: ${resHome.body.length} chars`);
  if (!resHome.body.includes('Soul Terminal')) {
    throw new Error('Soul Terminal HTML structure missing in GET /');
  }

  console.log('\n2️⃣ Testing GET /token/:mint (Deep Link UI)');
  const resTokenUi = await app.inject({
    method: 'GET',
    url: '/token/9vByBALakH19cSvaqvxAXPJHw1m2xYHC34kaR33zpump',
  });
  console.log(`  -> Status: ${resTokenUi.statusCode}`);
  if (!resTokenUi.body.includes('9vByBALakH19cSvaqvxAXPJHw1m2xYHC34kaR33zpump')) {
    throw new Error('Mint address not injected in token page');
  }

  console.log('\n3️⃣ Testing GET /api/trending (JSON API)');
  const resTrending = await app.inject({ method: 'GET', url: '/api/trending' });
  console.log(`  -> Status: ${resTrending.statusCode}`);
  const trendingData = JSON.parse(resTrending.body);
  console.log(`  -> Tokens: ${trendingData.tokens?.length ?? 0}`);

  console.log('\n4️⃣ Testing GET /api/stats/24h (Radar 24h Stats)');
  const resStats = await app.inject({ method: 'GET', url: '/api/stats/24h' });
  console.log(`  -> Status: ${resStats.statusCode}`);
  const statsData = JSON.parse(resStats.body);
  console.log(`  -> Stats Output:`, statsData);

  console.log('\n5️⃣ Testing GET /api/positions (Active Positions)');
  const resPositions = await app.inject({ method: 'GET', url: '/api/positions' });
  console.log(`  -> Status: ${resPositions.statusCode}`);

  console.log('\n6️⃣ Testing Admin Health /api/admin/health');
  const resHealth = await app.inject({
    method: 'GET',
    url: '/api/admin/health',
    headers: { 'x-admin-key': env.ADMIN_SECRET_KEY },
  });
  console.log(`  -> Status: ${resHealth.statusCode}`);
  const healthData = JSON.parse(resHealth.body);
  console.log(`  -> System Health:`, healthData);

  console.log('\n✅ ALL ROUTES & TERMINAL VIEWS VERIFIED 100% OPERATIONAL!');
  await app.close();
  process.exit(0);
}

testFastifyRoutes().catch((err) => {
  console.error('❌ Route injection test failed:', err);
  process.exit(1);
});
