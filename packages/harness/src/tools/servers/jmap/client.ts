
// JMAP client — shared between MCP server and future notification system.

export interface JMAPSession {
  apiUrl: string;
  uploadUrl?: string;
  accounts: Record<string, {
    name: string;
    isPersonal: boolean;
    isReadOnly: boolean;
  }>;
  primaryAccounts: Record<string, string>;
}

export interface EmailAddress {
  name?: string | null;
  email: string;
}

export interface EmailSummary {
  id: string;
  subject: string;
  from: EmailAddress[];
  to: EmailAddress[];
  receivedAt: string;
  preview: string;
}

export interface EmailDetail extends EmailSummary {
  bodyValues: Record<string, { value: string; isTruncated: boolean }>;
  bodyStructure: { partId: string; type: string };
}

export interface Mailbox {
  id: string;
  name: string;
  role: string | null;
  unreadThreads: number;
  totalThreads: number;
}

export interface Identity {
  id: string;
  name: string;
  email: string;
}

export interface SendEmailParams {
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  /** Absolute paths of files to attach. Uploaded as JMAP blobs, sent with disposition: 'attachment'. */
  attachments?: Array<{ path: string; filename?: string }>;
}

const ATTACHMENT_MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  json: 'application/json',
  txt: 'text/plain',
  csv: 'text/csv',
  html: 'text/html',
  md: 'text/markdown',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
};

export interface SendEmailResult {
  emailId: string;
  submissionId: string;
  sendAt: string;
}

const USING_MAIL = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'];
const USING_SUBMISSION = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail', 'urn:ietf:params:jmap:submission'];

export class JMAPClient {

  #apiUrl: string;
  #sessionUrl: string;
  #token: string;

  #cachedSession: JMAPSession | null = null;
  #cachedInboxId: string | null = null;
  #cachedDraftsId: string | null = null;
  #cachedSentId: string | null = null;
  #cachedIdentity: Identity | null = null;

  constructor(opts: { apiUrl: string; sessionUrl: string; token: string }) {
    this.#apiUrl = opts.apiUrl;
    this.#sessionUrl = opts.sessionUrl;
    this.#token = opts.token;
  }

  // ─── Low-level JMAP request ───────────────────────────────────────────────

  async jmapRequest(methodCalls: unknown[], using: string[] = USING_MAIL): Promise<unknown[]> {
    const res = await fetch(this.#apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.#token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ using, methodCalls }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`JMAP request failed (${res.status}): ${text}`);
    }

    const data = await res.json();
    return data.methodResponses;
  }

  // ─── Session & account discovery ──────────────────────────────────────────

  async #getSession(): Promise<JMAPSession> {
    if (this.#cachedSession) return this.#cachedSession;

    const res = await fetch(this.#sessionUrl, {
      headers: { 'Authorization': `Bearer ${this.#token}` },
    });
    if (!res.ok) {
      throw new Error(`JMAP session request failed (${res.status})`);
    }
    this.#cachedSession = await res.json() as JMAPSession;
    return this.#cachedSession;
  }

  async getAccountId(): Promise<string> {
    const session = await this.#getSession();
    const mailAccount = session.primaryAccounts['urn:ietf:params:jmap:mail'];
    if (!mailAccount) {
      const entry = Object.entries(session.accounts).find(([, acc]) => acc.isPersonal && !acc.isReadOnly);
      if (!entry) throw new Error('No usable JMAP account found');
      return entry[0];
    }
    return mailAccount;
  }

  // ─── Mailbox helpers ──────────────────────────────────────────────────────

  async #getMailboxes(): Promise<Mailbox[]> {
    const accountId = await this.getAccountId();
    const responses = await this.jmapRequest([
      ['Mailbox/get', {
        accountId,
        ids: null,
        properties: ['id', 'name', 'role', 'unreadThreads', 'totalThreads'],
      }, '0'],
    ]);

    const result = (responses[0] as unknown[])[1] as { list: Mailbox[] };
    return result.list;
  }

  async getInboxId(): Promise<string> {
    if (this.#cachedInboxId) return this.#cachedInboxId;
    const mailboxes = await this.#getMailboxes();
    const inbox = mailboxes.find(m => m.role === 'inbox');
    if (!inbox) throw new Error('No inbox mailbox found');
    this.#cachedInboxId = inbox.id;
    return inbox.id;
  }

  async getDraftsMailboxId(): Promise<string> {
    if (this.#cachedDraftsId) return this.#cachedDraftsId;
    const mailboxes = await this.#getMailboxes();
    const drafts = mailboxes.find(m => m.role === 'drafts');
    if (!drafts) throw new Error('No drafts mailbox found');
    this.#cachedDraftsId = drafts.id;
    return drafts.id;
  }

  async getSentMailboxId(): Promise<string> {
    if (this.#cachedSentId) return this.#cachedSentId;
    const mailboxes = await this.#getMailboxes();
    const sent = mailboxes.find(m => m.role === 'sent');
    if (!sent) throw new Error('No sent mailbox found');
    this.#cachedSentId = sent.id;
    return sent.id;
  }

  async getIdentity(): Promise<Identity> {
    if (this.#cachedIdentity) return this.#cachedIdentity;

    const session = await this.#getSession();
    const submissionAccountId = session.primaryAccounts['urn:ietf:params:jmap:submission'] || await this.getAccountId();

    const responses = await this.jmapRequest([
      ['Identity/get', {
        accountId: submissionAccountId,
        ids: null,
        properties: ['id', 'name', 'email'],
      }, '0'],
    ], USING_SUBMISSION);

    const result = (responses[0] as unknown[])[1] as { list: Identity[] };
    if (result.list.length === 0) {
      throw new Error('No sending identity configured');
    }
    this.#cachedIdentity = result.list[0];
    return this.#cachedIdentity;
  }

  // ─── High-level operations ────────────────────────────────────────────────

  async listMailboxes(): Promise<Mailbox[]> {
    return this.#getMailboxes();
  }

  async listInbox(limit: number = 10): Promise<{ total: number; emails: EmailSummary[] }> {
    const accountId = await this.getAccountId();
    const inboxId = await this.getInboxId();

    const responses = await this.jmapRequest([
      ['Email/query', {
        accountId,
        filter: { inMailbox: inboxId },
        sort: [{ property: 'receivedAt', isAscending: false }],
        limit,
      }, '0'],
      ['Email/get', {
        accountId,
        properties: ['id', 'subject', 'from', 'to', 'receivedAt', 'preview'],
        '#ids': { resultOf: '0', name: 'Email/query', path: '/ids' },
      }, '1'],
    ]);

    const queryResult = (responses[0] as unknown[])[1] as { ids: string[]; total: number };
    const getResult = (responses[1] as unknown[])[1] as { list: EmailSummary[] };

    return { total: queryResult.total, emails: getResult.list };
  }

  async readEmail(emailId: string): Promise<EmailDetail> {
    const accountId = await this.getAccountId();

    const responses = await this.jmapRequest([
      ['Email/get', {
        accountId,
        ids: [emailId],
        properties: ['id', 'subject', 'from', 'to', 'receivedAt', 'bodyValues', 'bodyStructure'],
        fetchAllBodyValues: true,
      }, '0'],
    ]);

    const result = (responses[0] as unknown[])[1] as { list: EmailDetail[]; notFound: string[] };

    if (result.notFound.includes(emailId)) {
      throw new Error(`Email not found: ${emailId}`);
    }

    return result.list[0];
  }

  /**
   * Upload a file as a JMAP blob (RFC 8620 §6.1): POST raw bytes to the
   * session's uploadUrl with the {accountId} placeholder substituted.
   * Returns the blobId to reference in Email/set creates.
   */
  async uploadBlob(accountId: string, filePath: string): Promise<{ blobId: string; size: number; type: string }> {
    const session = await this.#getSession();
    if (!session.uploadUrl) {
      throw new Error('JMAP session exposes no uploadUrl — cannot upload attachments');
    }
    const { readFile } = await import('node:fs/promises');
    const bytes = await readFile(filePath);
    const type = ATTACHMENT_MIME_BY_EXT[filePath.toLowerCase().split('.').pop() ?? ''] ?? 'application/octet-stream';
    const res = await fetch(session.uploadUrl.replace('{accountId}', accountId), {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.#token}`, 'Content-Type': type },
      body: new Uint8Array(bytes),
    });
    if (!res.ok) {
      throw new Error(`JMAP blob upload failed: HTTP ${res.status}`);
    }
    return await res.json() as { blobId: string; size: number; type: string };
  }

  async sendEmail(params: SendEmailParams): Promise<SendEmailResult> {
    const accountId = await this.getAccountId();
    const identity = await this.getIdentity();
    const draftMailboxId = await this.getDraftsMailboxId();

    const session = await this.#getSession();
    const submissionAccountId = session.primaryAccounts['urn:ietf:params:jmap:submission'] || accountId;

    const toAddrs = params.to.map(email => ({ email }));
    const ccAddrs = (params.cc ?? []).map(email => ({ email }));
    const fromAddr = [{ name: identity.name, email: identity.email }];

    // The SMTP envelope must list ALL recipients (To + CC [+ BCC]);
    // the document headers are display-only and are NOT merged into
    // delivery by the server. Omitting CC here silently drops those
    // recipients from actual delivery.
    const envelopeRecipients = [...params.to, ...(params.cc ?? [])].map(email => ({ email }));

    // Upload attachment blobs BEFORE the create/submit request — blobs must
    // exist to be referenced. Name: explicit filename or the basename.
    // Fastmail quirk (live-probed 2026-09-27): the top-level `attachments`
    // Email property is REJECTED on create (invalidProperties); attachments
    // must ride inside the bodyStructure as multipart/mixed subParts.
    let attachmentParts: Array<Record<string, unknown>> | null = null;
    if (params.attachments && params.attachments.length > 0) {
      const { basename } = await import('node:path');
      attachmentParts = [];
      for (const att of params.attachments) {
        const blob = await this.uploadBlob(accountId, att.path);
        attachmentParts.push({
          blobId: blob.blobId,
          type: blob.type,
          name: att.filename ?? basename(att.path),
          disposition: 'attachment',
        });
      }
    }
    const bodyStructure: Record<string, unknown> = attachmentParts
      ? { type: 'multipart/mixed', subParts: [{ partId: 'body', type: 'text/plain' }, ...attachmentParts] }
      : { partId: 'body', type: 'text/plain' };

    const createKey = 'draft';
    const responses = await this.jmapRequest([
      ['Email/set', {
        accountId,
        create: {
          [createKey]: {
            mailboxIds: { [draftMailboxId]: true },
            subject: params.subject,
            from: fromAddr,
            to: toAddrs,
            ...(ccAddrs.length > 0 ? { cc: ccAddrs } : {}),
            bodyStructure,
            bodyValues: {
              body: { value: params.body, charset: 'utf-8' },
            },
          },
        },
      }, '0'],
      ['EmailSubmission/set', {
        accountId: submissionAccountId,
        create: {
          send: {
            emailId: `#${createKey}`,
            identityId: identity.id,
            envelope: {
              mailFrom: { email: identity.email },
              rcptTo: envelopeRecipients,
            },
          },
        },
      }, '1'],
    ], USING_SUBMISSION);

    const emailResult = (responses[0] as unknown[])[1] as { created: Record<string, { id: string }> | null; notCreated: Record<string, unknown> | null };
    const sendResult = (responses[1] as unknown[])[1] as { created: Record<string, { id: string; sendAt: string; undoStatus: string }> | null; notCreated: Record<string, { type: string; description: string }> | null };

    if (emailResult.notCreated || sendResult.notCreated) {
      if (sendResult.notCreated) {
        const err = Object.values(sendResult.notCreated)[0];
        throw new Error(`Send failed: ${err.type} — ${err.description ?? JSON.stringify(err)}`);
      }
      if (emailResult.notCreated) {
        // include the offending properties — Fastmail names them there
        throw new Error(`Email creation failed: ${JSON.stringify(emailResult.notCreated)}`);
      }
    }

    const emailId = emailResult.created![createKey].id;
    const sendInfo = sendResult.created!['send'];

    // File the submitted draft into Sent in a SECOND request, using the
    // real email id: Fastmail does not resolve creation back-references
    // (`#key`) in Email/set update keys — notFound every time (live-probed
    // 2026-09-27; onSuccessUpdateEmail as a submission create property was
    // likewise rejected, live-probed 2026-09-04). Without this, every sent
    // email stays in Drafts forever. Filing is cosmetic — a failure here
    // must not fail the send (the mail is already out). Warn and continue.
    try {
      const sentMailboxId = await this.getSentMailboxId();
      const fileResponses = await this.jmapRequest([
        ['Email/set', {
          accountId,
          update: {
            [emailId]: {
              [`mailboxIds/${draftMailboxId}`]: null,
              [`mailboxIds/${sentMailboxId}`]: true,
              'keywords/$draft': null,
              'keywords/$seen': true,
            },
          },
        }, '0'],
      ], USING_MAIL);
      const fileResult = (fileResponses[0] as unknown[])[1] as { updated: Record<string, unknown> | null; notUpdated: Record<string, { type: string; description?: string }> | null };
      if (fileResult.notUpdated && Object.keys(fileResult.notUpdated).length > 0) {
        console.warn('[jmap] could not file submitted email into Sent:', JSON.stringify(fileResult.notUpdated));
      }
    } catch (fileError) {
      console.warn('[jmap] could not file submitted email into Sent:', fileError);
    }

    return { emailId, submissionId: sendInfo.id, sendAt: sendInfo.sendAt };
  }
}
