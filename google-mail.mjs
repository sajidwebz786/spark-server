import fs from 'node:fs';
import path from 'node:path';
import { google } from 'googleapis';
import nodemailer from 'nodemailer';

export function googleMailSender(env = process.env) {
  return env.GOOGLE_MAIL_SENDER || env.MAIL_FROM || env.MAIL_USER || '';
}

export function googleMailError(error) {
  const reason = [error.message, error.response?.data?.error, error.response?.data?.error_description].filter(value => typeof value === 'string').join(' ');
  if (!/unauthorized_client/.test(reason)) return error;
  const failure = new Error('Google Workspace authorization failed. In Admin Console > Security > API controls > Domain-wide delegation, authorize the service account numeric client ID for BOTH https://www.googleapis.com/auth/gmail.send and https://www.googleapis.com/auth/gmail.readonly. Enable domain-wide delegation on the service account and confirm GOOGLE_MAIL_SENDER is an active, licensed Workspace Gmail mailbox.', { cause: error });
  failure.statusCode = 502;
  return failure;
}

export function createGoogleMail({ env = process.env, serverDir, gmail: suppliedClient } = {}) {
  const sender = googleMailSender(env);
  let client = suppliedClient;
  function gmail() {
    if (!sender) throw new Error('Set GOOGLE_MAIL_SENDER to the Google Workspace mailbox to impersonate.');
    if (client) return client;
    const credentials = env.GOOGLE_SERVICE_ACCOUNT_FILE
      ? JSON.parse(fs.readFileSync(path.resolve(serverDir, env.GOOGLE_SERVICE_ACCOUNT_FILE), 'utf8'))
      : { client_email: env.GOOGLE_CLIENT_EMAIL, private_key: env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n') };
    if (!credentials.client_email || !credentials.private_key) throw new Error('Google mail requires a service account file or GOOGLE_CLIENT_EMAIL and GOOGLE_PRIVATE_KEY.');
    const auth = new google.auth.JWT({ email: credentials.client_email, key: credentials.private_key,
      scopes: ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.readonly'], subject: sender });
    client = google.gmail({ version: 'v1', auth });
    return client;
  }
  return {
    sender,
    async findSent({ to, subject }) {
      const querySubject = String(subject).replace(/["\\]/g, ' ');
      const api = gmail();
      const { data } = await api.users.messages.list({ userId: 'me', labelIds: ['SENT'], q: `to:${to} subject:"${querySubject}"`, maxResults: 10 });
      const matches = [];
      for (const item of data.messages || []) {
        const { data: message } = await api.users.messages.get({ userId: 'me', id: item.id, format: 'metadata', metadataHeaders: ['Subject', 'To'] });
        const actualSubject = message.payload?.headers?.find(header => header.name.toLowerCase() === 'subject')?.value;
        if (actualSubject === subject && message.labelIds?.includes('SENT')) matches.push({ id: message.id, status: 'Sent' });
      }
      return matches;
    },
    async attachment({ messageId, attachmentId }) {
      try {
        const { data } = await gmail().users.messages.attachments.get({ userId: 'me', messageId, id: attachmentId });
        return Buffer.from(data.data || '', 'base64url');
      } catch (error) { throw googleMailError(error); }
    },
    async verify() {
      let data;
      try { ({ data } = await gmail().users.getProfile({ userId: 'me' })); }
      catch (error) {
        throw googleMailError(error);
      }
      return { emailAddress: data.emailAddress, canSend: true, canReadInbox: true };
    },
    async send({ to, subject, html, from, attachments = [] }) {
      const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows' });
      const { message } = await transport.sendMail({
        from: { name: env.GOOGLE_MAIL_FROM_NAME || env.COMPANY_NAME || 'HR Department', address: sender },
        replyTo: from || undefined, to, subject, html,
        attachments: attachments.map((a) => ({ filename: a.filename, content: a.content, encoding: a.encoding, contentType: a.contentType, cid: a.cid || a.contentId }))
      });
      return gmail().users.messages.send({ userId: 'me', requestBody: { raw: message.toString('base64url') } }).catch(error => { throw googleMailError(error); });
    },
    async inbox({ limit = 25 } = {}) {
      const api = gmail();
      const { data } = await api.users.messages.list({ userId: 'me', labelIds: ['INBOX'], maxResults: Math.min(Math.max(Number(limit) || 25, 1), 50) });
      const messages = [];
      for (const item of data.messages || []) {
        const { data: msg } = await api.users.messages.get({ userId: 'me', id: item.id, format: 'full' });
        const header = (name) => msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';
        const attachments = [], html = [], plain = [], inlineParts = [];
        function visit(part) {
          const cid = part.headers?.find(h => h.name.toLowerCase() === 'content-id')?.value?.replace(/^<|>$/g, '');
          if (part.filename || cid) {
            const attachment = { id: part.body?.attachmentId, filename: part.filename, contentType: part.mimeType, size: part.body?.size || 0, cid };
            attachments.push(attachment);
            if (part.body?.data) {
              attachment.content = Buffer.from(part.body.data, 'base64url').toString('base64');
              attachment.encoding = 'base64';
            }
            if (cid && /^image\/(png|jpeg|gif|webp)$/i.test(part.mimeType) && attachment.size <= 2 * 1024 * 1024) inlineParts.push({ part, attachment });
          }
          else if (part.body?.data) {
            const body = Buffer.from(part.body.data, 'base64url').toString('utf8');
            if (part.mimeType === 'text/html') html.push(body);
            if (part.mimeType === 'text/plain') plain.push(body);
          }
          for (const child of part.parts || []) visit(child);
        }
        visit(msg.payload || {});
        for (const { part, attachment } of inlineParts) {
          const data = part.body?.data || (attachment.id ? (await api.users.messages.attachments.get({ userId: 'me', messageId: msg.id, id: attachment.id })).data.data : '');
          if (data && data.length <= 2800000) {
            attachment.content = Buffer.from(data, 'base64url').toString('base64');
            attachment.encoding = 'base64';
            attachment.isInline = true;
          }
        }
        const from = header('From');
        const escaped = plain.join('\n').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        messages.push({ sourceMessageId: `google:${sender}:${msg.id}`, to: header('To') || sender,
          from: from.match(/<([^>]+)>/)?.[1] || from, fromName: from.includes('<') ? from.split('<')[0].trim().replace(/^"|"$/g, '') : '',
          toName: header('To'), subject: header('Subject') || '(No subject)', html: html.join('\n') || `<pre>${escaped}</pre>`,
          attachments, status: msg.labelIds?.includes('UNREAD') ? 'Unread' : 'Received',
          createdAt: msg.internalDate ? new Date(Number(msg.internalDate)) : new Date() });
      }
      return messages;
    }
  };
}

