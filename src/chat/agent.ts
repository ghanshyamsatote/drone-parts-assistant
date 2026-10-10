import { chat, type ChatMessage } from '../llm/client.js';
import { runTool, toolDefinitions, type ToolContext } from './tools.js';
import { CATEGORIES } from '../extract/llm.js';

// The chat agent: a standard tool-calling loop.
//   user message -> LLM -> (tool calls -> results -> LLM)* -> final answer
// Short per-chat memory lets follow-ups like "compare the first two" work.

const SYSTEM_PROMPT = `You are a shopping assistant for drone builders in India. You track product availability
on Robu.in, ThinkRobotics, Zbotic and Evelta (flight controllers, Raspberry Pi 5 and HATs, Pixhawk, companion computers...).

Rules:
- ALWAYS use tools for product facts. Never invent products, prices, stock status or links.
- search_products is fast and should be your first choice. Use live_search only if nothing is found there.
- Product categories: ${CATEGORIES.join(', ')}.
- Statuses: in_stock, out_of_stock, pre_order, unknown. Prices are INR; write them like ₹12,499.
- "Watch / track / notify me / alert me" means add_watch. A pasted link = kind "url". A product name = kind "query".
- When showing products: one line each with store, status emoji (🟢 in stock, 🟡 pre-order, 🔴 out of stock, ⚪ unknown), price and a link.
  Mention the product id in brackets like [#71] so the user can refer to it.
- Keep answers short; this is a phone chat. If there are more results than shown, say how many.
- Format with Telegram HTML only: <b>, <i>, <a href="...">. No Markdown, no other tags.`;

const MAX_TOOL_ROUNDS = 5;
const HISTORY_TURNS = 6; // user+assistant pairs kept per chat (in memory)
const history = new Map<string, ChatMessage[]>();

export async function handleMessage(text: string, ctx: ToolContext): Promise<string> {
  const past = history.get(ctx.chatId) ?? [];
  const messages: ChatMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }, ...past, { role: 'user', content: text }];
  const tools = toolDefinitions();

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    // On the last round, withhold tools so the model must answer.
    const msg = await chat({ messages, ...(round < MAX_TOOL_ROUNDS ? { tools } : {}) });

    if (!msg.tool_calls?.length) {
      const answer = msg.content?.trim() || "Sorry, I couldn't come up with an answer.";
      remember(ctx.chatId, text, answer);
      return answer;
    }

    // Keep the assistant message exactly as returned (Gemini attaches
    // signatures to tool calls that must be sent back unchanged).
    messages.push({ role: 'assistant', ...msg } as ChatMessage);
    for (const call of msg.tool_calls) {
      const result = await runTool(call.function.name, call.function.arguments, ctx);
      console.log(`[agent] ${call.function.name}(${call.function.arguments.slice(0, 120)})`);
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result).slice(0, 12_000) });
    }
  }
  return 'Sorry, that took too many steps. Could you rephrase?';
}

function remember(chatId: string, user: string, assistant: string) {
  const h = [...(history.get(chatId) ?? []), { role: 'user', content: user } as ChatMessage, { role: 'assistant', content: assistant } as ChatMessage];
  history.set(chatId, h.slice(-HISTORY_TURNS * 2));
}

export function resetHistory(chatId: string) {
  history.delete(chatId);
}
