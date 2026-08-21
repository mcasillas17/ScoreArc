import { describe, expect, it } from 'vitest';
import { apiError } from './errorResponse';

describe('apiError', () => {
  it.each([
    ['INVALID_REQUEST', 400],
    ['NOT_FOUND', 404],
    ['UPSTREAM_UNAVAILABLE', 502],
  ] as const)('returns only the stable %s code at status %s', async (code, status) => {
    const response = apiError(code, status);

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: { code } });
  });
});
