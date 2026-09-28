// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'bun:test';
import { hasRequiredScopes } from '../../../src/server/middleware/postgres-auth.js';
import { HOOK_API_KEY_SCOPES } from '../../../src/services/hooks/server-bootstrap.js';

describe('hasRequiredScopes', () => {
  it('requires every canonical scope without an alias', () => {
    expect(hasRequiredScopes(['memories:read'], ['memories:write'])).toBe(false);
    expect(hasRequiredScopes(['memories:write'], ['memories:write'])).toBe(true);
    expect(hasRequiredScopes(['*'], ['memories:write'])).toBe(true);
    expect(hasRequiredScopes([], [])).toBe(true);
  });

  it('accepts the route alias in place of the canonical scope', () => {
    expect(hasRequiredScopes(['events:write'], ['memories:write'], 'events:write')).toBe(true);
    expect(hasRequiredScopes(['jobs:read'], ['memories:read'], 'jobs:read')).toBe(true);
  });

  it('does not accept a different installer scope than the route alias', () => {
    expect(hasRequiredScopes(['observations:read'], ['memories:write'], 'events:write')).toBe(false);
    expect(hasRequiredScopes(['events:write'], ['memories:read'], 'observations:read')).toBe(false);
  });

  it('keeps installer keys out of routes that have no alias', () => {
    expect(hasRequiredScopes([...HOOK_API_KEY_SCOPES], ['memories:write'])).toBe(false);
    expect(hasRequiredScopes([...HOOK_API_KEY_SCOPES], ['memories:read'])).toBe(false);
  });
});
