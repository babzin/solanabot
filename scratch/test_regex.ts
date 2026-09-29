function extractTokenFromQuery(q: string): string | null {
  const mintMatch = q.match(/\b([1-9A-HJ-NP-za-km-z]{32,44})\b/);
  if (mintMatch) return mintMatch[1];

  const tickerMatch = q.match(/\$([A-Za-z0-9_]{2,12})\b/);
  if (tickerMatch) return tickerMatch[1];

  // Specific narrative/lore/about phrase:
  // e.g. "narrative of/on/behind <token>", "lore of/behind <token>", "what is the narrative of <token>"
  const phraseMatch = q.match(/(?:narrative|lore|meme|concept|story|origin|background|whitepaper|about)\s+(?:of|on|behind|for|about)\s+(?:the\s+)?(?:\$)?([A-Za-z0-9_]{2,12})\b/i);
  if (phraseMatch) return phraseMatch[1];

  // e.g. "what is <token> about", "tell me about <token>", "opinion on <token>", "audit <token>", "check <token>"
  const verbMatch = q.match(/(?:about|tell me about|check|audit|analyze|opinion on|think of|explain)\s+(?:the\s+)?(?:\$)?([A-Za-z0-9_]{2,12})\b/i);
  if (verbMatch) return verbMatch[1];

  // e.g. "what is <token> about"
  const whatIsAboutMatch = q.match(/what(?:\s+is|\x27s)\s+(?:the\s+)?(?:\$)?([A-Za-z0-9_]{2,12})\s+about\b/i);
  if (whatIsAboutMatch) return whatIsAboutMatch[1];

  // e.g. "what is <token>?"
  const whatIsMatch = q.match(/what(?:\s+is|\x27s)\s+(?:the\s+)?(?:\$)?([A-Za-z0-9_]{2,12})(?:\?|\s|$)/i);
  if (whatIsMatch) {
    const candidate = whatIsMatch[1];
    const nonTokens = ['narrative', 'lore', 'meme', 'concept', 'story', 'today', 'pnl', 'loss', 'profit', 'radar', 'bot', 'market', 'price', 'winner', 'flop', 'runner', 'gainers', 'good', 'best', 'our'];
    if (!nonTokens.includes(candidate.toLowerCase())) {
      return candidate;
    }
  }

  return null;
}

const tests = [
  "what is the narrative of $NPC?",
  "what is the narrative of NPC",
  "what is the narrative behind UNTXD",
  "tell me about BONK",
  "what is UNTXD about?",
  "what is NPC?",
  "narrative on CHROME",
  "lore of BONK",
  "what is the lore behind 7GUnr7krtQhJwd6ASY2VUprd9t4c64zcgCsjdmZepump",
  "what should i buy today",
  "how do we maximize profit",
  "how do we avoid yesterday's loss"
];

for (const t of tests) {
  console.log(`"${t}" =>`, extractTokenFromQuery(t));
}
