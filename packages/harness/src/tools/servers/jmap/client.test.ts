import { test } from 'node:test';
import assert from 'node:assert';
import { JMAPClient } from './client.js';

// ── sendEmail: submitted draft must be filed into Sent by REAL id ───────────
//
// Regression guard for the 2026-09-27 drafts-accumulate bug: the old code
// filed the draft out of Drafts via a `#creation-key` back-reference in a
// follow-up Email/set within the same request — Fastmail returns notFound
// for those (live-probed), so every sent email stayed in Drafts forever.
// The fix: harvest the real email id from the create response, then file
// Drafts → Sent in a SECOND request.

const SESSION = {
  primaryAccounts: {
    'urn:ietf:params:jmap:mail': 'acc1',
    'urn:ietf:params:jmap:submission': 'acc1',
  },
  accounts: { acc1: { isPersonal: true, isReadOnly: false } },
  identities: [],
};

const MAILBOXES = [
  { id: 'M-inbox', name: 'Inbox', role: 'inbox' },
  { id: 'M-drafts', name: 'Drafts', role: 'drafts' },
  { id: 'M-sent', name: 'Sent', role: 'sent' },
];

test('sendEmail files the submitted draft into Sent via a second request with the real id', async () => {
  const apiCalls: Array<{ using: string[]; methodCalls: any[] }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    const urlStr = String(url);
    if (urlStr.includes('/session')) {
      return new Response(JSON.stringify(SESSION), { headers: { 'content-type': 'application/json' } });
    }
    const body = JSON.parse(init.body);
    apiCalls.push({ using: body.using, methodCalls: body.methodCalls });
    // one response per method call — a request can carry several
    const methodResponses = body.methodCalls.map(([method, params]: any, i: number) => {
      let result: any = null;
      if (method === 'Mailbox/get') {
        result = { list: MAILBOXES, notFound: [] };
      } else if (method === 'Identity/get') {
        result = { list: [{ id: 'id1', name: 'Sage', email: 'sage@test.example' }] };
      } else if (method === 'Email/set' && params.create) {
        result = { created: { draft: { id: 'REAL-EMAIL-ID', blobId: 'b1', size: 10, threadId: 't1' } }, notCreated: null };
      } else if (method === 'EmailSubmission/set') {
        result = { created: { send: { id: 'S1', sendAt: '2026-09-27T00:00:00Z', undoStatus: 'final' } }, notCreated: null };
      } else if (method === 'Email/set' && params.update) {
        result = { updated: { [Object.keys(params.update)[0]]: null }, notUpdated: null };
      }
      return [method, result, `c${i}`];
    });
    return new Response(JSON.stringify({ methodResponses }), {
      headers: { 'content-type': 'application/json' },
    });
  }) as any;

  try {
    const client = new JMAPClient({
      apiUrl: 'https://jmap.test/api',
      sessionUrl: 'https://jmap.test/session',
      token: 'TESTTOKEN',
    });
    const result = await client.sendEmail({ to: ['dest@test.example'], subject: 's', body: 'b' });
    assert.strictEqual(result.emailId, 'REAL-EMAIL-ID');

    // The filing call must be a SECOND API request, keyed by the real id.
    const apiRequests = apiCalls.filter(c => c.methodCalls.some(m => m[0] === 'Email/set'));
    const updateCalls = apiCalls.filter(c => {
      const [, params] = c.methodCalls.find(m => m[0] === 'Email/set' && m[1].update) ?? [null, null];
      return params?.update;
    });
    assert.strictEqual(updateCalls.length, 1, 'exactly one Email/set update (the filing request)');
    const updateParams = updateCalls[0].methodCalls.find(m => m[0] === 'Email/set')[1];
    const update = updateParams.update['REAL-EMAIL-ID'];
    assert.ok(update, 'update keyed by the REAL email id, not #draft');
    assert.strictEqual(update['mailboxIds/M-drafts'], null, 'removed from Drafts');
    assert.strictEqual(update['mailboxIds/M-sent'], true, 'filed into Sent');
    assert.strictEqual(update['keywords/$draft'], null, '$draft keyword dropped');
    assert.strictEqual(update['keywords/$seen'], true, 'marked seen');
  } finally {
    globalThis.fetch = realFetch;
  }
});
