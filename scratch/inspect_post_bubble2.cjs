const https = require('https');

https.get('https://t.me/s/solearlytrending', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    const idx = data.indexOf('solearlytrending/459266');
    if (idx !== -1) {
      console.log(data.substring(idx + 1500, idx + 4000));
    }
  });
});
