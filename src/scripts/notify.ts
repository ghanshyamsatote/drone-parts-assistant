import { deliverPending } from '../notify/deliver.js';
import { TelegramNotifier } from '../notify/telegram.js';

// Drain the outbox once: send every pending alert to its subscribers.
//   npm run notify
const r = await deliverPending(new TelegramNotifier());
console.log(`Delivered ${r.sent} alert(s)${r.failed ? `, ${r.failed} failed (will retry next time)` : ''}.`);
