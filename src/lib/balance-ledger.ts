import { randomUUID } from "crypto";
import type { Firestore, Transaction } from "firebase-admin/firestore";

export type BalanceMovementInput = {
  memberId: string;
  amount: number;
  reason: string;
  sourceKey: string;
  createdAt: Date;
  actorId?: string | null;
  actorName?: string | null;
  invoiceId?: string | null;
  eventId?: string | null;
  relatedInvoiceId?: string | null;
};

export function recordBalanceMovement(transaction: Transaction, db: Firestore, input: BalanceMovementInput) {
  if (!Number.isSafeInteger(input.amount)) throw new Error("餘額異動金額必須是安全整數");
  if (input.amount === 0) return;
  const id = randomUUID();
  transaction.create(db.collection("balanceMovements").doc(id), {
    id,
    memberId: input.memberId,
    amount: input.amount,
    reason: input.reason,
    sourceKey: input.sourceKey,
    createdAt: input.createdAt,
    actorId: input.actorId ?? null,
    actorName: input.actorName ?? null,
    invoiceId: input.invoiceId ?? null,
    eventId: input.eventId ?? null,
    relatedInvoiceId: input.relatedInvoiceId ?? null,
  });
}
