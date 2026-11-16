/**
 * Configuration of the Telegram tool server. Owned by this package.
 */
export interface TelegramConfig {
  /** Bot API token from @BotFather. */
  api_token: string;
  /** Long-poll interval in seconds for getUpdates (Telegram timeout). */
  poll_timeout_seconds?: number;
  /**
   * Optional allowlist of Telegram user ids. When set, messages from any
   * other user are dropped before reaching the harness (fail closed).
   * Sender verification proper is the harness' job, based on the
   * envelope's `from` URL; this is defence in depth.
   */
  allowed_user_ids?: number[];
  /**
   * Directory into which the `file` tool saves downloaded media.
   * Defaults to `<cwd>/media/telegram`.
   */
  media_dir?: string;
  /** Bot API base URL. Defaults to `https://api.telegram.org`. */
  api_base?: string;
}
