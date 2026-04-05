import type { BetHistoryRecord } from "../../types";

type Props = {
  selectedBet: BetHistoryRecord;
  onClose: () => void;
};

export default function BetHistoryModalContent({ selectedBet, onClose }: Props) {
  return (
    <>
      <div className="modal-head">
        <h3 id="bet-history-dialog-title">{selectedBet.result === "Won" ? "You Won" : "This Card Lost"}</h3>
        <button type="button" onClick={onClose}>
          x
        </button>
      </div>
      <p className="bet-result-amount">Amount : ETB {selectedBet.result === "Won" ? selectedBet.payout.toFixed(2) : selectedBet.game_winning.toFixed(2)}</p>
      {selectedBet.preview_card && (
        <article className="bingo-card compact history-card-preview">
          <h3>Card No. {selectedBet.preview_card.card_no}</h3>
          <div className="letters">
            <span>B</span>
            <span>I</span>
            <span>N</span>
            <span>G</span>
            <span>O</span>
          </div>
          <div className="grid">
            {selectedBet.preview_card.grid.flat().map((value, idx) => {
              const marked = typeof value === "number" && selectedBet.called_numbers.includes(value);
              return (
                <div key={`history-preview-${selectedBet.id}-${idx}`} className={`cell ${value === "FREE" ? "free" : ""} ${marked ? "marked" : ""}`}>
                  {value}
                </div>
              );
            })}
          </div>
        </article>
      )}
    </>
  );
}
