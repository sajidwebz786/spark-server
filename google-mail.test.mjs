import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoogleMail, googleMailSender, googleMailError } from './google-mail.mjs';
import { mailPreviewHtml } from '../web-portal/src/mail-preview.mjs';

test('invalid signing credentials return actionable errors without exposing assertions', () => {
  const failure = googleMailError(new Error('invalid_grant: Invalid signature for token: eyJ.secret.signature'));
  assert.equal(failure.statusCode, 502);
  assert.match(failure.message, /same active service-account JSON key/);
  assert.doesNotMatch(failure.message, /eyJ|secret/);
});

test('delegation errors describe both scopes and return a gateway failure', () => {
  const failure = googleMailError(new Error('unauthorized_client: access denied'));
  assert.equal(failure.statusCode, 502);
  assert.match(failure.message, /gmail.send/);
  assert.match(failure.message, /gmail.readonly/);
  const unrelated = new Error('Database unavailable');
  assert.equal(googleMailError(unrelated), unrelated);
});

test('browser mail preview resolves CID images without changing the stored email', () => {
  const mail = { html: '<img src="cid:spark-logo"><img src="cid:photo"><img src="cid:missing">', attachments: [{ contentId: '<photo>', contentType: 'image/png', content: 'aGVsbG8=' }] };
  const preview = mailPreviewHtml(mail);
  assert.match(preview, /src="\/logo.png"/);
  assert.match(preview, /data:image\/png;base64,aGVsbG8=/);
  assert.doesNotMatch(preview, /cid:/);
  assert.match(mail.html, /cid:spark-logo/);
});

test('Google mailbox overrides legacy sender and MIME preserves reply-to and attachments', async () => {
  let request;
  const mail = createGoogleMail({ env: { GOOGLE_MAIL_SENDER: 'hr@example.com', MAIL_FROM: 'legacy@example.com' }, gmail: {
    users: { messages: { send: async (value) => { request = value; } } }
  } });
  await mail.send({ to: 'candidate@gmail.com', from: 'admin@example.com', subject: 'Offer ✓', html: '<b>Hello</b>',
    attachments: [{ filename: 'offer.pdf', content: Buffer.from('pdf'), contentType: 'application/pdf' },
      { filename: 'logo.png', content: 'aGVsbG8=', encoding: 'base64', cid: 'spark-logo' }] });
  const mime = Buffer.from(request.requestBody.raw, 'base64url').toString();
  assert.match(mime, /From: HR Department <hr@example.com>/);
  assert.match(mime, /Reply-To: admin@example.com/);
  assert.match(mime, /To: candidate@gmail.com/);
  assert.match(mime, /filename=offer.pdf/);
  assert.match(mime, /Content-ID: <spark-logo>/);
  assert.equal(googleMailSender({ GOOGLE_MAIL_SENDER: 'hr@example.com', MAIL_FROM: 'old@example.com' }), 'hr@example.com');
});

test('inbox handles nested MIME, attachments, unread state and escapes plain text', async () => {
  let listRequest;
  const mail = createGoogleMail({ env: { GOOGLE_MAIL_SENDER: 'hr@example.com' }, gmail: { users: { messages: {
    list: async (r) => { listRequest = r; return { data: { messages: [{ id: '123' }] } }; },
    get: async () => ({ data: { id: '123', internalDate: '1700000000000', labelIds: ['INBOX', 'UNREAD'], payload: {
      headers: [{ name: 'From', value: 'Jane <jane@example.com>' }, { name: 'Subject', value: 'Reply' }],
      parts: [{ mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', body: { data: Buffer.from('<script> & hello').toString('base64url') } }] },
        { filename: 'cv.pdf', mimeType: 'application/pdf', body: { attachmentId: 'a1', size: 42 } }]
    } } })
  } } } });
  const [message] = await mail.inbox({ limit: 100 });
  assert.equal(listRequest.maxResults, 50);
  assert.equal(message.sourceMessageId, 'google:hr@example.com:123');
  assert.equal(message.from, 'jane@example.com');
  assert.equal(message.status, 'Unread');
  assert.equal(message.attachments[0].filename, 'cv.pdf');
  assert.equal(message.html, '<pre>&lt;script&gt; &amp; hello</pre>');
});

test('configuration and provider failures propagate instead of reporting success', async () => {
  await assert.rejects(createGoogleMail({ env: {} }).verify(), /GOOGLE_MAIL_SENDER/);
  const mail = createGoogleMail({ env: { GOOGLE_MAIL_SENDER: 'hr@example.com' }, gmail: { users: {
    getProfile: async () => { throw new Error('Delegation denied'); }
  } } });
  await assert.rejects(mail.verify(), /Delegation denied/);
});

test('Google attachment download uses the original provider message and attachment IDs', async () => {
  let requested;
  const mail = createGoogleMail({ env: { GOOGLE_MAIL_SENDER: 'hr@example.com' }, gmail: { users: { messages: { attachments: {
    get: async request => { requested = request; return { data: { data: Buffer.from('PDF bytes').toString('base64url') } }; }
  } } } } });
  assert.equal((await mail.attachment({ messageId: 'original-message', attachmentId: 'original-attachment' })).toString(), 'PDF bytes');
  assert.deepEqual(requested, { userId: 'me', messageId: 'original-message', id: 'original-attachment' });
});

test('Google inline attachment content is retained for browser previews', async () => {
  const mail = createGoogleMail({ env: { GOOGLE_MAIL_SENDER: 'hr@example.com' }, gmail: { users: { messages: {
    list: async () => ({ data: { messages: [{ id: 'inline' }] } }),
    get: async () => ({ data: { id: 'inline', payload: { parts: [
      { mimeType: 'text/html', body: { data: Buffer.from('<img src="cid:photo">').toString('base64url') } },
      { filename: 'photo.png', mimeType: 'image/png', headers: [{ name: 'Content-ID', value: '<photo>' }], body: { attachmentId: 'image', size: 5 } }
    ] } } }),
    attachments: { get: async () => ({ data: { data: Buffer.from('image').toString('base64url') } }) }
  } } } });
  const [message] = await mail.inbox();
  assert.equal(message.attachments[0].isInline, true);
  assert.equal(message.attachments[0].encoding, 'base64');
  assert.match(mailPreviewHtml(message), /data:image\/png;base64,aW1hZ2U=/);
});

test('Sent verification requires both the exact subject and Gmail SENT label', async () => {
  const mail = createGoogleMail({ env: { GOOGLE_MAIL_SENDER: 'hr@example.com' }, gmail: { users: { messages: {
    list: async request => { assert.deepEqual(request.labelIds, ['SENT']); assert.match(request.q, /to:candidate@gmail.com/); return { data: { messages: [{ id: 'valid' }, { id: 'unrelated' }] } }; },
    get: async ({ id }) => ({ data: { id, labelIds: ['SENT'], payload: { headers: [{ name: 'Subject', value: id === 'valid' ? 'Delivery test' : 'Different subject' }] } } })
  } } } });
  assert.deepEqual(await mail.findSent({ to: 'candidate@gmail.com', subject: 'Delivery test' }), [{ id: 'valid', status: 'Sent' }]);
});
