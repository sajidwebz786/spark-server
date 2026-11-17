import test from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize } from 'sequelize';
import { databaseConfig } from './database-config.mjs';

test('Render enables verified TLS without DB_SSL, for URL and individual fields', () => {
  for (const env of [{ RENDER: 'true', DATABASE_URL: 'postgres://user:password@database.example/db' }, { RENDER_SERVICE_ID: 'srv-example', DB_HOST: 'database.example' }]) {
    assert.equal(databaseConfig(env).options.dialectOptions.ssl.require, true);
    assert.equal(databaseConfig(env).options.dialectOptions.ssl.rejectUnauthorized, true);
  }
});

test('local PostgreSQL remains usable without TLS', () => {
  assert.deepEqual(databaseConfig({ DB_HOST: 'localhost' }).options.dialectOptions, {});
  assert.deepEqual(databaseConfig({ DATABASE_URL: 'postgres://user:password@127.0.0.1/db' }).options.dialectOptions, {});
});

test('Render TLS survives URL disabling flags and Sequelize URL parsing', () => {
  const config = databaseConfig({ RENDER: 'true', DB_SSL: 'false', DATABASE_URL: 'postgres://user:p%40ss@db.example:5432/hrms?sslmode=disable&ssl=0&application_name=hrms' });
  const sequelize = new Sequelize(config.url, config.options);
  assert.equal(sequelize.config.dialectOptions.ssl.require, true);
  assert.equal(sequelize.config.dialectOptions.ssl.rejectUnauthorized, true);
  assert.equal(sequelize.config.password, 'p@ss');
  assert.equal(sequelize.config.dialectOptions.application_name, 'hrms');
});

test('external Render hosts and explicit SSL settings enable TLS', () => {
  for (const env of [{ DB_HOST: 'dpg-example-a.oregon-postgres.render.com' }, { DATABASE_URL: 'postgres://u:p@db.example/db?sslmode=require' }, { DB_SSL: 'true', DB_HOST: 'remote.example' }]) assert.ok(databaseConfig(env).options.dialectOptions.ssl);
});

test('custom CA is supported and invalid URLs do not expose credentials', () => {
  assert.equal(databaseConfig({ DB_SSL: 'true', DB_SSL_CA: 'line1\\nline2' }).options.dialectOptions.ssl.ca, 'line1\nline2');
  const config = databaseConfig({ RENDER: 'true', DATABASE_URL: 'postgres://u:p@db.example/db?sslmode=require', DB_SSL_CA: 'custom-ca' });
  assert.equal(new Sequelize(config.url, config.options).config.dialectOptions.ssl.ca, 'custom-ca');
  assert.throws(() => databaseConfig({ DATABASE_URL: 'password-not-a-url' }), /must be a valid PostgreSQL/);
});
