import { Bot, GrammyError } from 'grammy';
import { config } from '../config.js';
import type { Notifier } from './types.js';

// One Bot instance for the whole process: the notifier pushes alerts through
// it and the chat interface (bot.ts) receives messages on it.
let bot: Bot | null = null;

export function getBot(): Bot {
  if (!config.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is not set (see .env.example)');
  return (bot ??= new Bot(config.TELEGRAM_BOT_TOKEN));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class TelegramNotifier implements Notifier {
  readonly channel = 'telegram';

  async send(chatId: string, html: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await getBot().api.sendMessage(chatId, html, {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
        });
        return;
      } catch (err) {
        // Telegram rate limit: it tells us exactly how long to wait.
        const retryAfter = err instanceof GrammyError ? err.parameters.retry_after : undefined;
        if (retryAfter && attempt < 3) {
          await sleep(retryAfter * 1000);
          continue;
        }
        throw err;
      }
    }
  }
}
