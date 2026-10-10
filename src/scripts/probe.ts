import { adapterForUrl, searchAllSources } from '../sources/registry.js';
import { extractStatus } from '../extract/index.js';
import { extractAttributes } from '../extract/llm.js';

// Manual testing tool for the source layer:
//   npm run probe -- search "pixhawk 6x"
//   npm run probe -- fetch https://zbotic.in/product/...
const [cmd, ...rest] = process.argv.slice(2);
const arg = rest.join(' ');

if (cmd === 'search' && arg) {
  const t = Date.now();
  const { listings, errors } = await searchAllSources(arg);
  console.table(listings.map((l) => ({ source: l.source, title: l.title.slice(0, 70), url: l.url })));
  if (errors.length) console.error('Source errors:', errors);
  console.log(`${listings.length} results in ${((Date.now() - t) / 1000).toFixed(1)}s`);
} else if (cmd === 'fetch' && arg) {
  const adapter = adapterForUrl(arg);
  console.log(`adapter: ${adapter.id}`);
  const obs = await adapter.fetchProduct(arg);
  console.dir(obs, { depth: 5 });
  console.log('extraction:', await extractStatus(obs));
} else if (cmd === 'attrs' && arg) {
  // e.g. npm run probe -- attrs "raspberry pi 5"  -> LLM attributes for search hits
  const { listings } = await searchAllSources(arg);
  const titles = listings.slice(0, 12).map((l) => l.title);
  const attrs = await extractAttributes(titles);
  console.table(titles.map((t, i) => ({ title: t.slice(0, 55), ...attrs[i], specs: JSON.stringify(attrs[i]?.specs) })));
} else {
  console.log('usage: npm run probe -- search "<query>" | fetch <url> | attrs "<query>"');
}
