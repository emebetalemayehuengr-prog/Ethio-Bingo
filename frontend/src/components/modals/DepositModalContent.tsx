import type { FormEvent } from "react";
import type { DepositMethod } from "../../types";

type DraftAccount = { phone_number: string; owner_name: string };

type Props = {
  selectedMethod: DepositMethod | null;
  selectedMethodDraftAccounts: DraftAccount[];
  isAdmin: boolean;
  copiedPhone: string;
  working: boolean;
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
  working,
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
  return (
    <>
      <div className="modal-head">
        <h3 id="deposit-dialog-title">{selectedMethod?.label ?? "Deposit"}</h3>
        <button type="button" onClick={onClose}>
          x
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
          <p className="panel-subtitle">ከዚህ በታች ያሉትን ደረጃዎች ይከተሉ እና የተቀበለውን ደረሰታ መረጃ ያስገቡ። የተቀበለው መለያ ከተመደቡት ሰራተኛ ጋር ይረጋገጣል።</p>
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
                    <input value={account.owner_name} onChange={(event) => onDraftOwnerChange(idx, event.target.value)} placeholder="የባለሙያ ስም" />
                    <div className="admin-inline-actions">
                      <button className="secondary-btn copy-btn" type="button" disabled={!account.phone_number.trim()} onClick={() => onCopyPhone(account.phone_number.trim())}>
                        {copiedPhone === account.phone_number.trim() ? "ተቀድቷል" : "ኮፒ"}
                      </button>
                      <button className="secondary-btn" type="button" onClick={() => onRemoveDraftAccount(idx)}>
                        አስወግድ
                      </button>
                    </div>
                  </div>
                ))
              : selectedMethod.transfer_accounts.map((account) => (
                  <div key={`${selectedMethod.code}-${account.phone_number}`} className="account-box">
                    <span>{account.phone_number}</span>
                    <small>{account.owner_name}</small>
                    <button className="secondary-btn copy-btn" type="button" onClick={() => onCopyPhone(account.phone_number)}>
                      {copiedPhone === account.phone_number ? "ተቀድቷል" : "ኮፒ"}
                    </button>
                  </div>
                ))}
          </div>
          {isAdmin && (
            <div className="deposit-admin-actions">
              <button className="secondary-btn" type="button" onClick={onAddDraftAccount}>
                ቁጥር ይጨምሩ
              </button>
              <button className="primary-btn" type="button" disabled={working} onClick={() => onSaveAccounts(selectedMethod.code)}>
                {working ? "በማስቀመጥ ላይ..." : "ቁጥሮችን ያስቀምጡ"}
              </button>
            </div>
          )}
          <form className="wallet-form" onSubmit={onSubmit}>
            <label>
              መጠን
              <input type="number" min={1} value={depositAmount} onChange={(event) => onDepositAmountChange(event.target.value)} />
            </label>
            <label>
              የግብይት ቁጥር
              <input
                value={txNo}
                inputMode="text"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                onChange={(event) => onTxChange(event.target.value)}
                onBlur={(event) => onTxBlur(event.target.value)}
              />
            </label>
            <label>
              መልእክኛ
              <textarea
                required
                rows={5}
                value={receiptMessage}
                placeholder="የክፍያ ኤስኤምኤስ ወይም የደረሰታ መልእክኛ እዚህ ያስገቡ"
                spellCheck={false}
                onChange={(event) => onReceiptChange(event.target.value)}
              />
            </label>
            <small className="receipt-tip">ከደረሰታው የግብይት ቁጥር በሚቻልበት ጊዜ በራሱ እንዲገኝ እናደርጋለን።</small>
            <small>የደረሰታ መልእክኛ አንድ የተመደበ የተቀበለው ስልክ ቁጥር ወይም የባለሙያ ስም መስገል አለበት።</small>
            <button className="primary-btn" type="submit" disabled={working}>
              {working ? "በማስገባት ላይ..." : "ክፍያን ያስገቡ"}
            </button>
          </form>
        </>
      ) : (
        <div className="modal-skeleton">
          <p className="modal-skeleton-copy">የክፍያ መመሪያዎችን በማስቀመጥ ላይ...</p>
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
