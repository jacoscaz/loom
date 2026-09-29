
import {
  type Contact,
} from "./contacts.js";

import {
  type UserBlock,
  type BaseMessage,
} from "./messages.js";

export interface BaseUserNotification extends BaseMessage {
  role: 'user';
  type: 'notification';
  method: string;
  blocks: UserBlock[];
  contact?: Contact;
}

export interface UserMessageIncomingNotification extends BaseUserNotification {
  method: 'message/incoming';
  transport:
    | { type: 'telegram'; from_id: number; chat_id: number; username?: string; guidance?: string; }
    | { type: 'email', from: { address: string; name?: string; }, guidance?: string; }
    ;

  /**
   * Transport guidance is CODE-OWNED, not database-owned: each notifier
   * attaches concrete reply-medium rules for the message shape it just
   * delivered (e.g. a Telegram voice note → prefer telegram_send_voice).
   * It rides the event envelope so the etiquette lives in the structure
   * that carried the message, not in the periphery of attention.
   */
}

export interface UserTodoDueNotification extends BaseUserNotification {
  method: 'todo/due';
}

export type UserNotification =
  | UserMessageIncomingNotification
  | UserTodoDueNotification
  ;
