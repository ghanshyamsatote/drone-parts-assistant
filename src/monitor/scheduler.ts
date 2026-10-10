import cron from 'node-cron';
import { config } from '../config.js';
import { runCheck } from './run.js';
import { deliverPending } from '../notify/deliver.js';
import type { Notifier } from '../notify/types.js';

// Runs inside the bot process:
//  - the monitoring job on CHECK_CRON (default 09:00 IST daily)
//  - an outbox drain every 10 minutes, so alerts that failed to send
//    (Telegram down, network blip) are retried without waiting a day
// A simple in-process lock prevents overlapping runs if a check is slow.

let running = false;

export async function monitorAndNotify(notifier: Notifier): Promise<void> {
  if (running) {
    console.log('[scheduler] previous run still in progress, skipping');
    return;
  }
  running = true;
  try {
    console.log(`[scheduler] monitoring run started ${new Date().toISOString()}`);
    const s = await runCheck({ log: () => {} });
    const d = await deliverPending(notifier);
    console.log(`[scheduler] run #${s.runId}: ${s.checked} products in ${s.seconds}s, ` +
      `${s.events.length} events, ${s.errors} errors, ${d.sent} alerts sent`);
  } catch (err) {
    console.error('[scheduler] run failed:', err);
  } finally {
    running = false;
  }
}

export function startScheduler(notifier: Notifier): void {
  if (!cron.validate(config.CHECK_CRON)) throw new Error(`Invalid CHECK_CRON: "${config.CHECK_CRON}"`);

  cron.schedule(config.CHECK_CRON, () => monitorAndNotify(notifier), { timezone: 'Asia/Kolkata' });
  cron.schedule('*/10 * * * *', async () => {
    const d = await deliverPending(notifier).catch(() => ({ sent: 0, failed: 0 }));
    if (d.sent || d.failed) console.log(`[scheduler] outbox drain: ${d.sent} sent, ${d.failed} failed`);
  });

  console.log(`[scheduler] monitoring scheduled: "${config.CHECK_CRON}" (Asia/Kolkata)`);
}
