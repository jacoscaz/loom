
import { type DBSession } from "./tables/sessions.js";
import { type DBMessage } from "./tables/messages.js";

export interface Tables {
  sessions: DBSession;
  messages: DBMessage;
}
