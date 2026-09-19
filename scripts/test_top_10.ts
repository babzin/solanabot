import { prisma } from '../src/services/db.js';
import { STRATEGY_DEFINITIONS } from '../src/config/strategies.js';

async function testTop10Logic() {
  console.log('🧪 Testing Top 10 Wallets Query Logic for Safe, Risk, and All modes...\n');

  // Test SAFE query
  const safeTop10 = await prisma.trackedWallet.findMany({
    where: { isActive: true, tier: 'SAFE' },
    orderBy: [{ netSolProfit: 'desc' }, { winRate: 'desc' }, { profitFactor: 'desc' }],
    take: 10,
  });
  console.log(`🛡️ SAFE Top 10 Wallets Count: ${safeTop10.length}`);
  safeTop10.forEach((w, i) => {
    console.log(`   ${i + 1}. [${w.tier}] ${w.label} (${w.address.slice(0, 4)}...${w.address.slice(-4)}) -> +${w.netSolProfit} SOL | ${(w.winRate * 100).toFixed(0)}% WR`);
  });

  if (safeTop10.length !== 10 || safeTop10.some(w => w.tier !== 'SAFE')) {
    throw new Error('Safe Top 10 query failed!');
  }

  // Test RISK query
  console.log('\n🚀 RISK Top 10 Wallets Count:');
  const riskTop10 = await prisma.trackedWallet.findMany({
    where: { isActive: true, tier: 'RISK' },
    orderBy: [{ netSolProfit: 'desc' }, { winRate: 'desc' }, { profitFactor: 'desc' }],
    take: 10,
  });
  console.log(`   Count: ${riskTop10.length}`);
  riskTop10.forEach((w, i) => {
    console.log(`   ${i + 1}. [${w.tier}] ${w.label} (${w.address.slice(0, 4)}...${w.address.slice(-4)}) -> +${w.netSolProfit} SOL | ${(w.winRate * 100).toFixed(0)}% WR`);
  });

  if (riskTop10.length !== 10 || riskTop10.some(w => w.tier !== 'RISK')) {
    throw new Error('Risk Top 10 query failed!');
  }

  // Test ALL query
  console.log('\n🌐 ALL Tiers Top 10 Wallets Count:');
  const allTop10 = await prisma.trackedWallet.findMany({
    where: { isActive: true },
    orderBy: [{ netSolProfit: 'desc' }, { winRate: 'desc' }, { profitFactor: 'desc' }],
    take: 10,
  });
  console.log(`   Count: ${allTop10.length}`);
  allTop10.forEach((w, i) => {
    console.log(`   ${i + 1}. [${w.tier}] ${w.label} (${w.address.slice(0, 4)}...${w.address.slice(-4)}) -> +${w.netSolProfit} SOL | ${(w.winRate * 100).toFixed(0)}% WR`);
  });

  if (allTop10.length !== 10) {
    throw new Error('All Top 10 query failed!');
  }

  console.log('\n🎉 ALL TOP 10 QUERIES AND TIER FILTERING VERIFIED SUCCESSFULLY!');
}

testTop10Logic()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('❌ Failed:', err);
    await prisma.$disconnect();
    process.exit(1);
  });
