import { Schema } from 'mongoose';

/**
 * Where money received from a customer is. A rep's money stays PENDING (in the rep's cash box)
 * until a manager records the handover; only then does it reduce the customer's debt.
 * Money a manager records directly is DEPOSITED at once. Documents written before this
 * field existed have no value and count as DEPOSITED.
 */
export enum DepositStatus {
  PENDING = 'PENDING',
  DEPOSITED = 'DEPOSITED',
}

/** Shared schema fields for invoices (up-front payment) and collections. */
export const depositFields = {
  depositStatus: { type: String, enum: [...Object.values(DepositStatus), null], default: null },
  deposit: { type: Schema.Types.ObjectId, ref: 'Deposit', default: null },
  depositedAt: { type: Date, default: null },
} as const;
