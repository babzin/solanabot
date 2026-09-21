import { spawn } from 'child_process';
import path from 'path';

export function startCloudflareTunnel(port: number): Promise<{ url: string; kill: () => void }> {
  return new Promise((resolve, reject) => {
    const cloudflaredPath = path.resolve(process.cwd(), 'cloudflared.exe');
    console.log(`📡 Starting Cloudflare Tunnel via ${cloudflaredPath}...`);

    const child = spawn(cloudflaredPath, ['tunnel', '--url', `http://localhost:${port}`], {
      windowsHide: true,
    });

    let resolved = false;
    const urlRegex = /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/;

    child.stderr.on('data', (data) => {
      const output = data.toString();
      const match = output.match(urlRegex);
      if (match && !resolved) {
        resolved = true;
        resolve({
          url: match[0],
          kill: () => child.kill(),
        });
      }
    });

    child.on('error', (err) => {
      if (!resolved) {
        reject(err);
      }
    });

    setTimeout(() => {
      if (!resolved) {
        child.kill();
        reject(new Error('Cloudflare Tunnel timed out after 20s'));
      }
    }, 20000);
  });
}

async function test() {
  try {
    const tunnel = await startCloudflareTunnel(3001);
    console.log(`✅ Cloudflare Tunnel Live: ${tunnel.url}`);
    tunnel.kill();
    console.log('Tunnel killed cleanly.');
  } catch (err: any) {
    console.error('❌ Cloudflare Tunnel failed:', err.message);
  }
}

test();
