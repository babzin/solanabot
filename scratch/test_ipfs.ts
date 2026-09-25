import axios from 'axios';

async function testIpfsGateways() {
  const hash = 'bafkreihwlxdsrfcwxamshxuhewzxss36vcdojzgusls4cyea6dcfdzsd54';
  const gateways = [
    `https://cloudflare-ipfs.com/ipfs/${hash}`,
    `https://dweb.link/ipfs/${hash}`,
    `https://gateway.pinata.cloud/ipfs/${hash}`,
  ];

  for (const g of gateways) {
    try {
      const res = await axios.get(g, { timeout: 4000 });
      console.log('Success with gateway', g, ':', res.data);
      return;
    } catch (err: any) {
      console.log('Failed with gateway', g, err.message);
    }
  }
}

testIpfsGateways();
