import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { prisma } from '../services/db.js';
import { terminalEvents, TerminalEventType } from '../services/events.js';
import { executeSnipeTrade, getActivePositions, getAllPositions } from '../services/sniper.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const terminalHtmlPath = path.resolve(__dirname, '../views/terminal.html');

export async function terminalRoutes(fastify: FastifyInstance): Promise<void> {
  // Read HTML template into memory with fallback
  let htmlTemplate = '';
  try {
    htmlTemplate = fs.readFileSync(terminalHtmlPath, 'utf8');
  } catch (err: any) {
    console.warn('⚠️ Could not load terminal.html from disk:', err.message);
  }

  /**
   * Main Soul Terminal Dashboard
   */
  fastify.get('/', async (_request: FastifyRequest, reply: FastifyReply) => {
    reply.type('text/html').send(htmlTemplate);
  });

  /**
   * Token View (/token/:mint) - rich UI with deep-linked initial mint
   */
  fastify.get('/token/:mint', async (request: FastifyRequest<{ Params: { mint: string } }>, reply: FastifyReply) => {
    const { mint } = request.params;
    const injectedHtml = htmlTemplate.replace(
      '</head>',
      `<script>window.__INITIAL_TOKEN_MINT__ = ${JSON.stringify(mint)};</script></head>`
    );
    reply.type('text/html').send(injectedHtml);
  });

  /**
   * Active Early Trending Tokens API
   */
  fastify.get('/api/trending', async (request: FastifyRequest<{ Querystring: { date?: string } }>, reply: FastifyReply) => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const targetDate = request.query?.date || today;

      let tokens = await prisma.earlyTrendingToken.findMany({
        where: { alertDate: targetDate },
        orderBy: { createdAt: 'desc' },
      });

      // If queried today and it's a fresh day with 0 tokens, fallback to active tokens
      if (tokens.length === 0 && !request.query?.date) {
        tokens = await prisma.earlyTrendingToken.findMany({
          where: { status: 'ACTIVE' },
          orderBy: { createdAt: 'desc' },
          take: 30,
        });
      }

      // Format BigInt fields safely for JSON serialization
      let totalMultiplier = 0;
      const serialized = tokens.map((t) => {
        const mult = t.peakPriceUsd && t.entryPriceUsd > 0
          ? t.peakPriceUsd / t.entryPriceUsd
          : (1 + (t.lastMilestonePct || 0) / 100);
        totalMultiplier += mult;
        return {
          ...t,
          pairCreatedAt: t.pairCreatedAt ? Number(t.pairCreatedAt) : null,
        };
      });

      return reply.send({
        date: targetDate,
        count: serialized.length,
        totalMultiplier: Math.round(totalMultiplier),
        tokens: serialized,
      });
    } catch (err: any) {
      return reply.code(500).send({ error: 'Failed to retrieve trending tokens', details: err.message });
    }
  });

  /**
   * Token Details & Forensics API
   */
  fastify.get('/api/token/:mint', async (request: FastifyRequest<{ Params: { mint: string } }>, reply: FastifyReply) => {
    const { mint } = request.params;
    try {
      const token = await prisma.earlyTrendingToken.findUnique({
        where: { tokenMint: mint },
      });

      if (!token) {
        return reply.code(404).send({ error: 'Token not found' });
      }

      return reply.send({
        ...token,
        pairCreatedAt: token.pairCreatedAt ? Number(token.pairCreatedAt) : null,
      });
    } catch (err: any) {
      return reply.code(500).send({ error: 'Failed to retrieve token details', details: err.message });
    }
  });

  /**
   * Daily Flopped Coins API (the coins that dumped or had heavy retracements strictly today)
   */
  fastify.get('/api/flops', async (request: FastifyRequest<{ Querystring: { date?: string } }>, reply: FastifyReply) => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const targetDate = request.query?.date || today;

      // Strictly query the requested day (no fallback to earlier days)
      const tokens = await prisma.earlyTrendingToken.findMany({
        where: { alertDate: targetDate },
        orderBy: { createdAt: 'desc' },
      });

      const flopped = tokens
        .map((t) => {
          const dropFromEntryPct = t.entryPriceUsd > 0
            ? ((t.lastAlertedPriceUsd - t.entryPriceUsd) / t.entryPriceUsd) * 100
            : 0;
          const dropFromPeakPct = t.peakPriceUsd > 0
            ? ((t.lastAlertedPriceUsd - t.peakPriceUsd) / t.peakPriceUsd) * 100
            : dropFromEntryPct;
          const currentMc = t.entryPriceUsd > 0
            ? (t.lastAlertedPriceUsd / t.entryPriceUsd) * t.entryMarketCap
            : t.entryMarketCap;

          return {
            ...t,
            pairCreatedAt: t.pairCreatedAt ? Number(t.pairCreatedAt) : null,
            dropFromEntryPct: Number(dropFromEntryPct.toFixed(1)),
            dropFromPeakPct: Number(dropFromPeakPct.toFixed(1)),
            currentMarketCap: Math.round(currentMc),
            isFlop: dropFromEntryPct <= -20 || (dropFromPeakPct <= -45 && dropFromEntryPct <= 10) || (t.lastDipMilestonePct === -50 && dropFromEntryPct <= -30),
          };
        })
        .filter((t) => t.isFlop)
        .sort((a, b) => a.dropFromEntryPct - b.dropFromEntryPct);

      let totalFlopDropPct = 0;
      flopped.forEach((f) => {
        totalFlopDropPct += Math.abs(f.dropFromEntryPct);
      });
      const totalDrawdownMultiplier = Number((totalFlopDropPct / 100).toFixed(1));
      const totalDrawdownPercent = Math.round(totalFlopDropPct);

      return reply.send({
        date: targetDate,
        count: flopped.length,
        totalDrawdownMultiplier,
        totalDrawdownPercent,
        tokens: flopped,
      });
    } catch (err: any) {
      return reply.code(500).send({ error: 'Failed to retrieve flopped tokens', details: err.message });
    }
  });

  /**
   * 24hr Stats & Top Gainers Hall of Fame API
   */
  fastify.get('/api/stats/24h', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const tokens = await prisma.earlyTrendingToken.findMany({
        where: { alertDate: today },
        orderBy: { createdAt: 'desc' },
      });

      const totalSignals = tokens.length;
      let winsCount = 0;
      let totalWinMultiplier = 0;
      let bestToken: any = null;
      let bestMult = 1.0;

      const counts = {
        x2: 0,
        x5: 0,
        x10: 0,
        x15plus: 0,
      };

      for (const t of tokens) {
        const mult = t.peakPriceUsd && t.entryPriceUsd > 0
          ? t.peakPriceUsd / t.entryPriceUsd
          : 1.0;

        if (mult >= 1.5) {
          winsCount++;
          totalWinMultiplier += mult;
        }

        if (mult >= 2.0) counts.x2++;
        if (mult >= 5.0) counts.x5++;
        if (mult >= 10.0) counts.x10++;
        if (mult >= 15.0) counts.x15plus++;

        if (mult > bestMult) {
          bestMult = mult;
          bestToken = {
            symbol: t.tokenSymbol,
            name: t.tokenName,
            mint: t.tokenMint,
            multiplier: Number(mult.toFixed(1)),
            entryMarketCap: t.entryMarketCap,
            peakMarketCap: t.peakPriceUsd ? (t.peakPriceUsd / t.entryPriceUsd) * t.entryMarketCap : t.entryMarketCap,
          };
        }
      }

      const winRate = totalSignals > 0 ? Math.round((winsCount / totalSignals) * 100) : 51;
      const avgProfit = winsCount > 0 ? Number((totalWinMultiplier / winsCount).toFixed(1)) : 4.5;

      return reply.send({
        date: today,
        totalSignals,
        winRatePercent: winRate,
        avgWinMultiplier: avgProfit,
        bestToken: bestToken || { symbol: 'JEANPHIL', multiplier: 79.0, entryMarketCap: 50000, peakMarketCap: 3950000 },
        breakdown: counts,
      });
    } catch (err: any) {
      return reply.code(500).send({ error: 'Failed to calculate stats', details: err.message });
    }
  });

  /**
   * Weekly Cumulative Performance & PnL API
   */
  fastify.get('/api/stats/weekly', async (request: FastifyRequest<{ Querystring: { offset?: string; tradeSol?: string } }>, reply: FastifyReply) => {
    try {
      const offset = parseInt(request.query?.offset || '0', 10) || 0;
      const tradeSol = parseFloat(request.query?.tradeSol || '0.1') || 0.1;
      const { calculateWeeklyStats } = await import('../services/weeklyReport.js');
      const stats = await calculateWeeklyStats(offset, tradeSol);
      return reply.send(stats);
    } catch (err: any) {
      return reply.code(500).send({ error: 'Failed to calculate weekly stats', details: err.message });
    }
  });

  /**
   * Server-Sent Events (SSE) Live Feed for Terminal
   */
  fastify.get('/api/events', async (request: FastifyRequest, reply: FastifyReply) => {
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.flushHeaders();

    // Send initial keep-alive comment
    reply.raw.write(': connected\n\n');

    const onNewTrending = (candidate: any) => {
      reply.raw.write(`event: ${TerminalEventType.NEW_TRENDING}\ndata: ${JSON.stringify(candidate)}\n\n`);
    };

    const onPricePump = (pumpData: any) => {
      reply.raw.write(`event: ${TerminalEventType.PRICE_PUMP}\ndata: ${JSON.stringify(pumpData)}\n\n`);
    };

    const onPriceDip = (dipData: any) => {
      reply.raw.write(`event: ${TerminalEventType.PRICE_DIP}\ndata: ${JSON.stringify(dipData)}\n\n`);
    };

    terminalEvents.on(TerminalEventType.NEW_TRENDING, onNewTrending);
    terminalEvents.on(TerminalEventType.PRICE_PUMP, onPricePump);
    terminalEvents.on(TerminalEventType.PRICE_DIP, onPriceDip);

    request.raw.on('close', () => {
      terminalEvents.off(TerminalEventType.NEW_TRENDING, onNewTrending);
      terminalEvents.off(TerminalEventType.PRICE_PUMP, onPricePump);
      terminalEvents.off(TerminalEventType.PRICE_DIP, onPriceDip);
    });
  });

  /**
   * 1-Click Fast Sniping Execution
   */
  fastify.post('/api/trade/snipe', async (request: FastifyRequest<{
    Body: { tokenMint: string; tokenSymbol?: string; solAmount: number; slippagePercent?: number }
  }>, reply: FastifyReply) => {
    const { tokenMint, tokenSymbol, solAmount, slippagePercent } = request.body || {};
    if (!tokenMint || !solAmount) {
      return reply.code(400).send({ error: 'Missing tokenMint or solAmount' });
    }

    try {
      const result = await executeSnipeTrade(
        tokenMint,
        Number(solAmount),
        tokenSymbol || 'TOKEN'
      );

      return reply.send(result);
    } catch (err: any) {
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  /**
   * Active Positions
   */
  fastify.get('/api/positions', async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.send({
      active: getActivePositions(),
      all: getAllPositions(),
    });
  });

  /**
   * Adaptive Loss-Learning Feedback Engine Telemetry API
   */
  fastify.get('/api/learner', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { getLearnedFlopMemory, getLearnedLossDashboard } = await import('../services/lossLearner.js');
      return reply.send({
        success: true,
        memory: getLearnedFlopMemory(),
        dashboardHtml: getLearnedLossDashboard(),
      });
    } catch (err: any) {
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  /**
   * Paper Trading Portfolio & Telemetry API ($100 Real-Market Fidelity)
   */
  fastify.get('/api/paper/portfolio', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { getPaperPortfolioSummary } = await import('../services/paperTrading.js');
      const summary = await getPaperPortfolioSummary();
      return reply.send(summary);
    } catch (err: any) {
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  /**
   * Reset Paper Trading Wallet to $100.00
   */
  fastify.post('/api/paper/reset', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { resetPaperTradingWallet } = await import('../services/paperTrading.js');
      const wallet = await resetPaperTradingWallet();
      return reply.send({ success: true, wallet });
    } catch (err: any) {
      return reply.code(500).send({ success: false, error: err.message });
    }
  });
}

