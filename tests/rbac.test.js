import { describe, it, expect, vi } from 'vitest';
import { ROLE_RANK, authorize, minRole } from '../src/middleware/rbac.js';

const run = (mw, role) => {
  const next = vi.fn();
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  mw({ user: { role } }, res, next);
  return { next, res };
};

describe('ROLE_RANK', () => {
  it('orders roles from employee up to super admin', () => {
    expect(ROLE_RANK.EMPLOYEE).toBeLessThan(ROLE_RANK.DEPARTMENT_MANAGER);
    expect(ROLE_RANK.DEPARTMENT_MANAGER).toBeLessThan(ROLE_RANK.ICT_TECHNICIAN);
    expect(ROLE_RANK.ICT_TECHNICIAN).toBeLessThan(ROLE_RANK.ICT_ADMIN);
    expect(ROLE_RANK.ICT_ADMIN).toBeLessThan(ROLE_RANK.SUPER_ADMIN);
  });
});

describe('minRole', () => {
  it('allows a role at or above the threshold', () => {
    const { next } = run(minRole('ICT_TECHNICIAN'), 'ICT_ADMIN');
    expect(next).toHaveBeenCalledWith();
  });

  it('blocks a role below the threshold', () => {
    const { next } = run(minRole('ICT_TECHNICIAN'), 'EMPLOYEE');
    const calledWithError = next.mock.calls[0]?.[0];
    expect(calledWithError).toBeTruthy(); // forwarded an ApiError
  });
});

describe('authorize', () => {
  it('allows an explicitly listed role', () => {
    const { next } = run(authorize('SUPER_ADMIN', 'ICT_ADMIN'), 'ICT_ADMIN');
    expect(next).toHaveBeenCalledWith();
  });

  it('blocks a role not in the list', () => {
    const { next } = run(authorize('SUPER_ADMIN'), 'EMPLOYEE');
    expect(next.mock.calls[0]?.[0]).toBeTruthy();
  });
});
