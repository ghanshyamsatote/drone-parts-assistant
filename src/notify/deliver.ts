import { db } from '../db/index.js';
import { ALERT_KINDS } from '../monitor/changes.js';
import { formatDigest, type PendingAlert } from './format.js';
import type { Notifier } from './types.js';

// Drains the outbox: finds (event, chat) pairs not yet delivered, sends one
// digest per chat, and records each delivery.
//
// Who gets an event? Every chat with an active watch covering that product.
// Global seed watches (chat_id NULL) go to all subscribers.
//
// Guarantees:
//  - a (event, chat) pair is recorded only after Telegram accepted the
//    message; a failed send stays pending and is retried on the next drain
//  - the deliveries primary key means re-running never re-sends a recorded
//    pair. (A crash between "sent" and "recorded" could duplicate one
//    message — at-least-once delivery, the right side to err on for alerts.)
//  - stale events (older than MAX_AGE) are not sent after downtime, and a chat
//    never receives events from before it subscribed.

const MAX_AGE = '-3 days';
const MAX_PER_MESSAGE = 10;

function pendingByChat(): Map<string, PendingAlert[]> {
  const kinds = [...ALERT_KINDS];
  const rows = db.prepare(
    `SELECT DISTINCT s.chat_id, e.id AS event_id, e.kind, e.from_status, e.to_status, e.old_price, e.new_price,
            p.id AS product_id, p.title, p.url, p.source
     FROM events e
     JOIN products p        ON p.id = e.product_id
     JOIN watch_products wp ON wp.product_id = e.product_id
     JOIN watches w         ON w.id = wp.watch_id AND w.active = 1
     JOIN subscribers s     ON w.chat_id = s.chat_id OR w.chat_id IS NULL
     LEFT JOIN deliveries d ON d.event_id = e.id AND d.chat_id = s.chat_id
     WHERE d.event_id IS NULL
       AND e.kind IN (${kinds.map(() => '?').join(',')})
       AND e.created_at >= datetime('now', '${MAX_AGE}')
       AND e.created_at >= s.created_at
     ORDER BY s.chat_id, e.id`,
  ).all(...kinds) as unknown as (PendingAlert & { chat_id: string })[];
  return Map.groupBy(rows, (r) => r.chat_id);
}

export async function deliverPending(notifier: Notifier): Promise<{ sent: number; failed: number }> {
  const record = db.prepare(`INSERT OR IGNORE INTO deliveries (event_id, chat_id) VALUES (?, ?)`);
  let sent = 0;
  let failed = 0;

  for (const [chatId, alerts] of pendingByChat()) {
    for (let i = 0; i < alerts.length; i += MAX_PER_MESSAGE) {
      const chunk = alerts.slice(i, i + MAX_PER_MESSAGE);
      try {
        await notifier.send(chatId, formatDigest(chunk));
        for (const a of chunk) record.run(a.event_id, chatId);
        sent += chunk.length;
      } catch (err) {
        failed += chunk.length;
        console.warn(`[notify] ${notifier.channel} → ${chatId} failed: ${(err as Error).message}`);
      }
    }
  }
  return { sent, failed };
}
