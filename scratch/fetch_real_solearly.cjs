const https = require('https');

https.get('https://t.me/s/solearlytrending', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    // Find message blocks
    const msgRegex = /<div class="tgme_widget_message_wrap[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/g;
    const textRegex = /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
    let match;
    let idx = 0;
    while ((match = textRegex.exec(data)) !== null && idx < 5) {
      idx++;
      console.log(`\n=================== ACTUAL MESSAGE ${idx} ===================`);
      const rawHtml = match[1];
      console.log(rawHtml.replace(/<br\/>/g, '\n'));
    }

    // Also check photo attachments
    const photoRegex = /class="tgme_widget_message_photo_wrap[^"]*" style="background-image:url\('([^']+)'\)/g;
    let pMatch;
    let pIdx = 0;
    while ((pMatch = photoRegex.exec(data)) !== null && pIdx < 3) {
      pIdx++;
      console.log(`Photo ${pIdx}:`, pMatch[1]);
    }
  });
});
