export type DepositProvider = "telebirr" | "cbebirr";
export type DepositStatus = "pending" | "approved" | "rejected";

export interface DepositRequestInput {
  userId: string;
  provider: DepositProvider;
  submittedAmountEtb: number;
  txReference: string;
  smsOrLink?: string;
}

export interface DepositApprovalInput {
  requestId: string;
  adminUserId: string;
  approvedAmountEtb: number;
  note?: string;
}

export interface ManualDepositRepo {
  createPendingDeposit(input: DepositRequestInput): Promise<{ id: string }>;
  approveDeposit(input: DepositApprovalInput): Promise<void>;
  rejectDeposit(input: { requestId: string; adminUserId: string; note?: string }): Promise<void>;
}

export class ManualDepositService {
  constructor(private readonly repo: ManualDepositRepo) {}

  submit(input: DepositRequestInput) {
    if (input.submittedAmountEtb <= 0) throw new Error("Amount must be greater than zero");
    if (input.txReference.trim().length < 5) throw new Error("Invalid transaction reference");
    return this.repo.createPendingDeposit(input);
  }

  approve(input: DepositApprovalInput) {
    if (input.approvedAmountEtb <= 0) throw new Error("Approved amount must be greater than zero");
    return this.repo.approveDeposit(input);
  }

  reject(requestId: string, adminUserId: string, note?: string) {
    return this.repo.rejectDeposit({ requestId, adminUserId, note });
  }
}
