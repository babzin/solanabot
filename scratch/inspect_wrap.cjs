const https = require('https');

https.get('https://t.me/s/solearlytrending', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    const wrapRegex = /<div class="tgme_widget_message_wrap[^"]*"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/g;
    let m = wrapRegex.exec(data);
    if (m) {
      console.log('Sample message wrap:');
      console.log(m[0].substring(0, 1000));
    }
  });
});
