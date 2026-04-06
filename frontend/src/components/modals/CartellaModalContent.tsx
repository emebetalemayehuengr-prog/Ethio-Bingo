import { memo, useMemo, type MouseEvent } from "react";
import type { BingoCard, RoomState, StakeOption } from "../../types";

const cartellaNumbers = Array.from({ length: 200 }, (_, idx) => idx + 1);

type CartellaStep = "pick" | "preview";

type Props = {
  loading: boolean;
  cartellaStep: CartellaStep;
  selectedStake: StakeOption | null;
  pickerRoom: RoomState | null;
  cardRechargeLabel: string;
  pickerPhase: "selecting" | "playing" | "finished";
  pickerCountdownValue: number;
  pickerLiveDetail: string;
  pickerPaidCount: number;
  paidCartellas: number[];
  simulatedPaidCartellas: number[];
  heldCartellas: number[];
  processingCartella: number | null;
  selectedCartella: number | null;
  preview: BingoCard | null;
  insufficientCardBalance: boolean;
  cardBuyAmount: number;
  working: boolean;
  onClose: () => void;
  onPreview: () => void;
  onConfirm: () => void;
  onBackToPick: () => void;
  onSelectCartella: (num: number) => void;
};

type CartellaCellProps = {
  number: number;
  paid: boolean;
  simulated: boolean;
  processing: boolean;
  selected: boolean;
  heldByOther: boolean;
  mineHeld: boolean;
  disabled: boolean;
};

const CartellaCell = memo(function CartellaCell({
  number,
  paid,
  simulated,
  processing,
  selected,
  heldByOther,
  mineHeld,
  disabled,
}: CartellaCellProps) {
  return (
    <button
      data-cartella={number}
      type="button"
      className={`cartella-cell ${paid ? "paid" : ""} ${simulated ? "simulated" : ""} ${processing ? "processing" : ""} ${selected ? "selected" : ""} ${heldByOther ? "held-other" : ""} ${mineHeld ? "held-mine" : ""}`}
      disabled={disabled}
    >
      {number}
    </button>
  );
});

export default function CartellaModalContent({
  loading,
  cartellaStep,
  selectedStake,
  pickerRoom,
  cardRechargeLabel,
  pickerPhase,
  pickerCountdownValue,
  pickerLiveDetail,
  pickerPaidCount,
  paidCartellas,
  simulatedPaidCartellas,
  heldCartellas,
  processingCartella,
  selectedCartella,
  preview,
  insufficientCardBalance,
  cardBuyAmount,
  working,
  onClose,
  onPreview,
  onConfirm,
  onBackToPick,
  onSelectCartella,
}: Props) {
  const paidSignature = paidCartellas.join(",");
  const simulatedSignature = simulatedPaidCartellas.join(",");
  const heldSignature = heldCartellas.join(",");
  const cellStates = useMemo(() => {
    const paidSet = new Set(paidCartellas);
    const simulatedSet = new Set(simulatedPaidCartellas);
    const heldSet = new Set(heldCartellas);
    const myHeldCartella = pickerRoom?.my_held_cartella ?? null;

    return cartellaNumbers.map((num) => {
      const paid = paidSet.has(num);
      const mineHeld = myHeldCartella === num;
      const held = heldSet.has(num);
      const heldByOther = held && !mineHeld;
      const simulated = simulatedSet.has(num);
      const processing = processingCartella === num || held;
      const selected = selectedCartella === num;
      return {
        number: num,
        paid,
        simulated,
        processing,
        selected,
        heldByOther,
        mineHeld,
        disabled: paid || heldByOther || working,
      };
    });
  }, [
    heldSignature,
    paidSignature,
    pickerRoom?.my_held_cartella,
    processingCartella,
    selectedCartella,
    simulatedSignature,
    working,
    paidCartellas,
    simulatedPaidCartellas,
    heldCartellas,
  ]);

  const handleGridClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    const button = target?.closest<HTMLButtonElement>("button[data-cartella]");
    if (!button || button.disabled) return;
    const nextCartella = Number(button.dataset.cartella);
    if (Number.isFinite(nextCartella)) {
      onSelectCartella(nextCartella);
    }
  };

  const buyLabel =
    working
      ? cartellaStep === "preview"
        ? "Paying..."
        : "Buying..."
      : insufficientCardBalance
        ? `Insufficient Balance (Need ETB ${cardBuyAmount})`
        : pickerRoom?.active_queue === "next"
          ? "Buy For Next Game"
          : "Buy Card";

  if (loading && !pickerRoom && cartellaStep === "pick") {
    return (
      <>
        <div className="modal-head">
          <h3 id="cartella-dialog-title">{selectedStake ? `${selectedStake.stake} Birr Current Game` : "Choose Cartella"}</h3>
          <button type="button" onClick={onClose} aria-label="Close dialog">
            &times;
          </button>
        </div>
        <div className="modal-skeleton modal-skeleton-grid">
          <p className="modal-skeleton-copy">Checking live cartella availability...</p>
          <div className="modal-skeleton-grid-blocks">
            {Array.from({ length: 24 }, (_, idx) => (
              <span key={`cartella-skeleton-${idx}`} className="modal-skeleton-block small" />
            ))}
          </div>
        </div>
      </>
    );
  }

  if (cartellaStep === "preview" && preview) {
    return (
      <>
        <div className="game-top-row compact">
          <div className={`countdown phase-${pickerRoom?.phase ?? "selecting"}`}>
            0:{String(Math.max(0, pickerCountdownValue)).padStart(2, "0")}
          </div>
          <div className="stake-chip">{selectedStake ? `${selectedStake.stake} Birr Per Card` : "0 Birr Per Card"}</div>
        </div>
        {cardRechargeLabel && <div className="modal-recharge-label">{cardRechargeLabel}</div>}
        <p className="panel-subtitle">Your selected cartella stays reserved while this room screen remains open.</p>
        <article className="bingo-card">
          <h3 id="cartella-dialog-title">Card No. {preview.card_no}</h3>
          <div className="letters">
            <span>B</span>
            <span>I</span>
            <span>N</span>
            <span>G</span>
            <span>O</span>
          </div>
          <div className="grid">
            {preview.grid.flat().map((value, idx) => (
              <div key={`preview-${value}-${idx}`} className={`cell ${value === "FREE" ? "free" : ""}`}>
                {value}
              </div>
            ))}
          </div>
        </article>
        <div className="modal-actions">
          <button className="secondary-btn" type="button" onClick={onBackToPick}>
            Choose Another Card
          </button>
          <button className={`primary-btn ${insufficientCardBalance ? "insufficient-buy-btn" : ""}`} type="button" disabled={working || insufficientCardBalance} onClick={onConfirm}>
            {buyLabel}
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="cartella-stage">
        <aside className="cartella-stage-ads" aria-hidden="true">
          <div className="cartella-ad">40bingo</div>
          <div className="cartella-ad alt">Held Cartellas</div>
        </aside>
        <section className="cartella-stage-main">
          <div className="modal-head">
            <h3 id="cartella-dialog-title">
              {selectedStake ? `${selectedStake.stake} Birr ${pickerRoom?.active_queue === "next" ? "Next Game Queue" : "Current Game"}` : "Choose Cartella"}
            </h3>
            <button type="button" onClick={onClose} aria-label="Close dialog">
              &times;
            </button>
          </div>
          {cardRechargeLabel && <div className="modal-recharge-label">{cardRechargeLabel}</div>}
          <p className="panel-subtitle">Pick an available cartella, preview it, then confirm payment only when you are happy with the card.</p>
          <div className="cartella-details-lines">
            <div className="cartella-details-line primary">
              <span className={`cartella-pill countdown phase-${pickerPhase}`}>0:{String(Math.max(0, pickerCountdownValue)).padStart(2, "0")}</span>
              <span className="cartella-pill stake">{selectedStake ? `${selectedStake.stake} Birr Per Card` : "0 Birr Per Card"}</span>
              <span className={`cartella-pill latest phase-${pickerPhase}`}>{pickerLiveDetail}</span>
            </div>
            <div className="cartella-details-line secondary">
              <span>
                <strong>{pickerRoom?.held_cartellas.length ?? 0}</strong> Held
              </span>
              <span>
                <strong>{pickerPaidCount}</strong> Paid
              </span>
              <span>
                <strong>200</strong> Total
              </span>
              <span>
                <strong>{pickerRoom?.my_cartellas.length ?? 0}</strong> My Current
              </span>
              <span>
                <strong>{pickerRoom?.next_my_cartellas.length ?? 0}</strong> My Next
              </span>
              <span className="legend-inline">W=available R=held B=paid G=sim</span>
            </div>
          </div>
          <div className="cartella-surface">
            <div className="cartella-grid" onClick={handleGridClick}>
              {cellStates.map((cell) => (
                <CartellaCell key={`c-${cell.number}`} {...cell} />
              ))}
            </div>
          </div>
          <div className="modal-actions">
            <button className="secondary-btn" type="button" onClick={onClose}>
              Back to Rooms
            </button>
            <button className="secondary-btn" type="button" onClick={onPreview} disabled={!selectedCartella || working}>
              {working ? "Loading..." : "Preview Card"}
            </button>
            <button className={`primary-btn ${insufficientCardBalance ? "insufficient-buy-btn" : ""}`} type="button" onClick={onConfirm} disabled={!selectedCartella || working || insufficientCardBalance}>
              {buyLabel}
            </button>
          </div>
        </section>
      </div>
    </>
  );
}
