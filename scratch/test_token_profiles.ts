import axios from 'axios';

async function testTokenProfiles() {
  try {
    const res = await axios.get('https://api.dexscreener.com/token-profiles/latest/v1', { timeout: 5000 });
    console.log('Profiles count:', res.data.length);
    if (res.data.length > 0) {
      console.log('Sample profile:', JSON.stringify(res.data[0], null, 2));
    }
  } catch (err: any) {
    console.log('Error:', err.message);
  }
}
testTokenProfiles();
