const https = require('https');

https.get('https://t.me/s/solearlytrending', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    // Find messages with 'New Trending'
    const regex = /<div class="tgme_widget_message_wrap[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/g;
    let match;
    while ((match = regex.exec(data)) !== null) {
      if (match[0].includes('New') && match[0].includes('Trending')) {
        console.log('==================== RAW MESSAGE START ====================');
        console.log(match[0]);
        console.log('==================== RAW MESSAGE END ====================');
        break;
      }
    }
  });
});
