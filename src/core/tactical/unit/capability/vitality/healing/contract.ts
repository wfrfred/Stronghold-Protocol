import type { CallContext } from "../../../../battle/execution/call.js";
import type { Id } from "../../../unit.js";
import type { State as BattleState, Result } from "../../../../battle/state.js";

export interface HealingRequest {
    readonly tick: number;
    readonly sourceUnitId: Id | null;
    readonly targetUnitId: Id;
    readonly power: number;
    readonly ignoreHealFree: boolean;
    readonly skipModifierEvents?: boolean;
}

export interface HealingCancellation {
    readonly reason: string;
}

export interface PendingHealing {
    readonly amount: number;
    readonly cancellation: HealingCancellation | null;
}

export interface HealingReport {
    readonly request: HealingRequest;
    readonly amount: number;
    readonly cancellation: HealingCancellation | null;
}

export type HealingOperation = (
    state: BattleState,
    request: HealingRequest,
    call?: CallContext,
) => Result<HealingReport>;
