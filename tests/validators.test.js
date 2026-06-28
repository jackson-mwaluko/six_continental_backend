import { describe, it, expect } from 'vitest';
import {
  loginSchema, registerSchema, stockMovementSchema, createTicketSchema,
} from '../src/validators/schemas.js';

describe('validation schemas', () => {
  it('accepts a valid login', () => {
    expect(loginSchema.body.safeParse({ email: 'a@b.com', password: 'x' }).success).toBe(true);
  });

  it('rejects an invalid email', () => {
    expect(loginSchema.body.safeParse({ email: 'not-an-email', password: 'x' }).success).toBe(false);
  });

  it('requires an 8+ character password on register', () => {
    const short = registerSchema.body.safeParse({ email: 'a@b.com', password: 'short', firstName: 'A', lastName: 'B' });
    expect(short.success).toBe(false);
  });

  it('rejects an invalid role on register', () => {
    const bad = registerSchema.body.safeParse({ email: 'a@b.com', password: 'longenough', firstName: 'A', lastName: 'B', role: 'KING' });
    expect(bad.success).toBe(false);
  });

  it('coerces and validates stock movement quantity', () => {
    const ok = stockMovementSchema.body.safeParse({ type: 'IN', quantity: '5' });
    expect(ok.success).toBe(true);
    expect(ok.data.quantity).toBe(5);
  });

  it('rejects a non-positive stock movement quantity', () => {
    expect(stockMovementSchema.body.safeParse({ type: 'OUT', quantity: '0' }).success).toBe(false);
  });

  it('rejects a movement with an unknown type', () => {
    expect(stockMovementSchema.body.safeParse({ type: 'SIDEWAYS', quantity: '1' }).success).toBe(false);
  });

  it('requires a title of at least 3 chars on a ticket', () => {
    expect(createTicketSchema.body.safeParse({ title: 'hi', description: 'x' }).success).toBe(false);
    expect(createTicketSchema.body.safeParse({ title: 'Laptop broken', description: 'x' }).success).toBe(true);
  });
});
