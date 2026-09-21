const https = require('https');

https.get('https://t.me/s/solearlytrending', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    const regex = /class="tgme_widget_message_text js-message_text"[^>]*>([\s\S]*?)<\/div>/g;
    let match;
    let i = 0;
    while ((match = regex.exec(data)) !== null && i < 15) {
      console.log(`=== MESSAGE ${i} ===`);
      console.log(match[1].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim());
      i++;
    }
  });
});
