const https = require('https');

https.get('https://t.me/s/solearlytrending', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    // Check for photo elements
    const photoRegex = /class="tgme_widget_message_photo_wrap[^"]*" style="background-image:url\('([^']+)'\)"/g;
    let match;
    let count = 0;
    while ((match = photoRegex.exec(data)) !== null && count < 10) {
      count++;
      console.log(`Post Photo ${count}: ${match[1]}`);
    }
  });
});
