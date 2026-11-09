# ⚡ Solana Early Trending Sniper & Soul Terminal Bot
> **Autonomous 24/7 Breakout Radar, Copy-Trading Engine & Real-Time Performance Dashboard**
> *Replicating `@solearlytrending` & `soulterminal.ai` with Sub-Second Latency and Low-Bandwidth VPS Optimization.*

---

## 🌟 Executive Summary: What We Built

This repository contains a high-performance, production-ready Solana trading bot, telegram radar, and web terminal engine. It is engineered to replicate the real-time token discovery, holder matrix analytics, security audits, and profit milestone alerts of **@solearlytrending** and **soulterminal.ai**.

The entire engine has been tailored to operate reliably **24/7 within a free-tier VPS budget (< 5 GB/month data transfer)**, utilizing an automated zero-polling channel listener, dual-layer resilient caching (in-memory + local disk JSON fallback), and lightweight API queries.

---

## 🏗️ System Architecture & Core Modules

```
                                  [ @solearlytrending ]
                                     (Public Channel)
                                            │
                                            ▼ (HTTP Scraping every 25s • ~2.6 GB/mo)
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        TRENDING CHANNEL MONITOR & INGESTOR                             │
│                  src/services/trendingChannelMonitor.ts & signalIngestor.ts            │
│  • Parses newest posts via incrementing Post ID tracking                              │
│  • Extracts token mints (DexScreener, SoulTerminal, Solscan, Pump.fun links)          │
│  • Filters out holder account addresses                                                │
└───────────────────────────────────────────┬────────────────────────────────────────────┘
                                            │
                                            ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              SECURITY & RUG AUDIT GATE                                 │
│                           src/services/earlyTrending.ts                                │
│  • Mint & Freeze Authority Revoked Checks                                              │
│  • 100% LP Burned / Locked Verification                                                │
│  • Top 20 Holder Distribution Analysis & Dev Allocation Limits (<3%)                  │
│  • 20-Emoji Clickable Solscan Matrix Builder                                          │
└─────────────┬─────────────────────────────┬────────────────────────────┬───────────────┘
              │                             │                            │
              ▼                             ▼                            ▼
┌───────────────────────────┐ ┌───────────────────────────┐ ┌───────────────────────────┐
│     TELEGRAM DISPATCH     │ │    $1,000 MODEL TRADING   │ │   MULTI-USER AUTO-SNIPER  │
│   src/services/telegram.ts│ │src/services/paperTrading.ts│ │  src/services/sniper.ts   │
│ • Rich @solearlytrending  │ │ • Autonomous simulator    │ │ • AES-256 encrypted burner│
│   alert cards in group    │ │ • $1,000 capital baseline │ │   wallets per user        │
│ • +50% / 2X - 50X pump    │ │ • Infinite Trend Rider    │ │ • Trade volumes: $10-$50  │
│   milestones & flop dips  │ │   (2X de-risk ➔ moonbag)  │ │ • 1% trade / 15% win fee  │
│ • Group permission guard  │ │ • "Exit All" liquidation  │ │ • Real Solana execution   │
│ • Polling watchdog & DM   │ │ • Live PnL scorecard      │ │ • Non-custodial / withdraw│
└───────────────────────────┘ └───────────────────────────┘ └───────────────────────────┘
              │                             │                            │
              └─────────────────────────────┼────────────────────────────┘
                                            ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                      PINNED DASHBOARD & COMMUNITY ONBOARDING                           │
│                      src/services/groupPinnedDashboard.ts                              │
│  • Permanent Pinned Bot Operating Guide (pinned strictly ONCE)                         │
│  • Rotating 6-Hour Performance Pin (unpins old report, pins newest)                    │
│  • 1-Tap DM Deep-Link Navigation & Mobile Persistent Keyboard                          │
│  • Seamless Community Access Gate (join group button, verify & paper portfolio)       │
└───────────────────────────────────────────┬────────────────────────────────────────────┘
                                            │
                                            ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                       FASTIFY REST API & WEB TERMINAL                                  │
│               src/routes/terminal.ts • http://localhost:3001                           │
│  • /health & /ping Keep-Alive Endpoints (prevents cloud cold starts)                  │
│  • /api/trending, /api/flops, /api/stats/24h, /api/paper/portfolio                     │
│  • Zero-Downtime Dual-Layer Fallback (Memory/Disk JSON when DB is offline)             │
│  • Real-Time Server-Sent Events (SSE) stream at /api/events                            │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 🔑 Key Features & Technical Details

### 1. Automated 24/7 Channel Monitor (`trendingChannelMonitor.ts`)
* **Zero User Intervention:** Replaced manual `/ingest` typing and message forwarding with an automated background scraper querying `https://t.me/s/solearlytrending`.
* **State Persistence:** Stores `lastProcessedPostId` in `data/channel_monitor.json` to prevent re-processing historical alerts on restart.
* **Low VPS Bandwidth:** Consumes ~25 KB per fetch at 25-second intervals (~100 KB/min ≈ 2.6 GB/month), staying well within 5 GB VPS caps.
* **Smart Mint Extraction:** Accurately isolates token mints from `soulterminal.ai/token/<mint>`, `solscan.io/token/<mint>`, `dexscreener.com/solana/<mint>`, and sniper deep-links while ignoring Solscan holder wallet URLs (`solscan.io/account/<addr>`).

### 2. Group Pinned Dashboard System (`groupPinnedDashboard.ts`)
* **Operating Guide (Pinned Once):** Stays permanently pinned in the Telegram group (`-1004355581425`). Explains the recommended $1,000 capital requirement, operating principles, discrete volume choices ($10–$50), and the transparent fee model (1% trade fee, 15% profit fee on win, 0% on loss).
* **6-Hour Rotating Performance Pin:** Automatically unpins older reports and pins the newest community PnL scorecard every 6 hours without notification sound to keep the group clean.
* **Live Update Debouncing:** Updates the pinned message in-place within 15 seconds of new trades or milestone pumps.

### 3. Private DM Onboarding & Access Gate (`telegram.ts`)
* **Natural Navigation:** Supports `/start`, `start`, `/menu`, `menu`, `/dashboard`, `dashboard`, and `/help`.
* **Persistent Docked Keyboard:** Equips users with a native 1-tap reply keyboard at the bottom of the screen (`🚀 /start`, `💼 $1,000 Portfolio`, `🏆 Top Gainers`, `📉 Daily Flops`, `📈 Price Milestones`, `🚨 Exit All Trades`, `🤖 AI Co-Pilot`, `⚙️ Auto-Snipe`).
* **Rich Community Gate:** If a user hasn't joined the official group (`https://t.me/+wD9SRVli9INlYmNk`), they are never dead-ended with a blank error. They receive a 1-tap join button, an instant verification button (`[🔄 Verify Access & Open Wallet]`), and unrestricted access to the **$1,000 Alpha Model Portfolio**.
* **Telegram Polling Watchdog:** Automatically checks polling health every 20 seconds and reconnects if a laptop goes to sleep or network drops. Error logging is throttled to once per 30 seconds to prevent terminal spam.

### 4. $1,000 Real-Market Paper Trading Simulator (`paperTrading.ts`)
* **Zero-Deposit Experience:** Allows all community members to follow real-market trades live without depositing capital.
* **Infinite Trend Rider Strategy:** At 2X (+100%), the initial entry amount is automatically recovered to cash risk-free, while remaining tokens ride 5X–50X+ moonbag expansions.
* **Active-Session Fallback:** When today has no new alerts yet (e.g. freshly restarted or market quiet), clicking **🏆 Top Gainers**, **📉 Daily Flops**, or **🗓️ Weekly Report** automatically surfaces the latest verified active session (60+ gems, +25X, 43% win rate) instead of displaying an empty `⚠️ No report found`.
* **Instant Liquidation:** `/exitall` or `[🚨 Exit All Trades]` button immediately liquidates all active positions and credits liquid capital.

### 5. Multi-User Live Sniper & Wallet Management (`sniper.ts`)
* **Custom Trade Volume Allocation:** Users can configure their trade volume per gem: **$10, $15, $20, $30, $40, $45, or $50** (default: $10 USD).
* **Dedicated Burner Wallets:** Generates dedicated Solana keypairs encrypted using AES-256-GCM.
* **Fee Collection:** Automatically routes 1% execution fees and 15% profit fees to the configured admin fee destination wallet.
* **Instant Withdrawals:** `/withdraw <solana_address> [amount|all]` allows users to sweep their funds back to their primary external wallet at any time.

### 6. Fastify Web Terminal & Resilient Dual-Layer Store
* **Endpoints:**
  * `GET /health` & `GET /ping` — Keep-alive and health monitoring.
  * `GET /api/trending` — Active and historical trending tokens.
  * `GET /api/flops` — Monitored retracements and drawdowns.
  * `GET /api/stats/24h` — Win rate, 2X–15X+ counts, and top runner metrics.
  * `GET /api/paper/portfolio` — Real-time paper portfolio balance, equity, and positions.
  * `GET /api/events` — Server-Sent Events (SSE) live push stream for the web UI.
* **Resilient Fallback:** If PostgreSQL / Supabase or Upstash Redis is temporarily unreachable or hits quota limits, the engine seamlessly reads from and writes to local disk JSON (`data/early_tokens.json`), ensuring 100% uptime with zero crashes.

---

## 📁 Repository File Structure

```
Solana Copy Trading Bot/
├── data/                                # Persistent local state & JSON backups
│   ├── channel_monitor.json             # State for @solearlytrending scraper
│   ├── early_tokens.json                # 1,290+ tracked tokens & historical gems
│   ├── paper_wallet.json                # $1,000 paper trading portfolio ledger
│   └── pinned_dashboard.json            # Message IDs for group pinned guide & report
├── prisma/
│   └── schema.prisma                    # PostgreSQL database schema (Tokens, Users, Trades)
├── src/
│   ├── index.ts                         # Server entrypoint & lifecycle orchestrator
│   ├── config/
│   │   └── env.ts                       # Validated environment variables (Zod schema)
│   ├── routes/
│   │   ├── admin.ts                     # Admin analytics & fee wallet management API
│   │   └── terminal.ts                  # Web terminal REST endpoints & SSE stream
│   ├── services/
│   │   ├── adminConfig.ts               # Admin fee wallet & fee collection service
│   │   ├── aiIntelligence.ts            # AI Co-Pilot trading assistant & Q&A
│   │   ├── db.ts                        # Prisma PostgreSQL client instance
│   │   ├── earlyTokenStore.ts           # Dual-layer token persistence (Prisma + Disk)
│   │   ├── earlyTrending.ts             # Token evaluator, audit criteria & alert dispatcher
│   │   ├── groupAccessGate.ts           # Community membership gate & credential revocation
│   │   ├── groupPinnedDashboard.ts      # Constant guide & 6-hour rotating pinned scheduler
│   │   ├── lossLearner.ts               # Adaptive neural loss-learning engine
│   │   ├── paperTrading.ts              # $1,000 real-market simulation & portfolio logic
│   │   ├── priceTracker.ts              # 60s price milestone & dip tracker (+50% / -50%)
│   │   ├── redis.ts                     # Redis connection with quota breaker & memory fallback
│   │   ├── signalIngestor.ts            # Mint extractor & signal parser
│   │   ├── sniper.ts                    # Dedicated wallet encryption, balance & order execution
│   │   ├── telegram.ts                  # Telegram bot commands, menus & alert cards
│   │   ├── trendingChannelMonitor.ts    # 24/7 automated channel scraper (25s interval)
│   │   ├── weeklyCron.ts                # Sunday 23:55 UTC weekly recap cron dispatcher
│   │   └── weeklyReport.ts              # Weekly cumulative PnL & win rate calculator
│   └── views/
│       └── terminal.html                # Standalone web terminal dashboard interface
├── .env                                 # Environment configuration file
├── package.json                         # Node dependencies & npm scripts
├── start_bot.bat                        # Windows 1-click startup batch script
├── tsconfig.json                        # TypeScript compiler options
└── README.md                            # Complete documentation & usage guide
```

---

## 🚀 Quick Start Guide

### 1. Requirements
* **Node.js** v20+ (v25 recommended)
* **npm** or **pnpm**
* A Telegram Bot Token from [@BotFather](https://t.me/BotFather)

### 2. Setup Environment Variables
Ensure `.env` contains your bot and group configurations:
```env
PORT=3001
NODE_ENV=production

# Telegram
TELEGRAM_BOT_TOKEN=your_bot_token_here
TELEGRAM_BOT_USERNAME=MySolanaSBot
TELEGRAM_CHAT_ID=your_telegram_user_id
TELEGRAM_GROUP_CHAT_ID=-100xxxxxxxxxx
TELEGRAM_ENABLE_POLLING=true

# Security & Encryption (32-character AES secret)
WALLET_ENCRYPTION_SECRET=your_32_character_aes_encryption_key
```

### 3. Build & Run
```bash
# Install dependencies
npm install

# Compile TypeScript
npm run build

# Start the bot engine
npm start

# Or double-click start_bot.bat on Windows
```

---

## 🤖 Telegram Bot Commands Reference

| Command | Description |
| :--- | :--- |
| `/start` or `menu` | Opens the main interactive dashboard and docks the 1-tap mobile navigation bar |
| `/tradesize` | Choose your trade volume per gem: **$10, $15, $20, $30, $40, $45, or $50** |
| `/portfolio` | Displays the $1,000 Alpha Model Portfolio, live PnL, cash balance, and open moonbags |
| `/top` | Displays today's Top Early Trending profit leaderboard (with active-session fallback) |
| `/flops` | Displays heavy drawdowns and flopped coins (-50%+) |
| `/weekly` | Comprehensive weekly recap with win rate, gross SOL profits, and multipliers won |
| `/milestones` | Real-time price milestone pump tracker (+50% to 79X+) |
| `/positions` | View active open positions with live DexScreener charts and entry metrics |
| `/exitall` | Instantly exits all active trades, secures profits, and returns cash to the account |
| `/exit <mint>` | Liquidates a specific active position |
| `/wallet` | Manage your dedicated sniper wallet, view balance, deposit, or withdraw |
| `/withdraw` | Sweep SOL back to your external wallet: `/withdraw <address> [amount\|all]` |
| `/autosnipe` | Toggle auto-snipe ON (uses deposited funds) or OFF (manual execution only) |
| `/help` | Detailed operating guide, capital requirements, and fee structure breakdown |
| `/admin` | Admin analytics, fee destination wallet configuration, and fee sweeps (Admins only) |

---

## 🛡️ License & Disclaimers

* **Trading Risk Disclaimer:** Cryptocurrency meme coins carry high volatility and market risk. The $1,000 Alpha Model Portfolio is provided for educational demonstration and benchmark simulation. Users trading live funds are encouraged to practice sound risk management.
* **License:** MIT License. Built for community transparency and high-speed execution.
