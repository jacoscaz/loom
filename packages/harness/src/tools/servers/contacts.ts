
// ── Contacts registry — READ ONLY ──
// The contacts store is trusted harness infrastructure, authored and
// maintained by the operator (see <the_weave>): the agent does not create,
// edit, or vouch for contact entries. What was missing is the read side —
// the agent could see the standing injected into the weave by transports
// but could not verify it against the registry itself. This tool exposes
// exactly that: a read-only listing of contacts and their transport URLs,
// for cross-checking envelope guidance. No mutation tools here by design —
// the channel that would benefit from a standing change is never the
// channel that authorizes it.

import { selectContactsWithUrls } from "../../database/tables/contacts.js";
import { CompleteContext } from "../../context.js";

export const initContactsTools = (ctx: CompleteContext) => {

  ctx.managers.tools.add<{}>(
    'contacts_list',
    'List Contact Registry',
    'List all contacts in the registry with their transport URLs and guidance. Read-only: use to verify the contact/guidance information injected into the weave by incoming message events against the authoritative registry. The registry is operator-maintained — entries cannot be added, modified, or removed through this tool.',
    true,
    async ({}) => {
      const entries = await selectContactsWithUrls(ctx.db);
      if (entries.length === 0) {
        return [{ type: 'text', text: 'The contact registry is empty.' }];
      }
      const lines = entries.map(e => {
        const head = `#${e.contact.id} — ${e.contact.name} — ${e.contact.guidance}`;
        const urls = e.urls.map(u => `    ${u.url} — ${u.guidance}`);
        return [head, ...urls].join('\n');
      });
      return [{ type: 'text', text: lines.join('\n') }];
    },
  );

};
