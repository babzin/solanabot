const https = require('https');

https.get('https://t.me/s/solearlytrending', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    const regex = /<div class="tgme_widget_message_bubble">([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/g;
    let match;
    while ((match = regex.exec(data)) !== null) {
      if (match[1].includes('New') && match[1].includes('Trending')) {
        const photo = match[1].match(/<a class="tgme_widget_message_photo_wrap[^>]*style="([^"]*)"/);
        if (photo) console.log('PHOTO STYLE:\n', photo[1]);
        
        const text = match[1].match(/<div class="tgme_widget_message_text js-message_text"[^>]*>([\s\S]*?)<\/div>/);
        if (text) {
          console.log('FIRST 600 CHARS:\n', text[1].slice(0, 600));
          console.log('\nFULL TEXT TO PLAIN:\n');
          let clean = text[1]
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<i class="emoji"[^>]*><b>(.*?)<\/b><\/i>/gi, '$1')
            .replace(/<a [^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '$2')
            .replace(/<b>(.*?)<\/b>/gi, '$1')
            .replace(/<i>(.*?)<\/i>/gi, '$1')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&#036;/g, '$');
          console.log(clean);
        }
        break;
      }
    }
  });
});
