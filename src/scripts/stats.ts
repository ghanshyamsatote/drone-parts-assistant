import { db } from '../db/index.js';

// Look inside the database: what is tracked, recent runs, recent changes.
//   npm run stats
const q = (sql: string) => db.prepare(sql).all();

console.log('\nWatches');
console.table(q(`SELECT w.id, w.kind, substr(w.value, 1, 50) AS value, COALESCE(w.chat_id, 'global') AS owner,
                        w.last_run_at, (SELECT COUNT(*) FROM watch_products wp WHERE wp.watch_id = w.id) AS products
                 FROM watches w WHERE w.active = 1`));

console.log('Products by store and status');
console.table(q(`SELECT source, current_status AS status, COUNT(*) AS n FROM products GROUP BY 1, 2 ORDER BY 1, 2`));

console.log('Recent runs');
console.table(q(`SELECT id, started_at, finished_at, products_checked, llm_calls, errors, events FROM runs ORDER BY id DESC LIMIT 5`));

console.log('Recent events (outbox) and how many chats received each');
console.table(q(`SELECT e.id, e.kind, e.from_status, e.to_status, substr(p.title, 1, 45) AS product, e.created_at,
                        (SELECT COUNT(*) FROM deliveries d WHERE d.event_id = e.id) AS delivered_to
                 FROM events e JOIN products p ON p.id = e.product_id ORDER BY e.id DESC LIMIT 8`));

console.log('Snapshots decided by the LLM (rules could not decide)');
console.table(q(`SELECT p.id, p.source, substr(p.title, 1, 40) AS product, s.status, substr(s.evidence, 1, 60) AS reason
                 FROM snapshots s JOIN products p ON p.id = s.product_id WHERE s.method = 'llm' ORDER BY s.id DESC LIMIT 5`));

console.log(`Subscribers: ${(db.prepare(`SELECT COUNT(*) AS n FROM subscribers`).get() as { n: number }).n}`);
