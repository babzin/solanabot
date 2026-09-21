import axios from 'axios';
import { env } from '../src/config/env.js';
import { prisma } from '../src/services/db.js';

async function diagnose() {
  console.log('=== 🔍 DIAGNOSING WEBHOOK & WALLET PIPELINE ===');

  // 1. Check DB Active Wallets
  const activeWallets = await prisma.trackedWallet.findMany({
    where: { isActive: true },
    select: { address: true, label: true, tier: true, winRate: true, lastScoredAt: true },
  });
  console.log(`1. Active Wallets in Database: ${activeWallets.length}`);
  if (activeWallets.length > 0) {
    console.log('Sample wallets:', activeWallets.slice(0, 3));
  }

  // 2. Check Helius Webhook Configuration
  console.log('\n2. Checking Helius Webhook on Helius Servers...');
  try {
    const res = await axios.get(
      `https://api.helius.xyz/v0/webhooks/${env.HELIUS_WEBHOOK_ID}?api-key=${env.HELIUS_API_KEY}`
    );
    const wh = res.data;
    console.log(`Webhook ID: ${wh.webhookID}`);
    console.log(`Webhook URL: ${wh.webhookURL}`);
    console.log(`Transaction Types: ${JSON.stringify(wh.transactionTypes)}`);
    console.log(`Webhook Type: ${wh.webhookType}`);
    console.log(`Total Account Addresses registered: ${wh.accountAddresses?.length || 0}`);

    // Check if the Webhook URL is accessible
    console.log('\n3. Testing Webhook URL reachability...');
    try {
      const ping = await axios.post(
        wh.webhookURL,
        [],
        {
          headers: {
            Authorization: `Bearer ${env.WEBHOOK_AUTH_TOKEN}`,
            'Content-Type': 'application/json',
          },
          timeout: 8000,
        }
      );
      console.log(`Webhook ping response: status ${ping.status} - OK`);
    } catch (pingErr: any) {
      console.error(`❌ Webhook URL ping failed: ${pingErr.message}`);
      if (pingErr.response) {
        console.error(`Status: ${pingErr.response.status}, Data:`, pingErr.response.data);
      }
    }

    // 4. Check whether these active wallets actually executed transactions in the last 2 hours
    console.log('\n4. Checking on-chain recent activity for top 5 active wallets...');
    for (const w of activeWallets.slice(0, 5)) {
      try {
        const txRes = await axios.get(
          `https://api.helius.xyz/v0/addresses/${w.address}/transactions?api-key=${env.HELIUS_API_KEY}&limit=3`
        );
        const txs = txRes.data;
        console.log(`\nWallet ${w.label} (${w.address.slice(0, 8)}...): ${txs.length} recent txs`);
        for (const tx of txs) {
          const txTime = new Date(tx.timestamp * 1000).toISOString();
          const minutesAgo = Math.round((Date.now() - tx.timestamp * 1000) / 60000);
          console.log(`  - Type: ${tx.type}, Source: ${tx.source}, Description: ${tx.description?.slice(0, 60)} (${minutesAgo} mins ago, ${txTime})`);
        }
      } catch (err: any) {
        console.error(`Error checking wallet ${w.address}: ${err.message}`);
      }
    }
  } catch (err: any) {
    console.error('Error fetching Helius webhook:', err.message);
  }

  await prisma.$disconnect();
}

diagnose();
