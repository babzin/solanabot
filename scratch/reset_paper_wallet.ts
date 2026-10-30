import { resetPaperTradingWallet, getPaperPortfolioSummary } from '../src/services/paperTrading.js';
import { redis } from '../src/services/redis.js';

async function main() {
  console.log('🔄 Executing Paper Trading Wallet Reset to $500.00 USD...');
  const wallet = await resetPaperTradingWallet();
  console.log('✅ Wallet Reset Complete:', {
    initialBalanceUsd: wallet.initialBalanceUsd,
    liquidCashUsd: wallet.liquidCashUsd,
    liquidCashSol: wallet.liquidCashSol,
    solPriceUsd: wallet.solPriceUsd,
    totalInvestedUsd: wallet.totalInvestedUsd,
    totalTrades: wallet.totalTrades,
  });

  const summary = await getPaperPortfolioSummary();
  console.log('📊 Portfolio Summary Verified:', {
    netWorthUsd: summary.netWorthUsd,
    totalPnlUsd: summary.totalPnlUsd,
    activePositions: summary.activePositions.length,
  });

  redis.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Error resetting paper wallet:', err);
  process.exit(1);
});
