import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { extractSolanaMints, isSolearlytrendingSignature } from './signalIngestor.js';
import { processSingleTrendingToken } from './earlyTrending.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, '../../data');
const STATE_FILE = path.join(DATA_DIR, 'channel_monitor.json');

interface MonitorState {
  lastProcessedPostId: number;
  lastCheckTimeMs: number;
  totalSignalsCaptured: number;
}

let state: MonitorState = {
  lastProcessedPostId: 0,
  lastCheckTimeMs: 0,
  totalSignalsCaptured: 0,
};

// Load persisted state
try {
  if (fs.existsSync(STATE_FILE)) {
    const raw = fs.readFileSync(STATE_FILE, 'utf-8');
    state = { ...state, ...JSON.parse(raw) };
  }
} catch (err: any) {
  console.warn('⚠️ [Channel Monitor] Could not load channel_monitor.json:', err.message);
}

function persistState(): void {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch (err: any) {
    console.warn('⚠️ [Channel Monitor] Could not save channel_monitor.json:', err.message);
  }
}

let monitorIntervalTimer: NodeJS.Timeout | null = null;
let isChecking = false;
let lastErrorLogTime = 0;

/**
 * Polls the public Telegram channel web preview: https://t.me/s/solearlytrending
 * Bandwidth footprint: ~25 KB per fetch = ~2.6 GB/month at 25s intervals (fits easily in 5 GB VPS).
 */
export async function checkSolearlytrendingChannel(): Promise<void> {
  if (isChecking) return;
  isChecking = true;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    const response = await fetch('https://t.me/s/solearlytrending', {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const html = await response.text();
    state.lastCheckTimeMs = Date.now();

    // Parse message wraps: class="tgme_widget_message_wrap ...
    const parts = html.split('class="tgme_widget_message_wrap');
    if (parts.length <= 1) {
      isChecking = false;
      return;
    }

    const posts: Array<{ postId: number; text: string; fullContent: string }> = [];

    for (let i = 1; i < parts.length; i++) {
      const part = parts[i];
      const postIdMatch = part.match(/data-post="solearlytrending\/(\d+)"/);
      if (!postIdMatch) continue;
      const postId = parseInt(postIdMatch[1], 10);
      if (!postId || isNaN(postId)) continue;

      const textMatch = part.match(/class="[^"]*tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
      const text = textMatch ? textMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
      const links = [...part.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
      const fullContent = `${text}\n${links.join('\n')}`;

      posts.push({ postId, text, fullContent });
    }

    // Sort ascending by postId so messages are processed in chronological order
    posts.sort((a, b) => a.postId - b.postId);

    // Initial setup: If state.lastProcessedPostId is uninitialized (0),
    // set it to the highest post ID in the channel so we don't spam 20 historical alerts
    if (state.lastProcessedPostId === 0 && posts.length > 0) {
      const highestId = posts[posts.length - 1].postId;
      state.lastProcessedPostId = highestId;
      persistState();
      console.log(`📡 [Channel Monitor] Initialized baseline at latest post #${highestId}. Watching for live updates...`);
      isChecking = false;
      return;
    }

    // Process any posts newer than lastProcessedPostId
    const newPosts = posts.filter((p) => p.postId > state.lastProcessedPostId);

    for (const post of newPosts) {
      state.lastProcessedPostId = Math.max(state.lastProcessedPostId, post.postId);
      persistState();

      const isEntry = post.text.includes('New Trending') || isSolearlytrendingSignature(post.fullContent);

      if (isEntry) {
        console.log(`🔥 [Channel Monitor] Incoming @solearlytrending alert detected in post #${post.postId}! Ingesting...`);
        const mints = extractSolanaMints(post.fullContent);

        if (mints.length > 0) {
          for (const mint of mints) {
            try {
              const res = await processSingleTrendingToken(mint);
              if (res.success) {
                state.totalSignalsCaptured++;
                persistState();
                console.log(`✅ [Channel Monitor] Token $${res.candidate?.tokenSymbol || mint} auto-ingested & sniped successfully!`);
              }
            } catch (err: any) {
              console.warn(`⚠️ [Channel Monitor] Ingest error for ${mint}:`, err.message);
            }
          }
        }
      } else if (/is up \d+(\.\d+)?X/i.test(post.text) || /is up \d+%/i.test(post.text)) {
        console.log(`📈 [Channel Monitor] @solearlytrending milestone in post #${post.postId}: ${post.text.slice(0, 80)}`);
      }
    }
  } catch (err: any) {
    const now = Date.now();
    if (now - lastErrorLogTime > 60000) {
      lastErrorLogTime = now;
      console.warn(`⚠️ [Channel Monitor] Check notice: ${err.message}`);
    }
  } finally {
    isChecking = false;
  }
}

/**
 * Starts the automated 25-second background channel monitor.
 */
export function initTrendingChannelMonitor(): void {
  if (monitorIntervalTimer) {
    clearInterval(monitorIntervalTimer);
  }

  // Initial check after 3 seconds
  setTimeout(() => {
    checkSolearlytrendingChannel().catch(() => {});
  }, 3000);

  // Recurring 25-second polling loop
  monitorIntervalTimer = setInterval(() => {
    checkSolearlytrendingChannel().catch(() => {});
  }, 25000);

  console.log('📡 [Channel Monitor] Automated 24/7 @solearlytrending listener activated (25s interval, sub-3GB/month).');
}

export function stopTrendingChannelMonitor(): void {
  if (monitorIntervalTimer) {
    clearInterval(monitorIntervalTimer);
    monitorIntervalTimer = null;
  }
}
