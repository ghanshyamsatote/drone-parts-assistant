import { handleMessage } from '../chat/agent.js';

// Talk to the chat agent from the terminal (no Telegram needed).
//   npm run chat -- "in-stock flight controllers under 20000"
// Several quoted messages = a multi-turn conversation.
const ctx = {
  chatId: 'cli',
  onWatchAdded: (id: number, label: string) => console.log(`(watch #${id} "${label}" added; first check would run in the bot)`),
};

for (const msg of process.argv.slice(2)) {
  console.log(`\n> ${msg}`);
  console.log(await handleMessage(msg, ctx));
}
