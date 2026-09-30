
import {
  sql,
  type GeneratedAlways,
  type Insertable,
  type Selectable,
  type Updateable,
} from "kysely";

import type { DB } from "../client.js";

export interface Contact {
  id: GeneratedAlways<number>;
  name: string;
  guidance: string;
  /**
   * The operator's vouch — the ONLY verification signal. Deliberately
   * not settable through any contact tool: the agent can manage entries
   * but cannot grant standing. Existence is presence; approval is trust.
   */
  approved: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface ContactUrl {
  id: GeneratedAlways<number>;
  contact_id: number;
  url: string;
  guidance: string;
  created_at: Date;
  updated_at: Date;
}

export type InsertableContact = Insertable<Contact>;
export type UpdateableContact = Updateable<Contact>;
export type SelectableContact = Selectable<Contact>;

export interface SelectContactsOpts {
  id?: number;
  url?: string;
}

const initSelectContactsQuery = (db: DB, opts: SelectContactsOpts) => {
  let query = db.selectFrom('contacts').selectAll();
  if (opts.url) {
    query = query.where('id', 'in',
      qb => qb.selectFrom('contact_urls')
        .select('contact_id')
        .where('url', '=', opts.url!)
    );
  }
  return query;
}

export const selectContact = async (db: DB, opts: SelectContactsOpts) => {
  let query = initSelectContactsQuery(db, opts);
  query = query.limit(1);
  return await query.executeTakeFirst();
};

export const selectContacts = async (db: DB, opts: SelectContactsOpts) => {
  let query = initSelectContactsQuery(db, opts);
  return await query.execute();
};

export interface ContactWithUrls {
  contact: SelectableContact;
  urls: Selectable<ContactUrl>[];
}

/**
 * The full registry, contacts with their transport URLs — the read side
 * of the contacts store, consumed by the contacts_list tool so the agent
 * can verify the standing injected into the weave by transports.
 */
export const selectContactsWithUrls = async (db: DB): Promise<ContactWithUrls[]> => {
  const contacts = await db.selectFrom('contacts').selectAll().orderBy('id', 'asc').execute();
  const urls = await db.selectFrom('contact_urls').selectAll().orderBy('contact_id', 'asc').execute();
  const byId = new Map<number, ContactWithUrls>(contacts.map(c => [c.id, { contact: c, urls: [] }]));
  for (const url of urls) {
    byId.get(url.contact_id)?.urls.push(url);
  }
  return [...byId.values()];
};

export const selectContactByUrl = async (db: DB, url: string): Promise<SelectableContact | undefined> => {
  let query = db.selectFrom('contacts as c')
    .innerJoin('contact_urls as cu', 'c.id', 'cu.contact_id')
    .where('cu.url', '=', url)
    .selectAll('c')
    .select(eb => sql<string>`concat(${eb.ref('c.guidance')}, ' ', ${eb.ref('cu.guidance')})`.as('guidance'));
  return await query.executeTakeFirst();
};

export const insertContact = async (db: DB, values: InsertableContact): Promise<SelectableContact> => {
  return await db.insertInto('contacts')
    .values(values)
    .returningAll()
    .executeTakeFirstOrThrow();
};

export const insertContactUrl = async (db: DB, values: Insertable<ContactUrl>): Promise<Selectable<ContactUrl>> => {
  return await db.insertInto('contact_urls')
    .values(values)
    .returningAll()
    .executeTakeFirstOrThrow();
};

/**
 * Deletes a contact and its URLs. The contact_urls FK is restrictive
 * (no cascade), so URLs go first — deletion is two steps or nothing.
 */
export const deleteContactCascade = async (db: DB, contactId: number): Promise<void> => {
  await db.deleteFrom('contact_urls').where('contact_id', '=', contactId).execute();
  await db.deleteFrom('contacts').where('id', '=', contactId).execute();
};

export const deleteContactUrl = async (db: DB, url: string): Promise<number> => {
  return await db.deleteFrom('contact_urls').where('url', '=', url)
    .returning('id')
    .execute()
    .then(rows => rows.length);
};
