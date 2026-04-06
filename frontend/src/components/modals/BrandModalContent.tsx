type Props = {
  onClose: () => void;
};

export default function BrandModalContent({ onClose }: Props) {
  return (
    <>
      <div className="modal-head">
        <h3 id="brand-dialog-title">Quick Tips</h3>
        <button type="button" onClick={onClose} aria-label="Close dialog">
          &times;
        </button>
      </div>
      <div className="brand-modal-content">
        <article className="brand-promo">
          <h4>Room Holds Stay Stable</h4>
          <p>When you preview a cartella, it now stays reserved while the room screen is active instead of dropping too quickly.</p>
        </article>
        <article className="brand-promo">
          <h4>Use Verified Deposit Numbers</h4>
          <p>Copy only the Telebirr or CBE Birr numbers shown inside Wallet, then paste the full receipt text to help approval move faster.</p>
        </article>
        <article className="brand-promo">
          <h4>Sign In Faster</h4>
          <p>You can keep your phone number on this device for quicker sign-in, but passwords are cleared after every auth flow.</p>
        </article>
      </div>
      <button className="primary-btn" type="button" onClick={onClose}>
        Back to App
      </button>
    </>
  );
}
