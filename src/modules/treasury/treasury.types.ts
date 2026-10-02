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

/**
 * A cheque in the treasury: null until a manager marks it. CLEARED moves it to the bank,
 * BOUNCED takes it out of the treasury and puts the amount back on the customer's debt.
 */
export enum ChequeStatus {
  CLEARED = 'CLEARED',
  BOUNCED = 'BOUNCED',
}

/** Shared schema fields for invoices (up-front payment) and collections. */
export const depositFields = {
  depositStatus: { type: String, enum: [...Object.values(DepositStatus), null], default: null },
  deposit: { type: Schema.Types.ObjectId, ref: 'Deposit', default: null },
  depositedAt: { type: Date, default: null },
  chequeStatus: { type: String, enum: [...Object.values(ChequeStatus), null], default: null },
  chequeStatusAt: { type: Date, default: null },
  chequeStatusBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
} as const;

/** Money leaving the treasury box. BANK_DEPOSIT only moves it to the bank (total unchanged). */
export enum TreasuryEntryType {
  EXPENSE = 'EXPENSE', // مصروف
  WITHDRAWAL = 'WITHDRAWAL', // سحب (صاحب الشركة)
  BANK_DEPOSIT = 'BANK_DEPOSIT', // إيداع في البنك
}

export enum TreasuryEntryStatus {
  ACTIVE = 'ACTIVE',
  CANCELLED = 'CANCELLED',
}
