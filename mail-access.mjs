export function canReadMail(mail, user) {
  if (!mail || !user) return false;
  if (user.role !== 'Employee') return true;
  const address = String(user.email || '').trim().toLowerCase();
  const addresses = [mail.from, mail.to].flatMap(value => String(value || '').split(/[,;]/)).map(value => (value.match(/<([^>]+)>/)?.[1] || value).trim().toLowerCase());
  return !!address && addresses.includes(address);
}

export function attachmentBytes(attachment) {
  if (!attachment || typeof attachment.content !== 'string') return null;
  return Buffer.from(attachment.content, attachment.encoding === 'base64' ? 'base64' : 'utf8');
}
