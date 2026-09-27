/**
 * Configuration of the Telegram MCP server. Owned by this package.
 */
export interface TelegramConfig {
  /** Bot API token from @BotFather. */
  api_token: string;
  /** Long-poll interval in seconds for getUpdates (Telegram timeout). */
  poll_timeout_seconds?: number;
}
