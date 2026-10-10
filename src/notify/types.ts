// A delivery channel. Telegram is the one implemented; WhatsApp (Twilio or
// Meta Cloud API) would be another class with the same two members — the
// outbox, message formatting and recipient logic stay unchanged.
export interface Notifier {
  readonly channel: string;
  /** Send an HTML-formatted message. Throws on failure (event stays pending). */
  send(chatId: string, html: string): Promise<void>;
}
