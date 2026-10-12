import type { CallContext } from "../../../../battle/execution/call.js";
import type { StableUnit, UnitId } from "../../../unit.js";
import type { BattleState, Result } from "../../../../battle/state.js";
import type { VitalUnit } from "../capability.js";

export interface HealingRequest {
    readonly tick: number;
    readonly sourceUnitId: UnitId | null;
    readonly targetUnitId: UnitId;
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

export interface HealingResult<U extends VitalUnit> {
    readonly unit: StableUnit<U>;
    readonly amount: number;
}

export type HealingOperation = (
    state: BattleState,
    request: HealingRequest,
    call?: CallContext,
) => Result<HealingReport>;
