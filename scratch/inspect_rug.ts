import axios from 'axios';

async function checkRug() {
  const mint = '6XFw7JQvRyjCLR8DeA7yW1NwBMC1XadpMDm7Qh4Epump';
  const res = await axios.get(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`);
  console.log('Score:', res.data.score);
  console.log('Risks:', res.data.risks);
}

checkRug().catch(console.error);
