// Store search engines are fuzzy: searching "Pixhawk 6X" on Evelta returns
// buzzers and telemetry radios, and Shopify happily returns "Pixhawk 6C".
// So we apply our own relevance filter: every query token must appear in
// the product title.
//  - plain words match as a prefix, so "controller" matches "controllers"
//  - tokens with digits ("5", "6x") must match a whole word AND, if they
//    follow another query word, sit right after it. Model numbers only mean
//    something next to their name: "Raspberry Pi 5" must not match
//    "IR camera 5 MP for Raspberry Pi" or "case for Pi4 3.5 inch LCD".

export const normalize = (s: string) =>
  s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim();

export function matchesQuery(title: string, query: string): boolean {
  const words = normalize(title).split(' ');
  const tokens = normalize(query).split(' ').filter(Boolean);
  return tokens.every((tok, i) => {
    if (!/\d/.test(tok)) return words.some((w) => w.startsWith(tok));
    if (i === 0) return words.includes(tok);
    const prev = tokens[i - 1];
    return words.some((w, j) => w === tok && j > 0 && words[j - 1].startsWith(prev));
  });
}
