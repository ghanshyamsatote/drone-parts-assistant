import { runCheck } from '../monitor/run.js';
import { ALERT_KINDS } from '../monitor/changes.js';
import { config } from '../config.js';
import { deliverPending } from '../notify/deliver.js';
import { TelegramNotifier } from '../notify/telegram.js';

// Run one monitoring pass now (the "forced run" for the demo).
//   npm run check                 # all watches
//   npm run check -- --watch 3    # one watch
//   npm run check -- --no-discover  # only re-check known products (faster)
//   npm run check -- --product 71   # re-check one product (seconds; used in the demo)
const args = process.argv.slice(2);
const argValue = (flag: string) => (args.includes(flag) ? Number(args[args.indexOf(flag) + 1]) : undefined);
const watchId = argValue('--watch');
const productId = argValue('--product');

const summary = await runCheck({
  watchIds: watchId !== undefined ? [watchId] : undefined,
  productIds: productId !== undefined ? [productId] : undefined,
  discover: !args.includes('--no-discover'),
});

console.log(`\nRun #${summary.runId}: ${summary.checked} products in ${summary.seconds}s`, summary.byMethod);
const alerts = summary.events.filter((e) => ALERT_KINDS.has(e.kind));
if (alerts.length) {
  console.log(`\n${alerts.length} alert-worthy change(s) written to the outbox:`);
  console.table(alerts.map((e) => ({ kind: e.kind, source: e.source, title: e.title.slice(0, 50), from: e.from, to: e.to, price: e.price })));
} else {
  console.log('No alert-worthy changes.');
}

// Deliver whatever is pending in the outbox (this run's events + any earlier failures).
if (config.TELEGRAM_BOT_TOKEN) {
  const r = await deliverPending(new TelegramNotifier());
  console.log(`Telegram: delivered ${r.sent}${r.failed ? `, ${r.failed} failed (will retry)` : ''}.`);
} else {
  console.log('TELEGRAM_BOT_TOKEN not set: events stay in the outbox until delivered.');
}
