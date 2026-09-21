const https = require('https');
const fs = require('fs');

https.get('https://t.me/s/solearlytrending', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    const textRegex = /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
    let match;
    let idx = 0;
    let output = '';
    while ((match = textRegex.exec(data)) !== null) {
      idx++;
      output += `\n=================== ACTUAL MESSAGE ${idx} ===================\n`;
      output += match[1].replace(/<br\/>/g, '\n') + '\n';
    }
    fs.writeFileSync('scratch/actual_posts.txt', output);
    console.log(`Saved ${idx} messages to scratch/actual_posts.txt`);
  });
});
