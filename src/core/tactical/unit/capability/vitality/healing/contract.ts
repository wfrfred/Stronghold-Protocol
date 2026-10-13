import type { CallContext } from "../../../../battle/execution/call.js";
import type { Unit, Id } from "../../../unit.js";
import type { BattleState, Result } from "../../../../battle/state.js";
import type { Vitality } from "../capability.js";

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

export interface HealingResult {
    readonly unit: Unit & Vitality;
    readonly amount: number;
}

export type HealingOperation = (
    state: BattleState,
    request: HealingRequest,
    call?: CallContext,
) => Result<HealingReport>;
