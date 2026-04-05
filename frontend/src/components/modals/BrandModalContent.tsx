type Props = {
  onClose: () => void;
};

export default function BrandModalContent({ onClose }: Props) {
  return (
    <>
      <div className="modal-head">
        <h3 id="brand-dialog-title">40bingo Updates</h3>
        <button type="button" onClick={onClose}>
          x
        </button>
      </div>
      <div className="brand-modal-content">
        <article className="brand-promo">
          <h4>Prize Structure</h4>
          <p>Join any stake room and play live with fair payouts. House commission remains fixed at 15%.</p>
        </article>
        <article className="brand-promo">
          <h4>Safe Deposit</h4>
          <p>Use only verified Telebirr/CBE transfer accounts listed in wallet. Duplicate receipts are blocked automatically.</p>
        </article>
      </div>
      <button className="primary-btn" type="button" onClick={onClose}>
        Continue
      </button>
    </>
  );
}
