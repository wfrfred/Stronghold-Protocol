import type { UnitId } from "../../../unit.js";
import type { CombatWork } from "../../../../battle/execution/work.js";
import type { VitalUnit } from "../capability.js";

export interface HealingRequest {
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

export interface HealingResolution {
    readonly work: CombatWork;
    readonly amount: number;
    readonly report: HealingReport;
}

export interface HealingResult<U extends VitalUnit> {
    readonly unit: U;
    readonly amount: number;
}
