import { config } from './config.js';
import { addSubscriber, productsForWatches } from './db/repo.js';
import { getBot, TelegramNotifier } from './notify/telegram.js';
import { startScheduler } from './monitor/scheduler.js';
import { escapeHtml, rupees, sourceName } from './notify/format.js';
import { handleMessage, resetHistory } from './chat/agent.js';
import { runCheck } from './monitor/run.js';
import type { Bot } from 'grammy';

// The long-running process: Telegram chat interface + scheduler + alert delivery.
// Also runs the daily monitoring job (see monitor/scheduler.ts).

if (!config.TELEGRAM_BOT_TOKEN) {
  console.error('Set TELEGRAM_BOT_TOKEN in .env first (create a bot with @BotFather).');
  process.exit(1);
}

const bot = getBot();

const HELP = `<b>What I can do</b>
🔎 <i>show in-stock flight controllers under 20000</i>
📦 <i>is the Pixhawk 6X available anywhere?</i>
📈 <i>history of #71</i>  ·  <i>compare #70 and #71</i>
➕ <i>watch https://robu.in/product/...</i>  or  <i>watch Jetson Orin Nano</i>
📋 <i>what am I watching?</i>  ·  <i>stop watching #12</i>

I check all watched products daily and message you when something is back in stock, opens for pre-order, or drops in price.
/reset clears our conversation.`;

const STATUS_EMOJI: Record<string, string> = { in_stock: '🟢', pre_order: '🟡', out_of_stock: '🔴', unknown: '⚪' };

bot.command('start', async (ctx) => {
  addSubscriber(String(ctx.chat.id));
  await ctx.reply(
    '👋 Subscribed! I watch Indian drone-parts stores (Robu, ThinkRobotics, Zbotic, Evelta) ' +
      'and will message you when a watched product is back in stock or opens for pre-order.\n\n' + HELP,
    { parse_mode: 'HTML' },
  );
});

bot.command('help', (ctx) => ctx.reply(HELP, { parse_mode: 'HTML' }));

bot.command('reset', async (ctx) => {
  resetHistory(String(ctx.chat.id));
  await ctx.reply('Conversation cleared.');
});

bot.on('message:text', async (ctx) => {
  const chatId = String(ctx.chat.id);
  addSubscriber(chatId); // anyone chatting with the bot also receives their alerts
  await ctx.replyWithChatAction('typing');
  const typing = setInterval(() => ctx.replyWithChatAction('typing').catch(() => {}), 4500);

  try {
    const answer = await handleMessage(ctx.message.text, {
      chatId,
      onWatchAdded: (watchId, label) => void firstCheck(bot, chatId, watchId, label),
    });
    await sendHtml(bot, chatId, answer);
  } catch (err) {
    console.error('[bot] agent error:', err);
    await ctx.reply('⚠️ Something went wrong on my side. Please try again in a moment.');
  } finally {
    clearInterval(typing);
  }
});

/** Run the first check for a just-added watch and report what was found. */
async function firstCheck(bot: Bot, chatId: string, watchId: number, label: string) {
  try {
    const summary = await runCheck({ watchIds: [watchId], log: () => {} });
    const products = productsForWatches([watchId]);
    if (!products.length) {
      await sendHtml(bot, chatId, `🔍 <b>${escapeHtml(label)}</b>: no matching listings found right now. I'll keep checking daily.`);
      return;
    }
    const lines = products.slice(0, 10).map((p) =>
      `${STATUS_EMOJI[p.current_status]} <a href="${escapeHtml(p.url)}">${escapeHtml(p.title.slice(0, 70))}</a> · ${sourceName(p.source)}${p.current_price != null ? ` · ${rupees(p.current_price)}` : ''} [#${p.id}]`,
    );
    const more = products.length > 10 ? `\n…and ${products.length - 10} more.` : '';
    await sendHtml(bot, chatId,
      `✅ <b>Now watching: ${escapeHtml(label)}</b>\nFound ${products.length} listing(s) (checked in ${summary.seconds}s):\n\n${lines.join('\n')}${more}\n\nI'll alert you when any of these comes back in stock or opens for pre-order.`);
  } catch (err) {
    await sendHtml(bot, chatId, `⚠️ First check for <b>${escapeHtml(label)}</b> failed: ${escapeHtml((err as Error).message)}. I'll retry in the daily run.`);
  }
}

/** Send LLM-written HTML; if Telegram rejects the markup, fall back to plain text. */
async function sendHtml(bot: Bot, chatId: string, html: string) {
  try {
    await bot.api.sendMessage(chatId, html, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
  } catch {
    await bot.api.sendMessage(chatId, html.replace(/<[^>]+>/g, ''), { link_preview_options: { is_disabled: true } });
  }
}

bot.catch((err) => console.error('[bot] error:', err.message));

startScheduler(new TelegramNotifier());

console.log('Bot running. Send /start to your bot in Telegram. Ctrl+C to stop.');
await bot.start();
