import localtunnel from 'localtunnel';
import { env } from '../src/config/env.js';
import { updateHeliusWebhookUrl } from '../src/services/helius.js';

const PORT = 3001;
const SUBDOMAIN = 'mysolana-alpha-bot';

async function start() {
  console.log(`📡 Starting persistent localtunnel for port ${PORT}...`);
  try {
    const tunnel = await localtunnel({
      port: PORT,
      subdomain: SUBDOMAIN,
    });

    const webhookEndpoint = `${tunnel.url}/api/webhook/swaps`;
    console.log(`🚀 Public Webhook Gateway Online: ${tunnel.url}`);
    console.log(`   └ Forwarding to http://localhost:${PORT}/api/webhook/swaps`);

    if (env.HELIUS_WEBHOOK_ID) {
      await updateHeliusWebhookUrl(env.HELIUS_WEBHOOK_ID, webhookEndpoint);
    }

    tunnel.on('close', () => {
      console.warn('⚠️ Tunnel closed! Auto-reconnecting in 5 seconds...');
      setTimeout(start, 5000);
    });

    tunnel.on('error', (err) => {
      console.warn('⚠️ Tunnel error:', err.message);
    });
  } catch (err: any) {
    console.warn('⚠️ Could not establish tunnel, retrying in 5 seconds:', err.message);
    setTimeout(start, 5000);
  }
}

start();
