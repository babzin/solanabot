import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import localtunnel from 'localtunnel';
import path from 'path';
import { env } from '../config/env.js';
import { updateHeliusWebhookUrl } from './helius.js';

export interface PublicGateway {
  url: string;
  close: () => void;
}

let activeChildProcess: ChildProcess | null = null;
let activeLtTunnel: any = null;

/**
 * Spawns a Cloudflare Quick Tunnel using cloudflared.exe
 * (Free, no account, edge-routed, zero interstitial / anti-phishing screens)
 */
function spawnCloudflareTunnel(port: number): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve, reject) => {
    const cloudflaredPath = path.resolve(process.cwd(), 'cloudflared.exe');
    if (!fs.existsSync(cloudflaredPath)) {
      return reject(new Error('cloudflared.exe not found'));
    }

    console.log(`📡 Launching Cloudflare Tunnel (cloudflared.exe) forwarding to localhost:${port}...`);
    const child = spawn(cloudflaredPath, ['tunnel', '--url', `http://localhost:${port}`], {
      windowsHide: true,
    });

    activeChildProcess = child;
    let resolved = false;
    const urlRegex = /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/;

    child.stderr.on('data', (data) => {
      const output = data.toString();
      const match = output.match(urlRegex);
      if (match && !resolved) {
        resolved = true;
        const publicUrl = match[0];
        console.log(`🚀 Cloudflare Tunnel Online: ${publicUrl}`);
        resolve({
          url: publicUrl,
          close: () => {
            try {
              child.kill();
            } catch {}
          },
        });
      }
    });

    child.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });

    child.on('exit', (code) => {
      if (!resolved) {
        resolved = true;
        reject(new Error(`cloudflared exited early with code ${code}`));
      }
    });

    // 25 second timeout for DNS / TLS negotiation
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try { child.kill(); } catch {}
        reject(new Error('Cloudflare Tunnel connection timed out after 25s'));
      }
    }, 25000);
  });
}

/**
 * Fallback to Localtunnel if cloudflared is unavailable
 */
async function spawnLocaltunnel(port: number): Promise<{ url: string; close: () => void }> {
  const SUBDOMAIN = 'mysolana-alpha-bot';
  console.log(`📡 Initializing Localtunnel fallback on port ${port}...`);
  const tunnel = await localtunnel({
    port,
    subdomain: SUBDOMAIN,
  });
  activeLtTunnel = tunnel;
  console.log(`🚀 Localtunnel Online: ${tunnel.url}`);

  return {
    url: tunnel.url,
    close: () => {
      try { tunnel.close(); } catch {}
    },
  };
}

/**
 * Initializes the best available public gateway for incoming Helius Webhooks
 * and updates Helius Webhook destination.
 */
export async function startPublicGateway(port: number): Promise<PublicGateway | null> {
  if (!env.ENABLE_TUNNEL) {
    console.log('📡 Tunnel disabled via ENABLE_TUNNEL=false.');
    return null;
  }

  let gateway: { url: string; close: () => void } | null = null;

  // 1. Try Cloudflare Tunnel first (Primary)
  try {
    gateway = await spawnCloudflareTunnel(port);
  } catch (cfErr: any) {
    console.warn(`⚠️ Cloudflare tunnel unavailable (${cfErr.message}). Falling back to Localtunnel...`);
  }

  // 2. Fallback to Localtunnel if Cloudflare failed
  if (!gateway) {
    try {
      gateway = await spawnLocaltunnel(port);
    } catch (ltErr: any) {
      console.error('❌ Failed to establish both Cloudflare and Localtunnel gateways:', ltErr.message);
      return null;
    }
  }

  // 3. Sync Helius Webhook URL
  const webhookEndpoint = `${gateway.url}/api/webhook/swaps`;
  console.log(`🔗 Webhook Public Ingestion Endpoint: ${webhookEndpoint}`);

  if (env.HELIUS_WEBHOOK_ID) {
    const synced = await updateHeliusWebhookUrl(env.HELIUS_WEBHOOK_ID, webhookEndpoint);
    if (synced) {
      console.log(`✅ Helius Webhook destination successfully synced to: ${webhookEndpoint}`);
    } else {
      console.warn(`⚠️ Failed to sync Helius Webhook URL. Check HELIUS_API_KEY and HELIUS_WEBHOOK_ID in .env`);
    }
  }

  return {
    url: gateway.url,
    close: () => {
      gateway?.close();
      if (activeChildProcess) {
        try { activeChildProcess.kill(); } catch {}
      }
      if (activeLtTunnel) {
        try { activeLtTunnel.close(); } catch {}
      }
    },
  };
}
