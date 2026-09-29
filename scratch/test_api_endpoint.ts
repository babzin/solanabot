import axios from 'axios';

async function testApi() {
  try {
    const res = await axios.get('http://localhost:3001/api/learner');
    console.log('✅ Status:', res.status);
    console.log('✅ Response Keys:', Object.keys(res.data));
    console.log('✅ Total Flops in Memory:', res.data.memory?.totalFlops);
    console.log('✅ Total Winners in Memory:', res.data.memory?.totalWinners);
    console.log('✅ Danger Zones:', res.data.memory?.dangerZones);
    console.log('✅ Blacklisted Devs Count:', res.data.memory?.blacklistedDevCount);
    console.log('✅ Dashboard HTML Preview:', res.data.dashboardHtml?.slice(0, 100) + '...');
  } catch (err: any) {
    console.error('❌ API Test Error:', err.message);
  }
}

testApi();
