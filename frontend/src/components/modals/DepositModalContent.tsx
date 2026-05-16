import type { FormEvent } from "react";
import type { DepositMethod } from "../../types";

type DraftAccount = { phone_number: string; owner_name: string };
type DepositFieldErrors = Partial<Record<"depositAmount" | "txNo" | "receiptMessage", string>>;

type Props = {
  selectedMethod: DepositMethod | null;
  selectedMethodDraftAccounts: DraftAccount[];
  isAdmin: boolean;
  copiedPhone: string;
  adminWorking: boolean;
  submitWorking: boolean;
  fieldErrors: DepositFieldErrors;
  depositAmount: string;
  txNo: string;
  receiptMessage: string;
  onClose: () => void;
  onCopyPhone: (phone: string) => void;
  onDraftPhoneChange: (idx: number, value: string) => void;
  onDraftOwnerChange: (idx: number, value: string) => void;
  onRemoveDraftAccount: (idx: number) => void;
  onAddDraftAccount: () => void;
  onSaveAccounts: (methodCode: "telebirr" | "cbebirr") => void;
  onDepositAmountChange: (value: string) => void;
  onTxChange: (value: string) => void;
  onTxBlur: (value: string) => void;
  onReceiptChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

export default function DepositModalContent({
  selectedMethod,
  selectedMethodDraftAccounts,
  isAdmin,
  copiedPhone,
  adminWorking,
  submitWorking,
  fieldErrors,
  depositAmount,
  txNo,
  receiptMessage,
  onClose,
  onCopyPhone,
  onDraftPhoneChange,
  onDraftOwnerChange,
  onRemoveDraftAccount,
  onAddDraftAccount,
  onSaveAccounts,
  onDepositAmountChange,
  onTxChange,
  onTxBlur,
  onReceiptChange,
  onSubmit,
}: Props) {
  const formBusy = adminWorking || submitWorking;
  return (
    <>
      <div className="modal-head">
        <h3 id="deposit-dialog-title">{selectedMethod?.label ?? "Deposit"}</h3>
        <button type="button" onClick={onClose} aria-label="Close dialog">
          &times;
        </button>
      </div>
      {selectedMethod ? (
        <>
          {selectedMethod.logo_url ? (
            <img
              className="deposit-provider-logo"
              src={selectedMethod.logo_url}
              alt={`${selectedMethod.label} logo`}
              onError={(event) => {
                const target = event.currentTarget;
                if (target.dataset.fallbackApplied === "1") return;
                target.dataset.fallbackApplied = "1";
                target.src = selectedMethod.code === "telebirr" ? "/providers/telebirr.svg" : "/providers/cbebirr.png";
              }}
            />
          ) : null}
          <p className="panel-subtitle">
            Send your payment to one of the verified account numbers below, then paste the receipt message exactly as it appears so approval can happen faster.
          </p>
          <ol>
            {selectedMethod.instruction_steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <div className="accounts">
            {isAdmin
              ? selectedMethodDraftAccounts.map((account, idx) => (
                  <div key={`${selectedMethod.code}-draft-${idx}`} className="account-box admin-edit">
                    <input value={account.phone_number} onChange={(event) => onDraftPhoneChange(idx, event.target.value)} placeholder="09XXXXXXXX" />
                    <input value={account.owner_name} onChange={(event) => onDraftOwnerChange(idx, event.target.value)} placeholder="Account owner name" />
                    <div className="admin-inline-actions">
                      <button className="secondary-btn copy-btn" type="button" disabled={!account.phone_number.trim()} onClick={() => onCopyPhone(account.phone_number.trim())}>
                        {copiedPhone === account.phone_number.trim() ? "Copied" : "Copy"}
                      </button>
                      <button className="secondary-btn" type="button" onClick={() => onRemoveDraftAccount(idx)}>
                        Remove
                      </button>
                    </div>
                  </div>
                ))
              : selectedMethod.transfer_accounts.map((account) => (
                  <div key={`${selectedMethod.code}-${account.phone_number}`} className="account-box">
                    <span>{account.phone_number}</span>
                    <small>{account.owner_name}</small>
                    <button className="secondary-btn copy-btn" type="button" onClick={() => onCopyPhone(account.phone_number)}>
                      {copiedPhone === account.phone_number ? "Copied" : "Copy"}
                    </button>
                  </div>
                ))}
          </div>
          {isAdmin && (
            <div className="deposit-admin-actions">
              <button className="secondary-btn" type="button" onClick={onAddDraftAccount}>
                Add Account
              </button>
              <button className="primary-btn" type="button" disabled={formBusy} onClick={() => onSaveAccounts(selectedMethod.code)}>
                {adminWorking ? "Saving..." : submitWorking ? "Adding Balance..." : "Save Accounts"}
              </button>
            </div>
          )}
          <form className="wallet-form" onSubmit={onSubmit}>
            <label>
              Amount
              <input
                type="number"
                min={1}
                value={depositAmount}
                aria-invalid={Boolean(fieldErrors.depositAmount)}
                className={fieldErrors.depositAmount ? "input-error" : undefined}
                onChange={(event) => onDepositAmountChange(event.target.value)}
              />
              {fieldErrors.depositAmount ? (
                <small className="wallet-field-error" role="alert">
                  {fieldErrors.depositAmount}
                </small>
              ) : null}
            </label>
            <label>
              Transaction Number
              <input
                value={txNo}
                inputMode="text"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                aria-invalid={Boolean(fieldErrors.txNo)}
                className={fieldErrors.txNo ? "input-error" : undefined}
                onChange={(event) => onTxChange(event.target.value)}
                onBlur={(event) => onTxBlur(event.target.value)}
              />
              {fieldErrors.txNo ? (
                <small className="wallet-field-error" role="alert">
                  {fieldErrors.txNo}
                </small>
              ) : null}
            </label>
            <label>
              Receipt Message
              <textarea
                required
                rows={5}
                value={receiptMessage}
                placeholder={`Paste the payment SMS or receipt text here. Example transaction number: ${selectedMethod.receipt_example}`}
                spellCheck={false}
                aria-invalid={Boolean(fieldErrors.receiptMessage)}
                className={fieldErrors.receiptMessage ? "input-error" : undefined}
                onChange={(event) => onReceiptChange(event.target.value)}
              />
              {fieldErrors.receiptMessage ? (
                <small className="wallet-field-error" role="alert">
                  {fieldErrors.receiptMessage}
                </small>
              ) : null}
            </label>
            <small className="receipt-tip">If the transaction number appears inside the receipt text, we will try to fill it automatically.</small>
            <small>Use the same phone number and account name that appear on your payment receipt whenever possible.</small>
            <button className="primary-btn" type="submit" disabled={formBusy}>
              {submitWorking ? "Adding Balance..." : "Submit Deposit"}
            </button>
          </form>
        </>
      ) : (
        <div className="modal-skeleton">
          <p className="modal-skeleton-copy">Loading deposit instructions...</p>
          <div className="modal-skeleton-stack">
            {Array.from({ length: 5 }, (_, idx) => (
              <span key={`deposit-skeleton-${idx}`} className="modal-skeleton-block" />
            ))}
          </div>
        </div>
      )}
    </>
  );
}
