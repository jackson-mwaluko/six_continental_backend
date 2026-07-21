import { describe, it, expect, beforeEach } from 'vitest';
import { isLocked, recordFailure, clearAttempts } from '../src/utils/loginGuard.js';

const EMAIL = 'lockme@test.local';

describe('loginGuard', () => {
  beforeEach(() => clearAttempts(EMAIL));

  it('does not lock before the threshold', () => {
    recordFailure(EMAIL);
    recordFailure(EMAIL);
    expect(isLocked(EMAIL)).toBe(false);
  });

  it('locks after 5 failures (default threshold)', () => {
    for (let i = 0; i < 5; i += 1) recordFailure(EMAIL);
    expect(isLocked(EMAIL)).toBe(true);
  });

  it('clears the lock when attempts are reset', () => {
    for (let i = 0; i < 5; i += 1) recordFailure(EMAIL);
    clearAttempts(EMAIL);
    expect(isLocked(EMAIL)).toBe(false);
  });
});
