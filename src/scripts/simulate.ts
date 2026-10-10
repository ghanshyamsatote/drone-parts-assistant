import { db } from '../db/index.js';
import { forceProductStatus, getProduct } from '../db/repo.js';
import { STOCK_STATUSES, type StockStatus } from '../types.js';

// Demo helper. Real restocks can take weeks, so for the video we "rewind" a
// product that is in stock right now to out_of_stock. The next real check
// then observes a genuine out_of_stock -> in_stock transition and alerts.
//   npm run simulate -- list               # in-stock / pre-order products
//   npm run simulate -- <productId> out_of_stock
const [idArg, statusArg] = process.argv.slice(2);

if (!idArg || idArg === 'list') {
  const rows = db.prepare(
    `SELECT id, source, current_status AS status, current_price AS price, substr(title, 1, 60) AS title
     FROM products WHERE current_status IN ('in_stock', 'pre_order') ORDER BY source, id LIMIT 40`,
  ).all();
  console.table(rows);
} else {
  const status = (statusArg ?? 'out_of_stock') as StockStatus;
  if (!STOCK_STATUSES.includes(status)) throw new Error(`status must be one of ${STOCK_STATUSES.join(', ')}`);
  const p = getProduct(Number(idArg));
  if (!p) throw new Error(`No product ${idArg}`);
  forceProductStatus(p.id, status);
  console.log(`Product #${p.id} "${p.title}" forced to ${status} (was ${p.current_status}).`);
  console.log(`Now run: npm run check -- --product ${p.id}`);
}
