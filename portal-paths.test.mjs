import test from 'node:test';
import assert from 'node:assert/strict';
import { portalAsset, portalPathname } from '../web-portal/src/portal-paths.mjs';

test('MilesWeb assets resolve under hrms, including from deep links', () => {
  assert.equal(portalAsset('logo.png', '/hrms/'), '/hrms/logo.png');
  assert.equal(portalAsset('/logo.png', '/hrms'), '/hrms/logo.png');
  assert.equal(new URL(portalAsset('logo.png', '/hrms/'), 'https://www.sparkinfosol.com/hrms/candidate-onboarding/token').href, 'https://www.sparkinfosol.com/hrms/logo.png');
});

test('candidate links keep their route and token under the deployment base', () => {
  assert.equal(portalPathname('/hrms/candidate-test/12', '/hrms/'), '/candidate-test/12');
  assert.equal(portalPathname('/hrms/candidate-onboarding/token', '/hrms/'), '/candidate-onboarding/token');
  assert.equal(portalPathname('/hrms/', '/hrms/'), '/');
  assert.equal(portalPathname('/hrms', '/hrms/'), '/');
  assert.equal(portalPathname('/hrms-other/path', '/hrms/'), '/hrms-other/path');
});

test('existing root deployments and local development are preserved', () => {
  assert.equal(portalAsset('logo.png', '/'), '/logo.png');
  assert.equal(portalPathname('/candidate-test/12', '/'), '/candidate-test/12');
});
