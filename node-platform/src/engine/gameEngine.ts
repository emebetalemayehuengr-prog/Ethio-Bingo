export const SUPPORTED_CARD_PRICES = [10, 20, 50, 100, 1000] as const;

export type RoundState = "joining" | "playing" | "finished" | "cancelled";

export interface RoundSnapshot {
  id: string;
  roomId: string;
  state: RoundState;
  cardPriceEtb: number;
  grossSalesEtb: number;
}

export interface CalledNumber {
  callSeq: number;
  number: number;
  calledAt: Date;
}

export interface ClaimInput {
  roundId: string;
  userId: string;
  cardId: string;
  claimedAt?: Date;
}

export interface ValidClaim {
  userId: string;
  cardId: string;
}

export interface ClaimResult {
  accepted: boolean;
  reason?: string;
  graceEndsAt?: Date;
}

export interface GameRepository {
  getRound(roundId: string): Promise<RoundSnapshot | null>;
  transitionToPlaying(roundId: string, at: Date): Promise<void>;
  nextRandomCall(roundId: string, at: Date): Promise<CalledNumber | null>;
  getLastCall(roundId: string): Promise<CalledNumber | null>;
  listCalledNumbers(roundId: string): Promise<number[]>;
  validateCardClaim(roundId: string, cardId: string, calledNumbers: number[]): Promise<boolean>;
  recordClaim(input: {
    roundId: string;
    userId: string;
    cardId: string;
    forCallSeq: number;
    claimWindowEndsAt: Date;
    isValid: boolean;
    createdAt: Date;
  }): Promise<void>;
  listValidClaimsForCall(roundId: string, callSeq: number): Promise<ValidClaim[]>;
  finishRoundWithSettlement(input: {
    roundId: string;
    winnerCount: number;
    payoutEachEtb: number;
    prizePoolEtb: number;
    commissionEtb: number;
    winners: ValidClaim[];
    settledAt: Date;
  }): Promise<void>;
}

export type Broadcaster = (roomId: string, event: string, payload: unknown) => void;

const CALL_INTERVAL_MS = 5000;
const CLAIM_GRACE_MS = 2000;
const COMMISSION_RATE = 0.15;

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

export class BingoGameEngine {
  private callLoops = new Map<string, NodeJS.Timeout>();
  private graceTimers = new Map<string, NodeJS.Timeout>();
  private activeGraceCall = new Map<string, number>();

  constructor(private readonly repo: GameRepository, private readonly broadcast: Broadcaster) {}

  async startRound(roundId: string): Promise<void> {
    const round = await this.repo.getRound(roundId);
    if (!round) throw new Error("Round not found");
    if (round.state !== "joining") throw new Error("Round is not in joining phase");

    const now = new Date();
    await this.repo.transitionToPlaying(roundId, now);
    this.broadcast(round.roomId, "round:started", { roundId, startedAt: now.toISOString() });

    await this.callNumber(roundId);

    const timer = setInterval(() => {
      void this.callNumber(roundId);
    }, CALL_INTERVAL_MS);
    this.callLoops.set(roundId, timer);
  }

  async joinGuard(roundId: string): Promise<void> {
    const round = await this.repo.getRound(roundId);
    if (!round) throw new Error("Round not found");
    if (round.state !== "joining") throw new Error("Joining phase closed");
  }

  async submitClaim(input: ClaimInput): Promise<ClaimResult> {
    const now = input.claimedAt ?? new Date();
    const round = await this.repo.getRound(input.roundId);
    if (!round) return { accepted: false, reason: "round_not_found" };
    if (round.state !== "playing") return { accepted: false, reason: "round_not_playing" };

    const lastCall = await this.repo.getLastCall(input.roundId);
    if (!lastCall) return { accepted: false, reason: "no_called_numbers_yet" };

    const graceEndsAt = new Date(lastCall.calledAt.getTime() + CLAIM_GRACE_MS);
    if (now.getTime() > graceEndsAt.getTime()) {
      return { accepted: false, reason: "claim_window_closed" };
    }

    const called = await this.repo.listCalledNumbers(input.roundId);
    const isValid = await this.repo.validateCardClaim(input.roundId, input.cardId, called);

    await this.repo.recordClaim({
      roundId: input.roundId,
      userId: input.userId,
      cardId: input.cardId,
      forCallSeq: lastCall.callSeq,
      claimWindowEndsAt: graceEndsAt,
      isValid,
      createdAt: now,
    });

    if (!isValid) return { accepted: false, reason: "invalid_bingo_card" };

    const activeCallSeq = this.activeGraceCall.get(input.roundId);
    if (activeCallSeq !== lastCall.callSeq) {
      this.activeGraceCall.set(input.roundId, lastCall.callSeq);
      const delay = Math.max(0, graceEndsAt.getTime() - now.getTime());
      const timer = setTimeout(() => {
        void this.finalizeClaims(input.roundId, lastCall.callSeq);
      }, delay);
      this.graceTimers.set(input.roundId, timer);
    }

    return { accepted: true, graceEndsAt };
  }

  private async callNumber(roundId: string): Promise<void> {
    const round = await this.repo.getRound(roundId);
    if (!round || round.state !== "playing") {
      this.stopRoundLoop(roundId);
      return;
    }

    const call = await this.repo.nextRandomCall(roundId, new Date());
    if (!call) {
      this.stopRoundLoop(roundId);
      return;
    }

    this.broadcast(round.roomId, "number:called", {
      roundId,
      callSeq: call.callSeq,
      number: call.number,
      calledAt: call.calledAt.toISOString(),
      claimGraceMs: CLAIM_GRACE_MS,
    });
  }

  private async finalizeClaims(roundId: string, callSeq: number): Promise<void> {
    this.graceTimers.delete(roundId);

    const round = await this.repo.getRound(roundId);
    if (!round || round.state !== "playing") return;

    const winners = await this.repo.listValidClaimsForCall(roundId, callSeq);
    if (winners.length === 0) return;

    this.stopRoundLoop(roundId);

    const gross = round2(round.grossSalesEtb);
    const baseCommission = round2(gross * COMMISSION_RATE);
    const prizePool = round2(gross - baseCommission);
    const payoutEach = round2(prizePool / winners.length);
    const distributed = round2(payoutEach * winners.length);
    const remainder = round2(prizePool - distributed);
    const commission = round2(baseCommission + remainder);

    await this.repo.finishRoundWithSettlement({
      roundId,
      winnerCount: winners.length,
      payoutEachEtb: payoutEach,
      prizePoolEtb: distributed,
      commissionEtb: commission,
      winners,
      settledAt: new Date(),
    });

    this.broadcast(round.roomId, "round:finished", {
      roundId,
      callSeq,
      winnerCount: winners.length,
      payoutEachEtb: payoutEach,
      totalPayoutEtb: distributed,
      adminCommissionEtb: commission,
      winners,
    });
  }

  private stopRoundLoop(roundId: string) {
    const loop = this.callLoops.get(roundId);
    if (loop) {
      clearInterval(loop);
      this.callLoops.delete(roundId);
    }
    const grace = this.graceTimers.get(roundId);
    if (grace) {
      clearTimeout(grace);
      this.graceTimers.delete(roundId);
    }
    this.activeGraceCall.delete(roundId);
  }
}
