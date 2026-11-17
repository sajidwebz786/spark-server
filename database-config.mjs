const enabled = value => /^(true|1|require|verify-ca|verify-full)$/i.test(String(value || '').trim());

export function databaseConfig(env = process.env) {
  let url = env.DATABASE_URL?.trim();
  let parsed;
  if (url) {
    try { parsed = new URL(url); }
    catch { throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL.'); }
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error('DATABASE_URL must use postgres:// or postgresql://.');
  }
  const host = parsed?.hostname || env.DB_HOST || '';
  const onRender = env.RENDER === 'true' || Boolean(env.RENDER_SERVICE_ID);
  const renderHost = /(^|\.)[^.]*postgres\.render\.com$/i.test(host) || /^dpg-/i.test(host);
  const urlMode = parsed?.searchParams.get('sslmode')?.toLowerCase();
  const urlSsl = parsed?.searchParams.get('ssl');
  const sslRequired = onRender || enabled(env.DB_SSL) || enabled(env.PGSSLMODE) || enabled(urlMode) || enabled(urlSsl) || (renderHost && !/^(false|0|disable)$/i.test(env.DB_SSL || ''));
  const dialectOptions = {};
  if (sslRequired) {
    dialectOptions.ssl = { require: true, rejectUnauthorized: !/^(false|0)$/i.test(env.DB_SSL_REJECT_UNAUTHORIZED || ''), minVersion: 'TLSv1.2' };
    if (env.DB_SSL_CA) dialectOptions.ssl.ca = env.DB_SSL_CA.replace(/\\n/g, '\n');
    // Sequelize merges URL SSL flags over dialectOptions. Normalize these flags
    // here so they cannot disable TLS or erase the configured verification/CA.
    if (parsed && (parsed.searchParams.has('sslmode') || parsed.searchParams.has('ssl'))) {
      parsed.searchParams.delete('sslmode'); parsed.searchParams.delete('ssl');
      url = parsed.toString();
    }
  }
  return {
    url,
    options: { dialect: env.DB_DIALECT || 'postgres', dialectOptions, logging: false }
  };
}
