
import { type IdentityAnchor } from "./tables/identity_anchors.js";
import { type Session } from "./tables/sessions.js";
import { type ADBMessage } from './tables/messages.js';
import { type ContinuityRecord } from "./tables/continuity_records.js";
import { type SessionInjection } from "./tables/session_injections.js";
import { type Checkpoint } from "./tables/checkpoints.js";
import { type Contact, type ContactUrl } from "./tables/contacts.js";
import { type CrontabRow } from "./tables/crontab.js";

export interface Tables {
  crontab: CrontabRow;
  sessions: Session;
  messages: ADBMessage;
  identity_anchors: IdentityAnchor;
  continuity_records: ContinuityRecord;
  checkpoints: Checkpoint;
  contacts: Contact;
  contact_urls: ContactUrl;
  session_injections: SessionInjection;
}
