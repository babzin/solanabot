import { prisma } from '../src/services/db.js';

async function main() {
  const count = await prisma.trackedWallet.count();
  console.log('Current TrackedWallet count:', count);
  const wallets = await prisma.trackedWallet.findMany({ take: 5 });
  console.log('Sample wallets:', wallets);
  const prefs = await prisma.userPreference.findMany();
  console.log('User preferences:', prefs);
  await prisma.$disconnect();
}

main().catch(console.error);
