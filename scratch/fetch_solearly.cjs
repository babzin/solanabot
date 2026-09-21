const https = require('https');

https.get('https://t.me/s/solearlytrending', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    const regex = /<div class="tgme_widget_message_text js-message_text"[^>]*>([\s\S]*?)<\/div>/g;
    let match;
    let count = 0;
    while ((match = regex.exec(data)) !== null) {
      count++;
      let text = match[1]
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<i class="emoji"[^>]*><b>(.*?)<\/b><\/i>/gi, '$1')
        .replace(/<a [^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)')
        .replace(/<b>(.*?)<\/b>/gi, '**$1**')
        .replace(/<i>(.*?)<\/i>/gi, '*$1*')
        .replace(/<code>(.*?)<\/code>/gi, '`$1`')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
      console.log('------------------ MESSAGE ' + count + ' ------------------');
      console.log(text.trim());
    }
  });
}).on('error', (err) => {
  console.error(err);
});
