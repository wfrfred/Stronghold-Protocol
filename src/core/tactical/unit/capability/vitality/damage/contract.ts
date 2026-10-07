import type { EffectInstanceId } from "../../effects/instance.js";
import type { UnitId } from "../../../unit.js";
import type { CombatWork } from "../../../../battle/execution/work.js";

export type DamageType = "PHYSICAL" | "ARTS" | "TRUE";

export interface DamageOperands {
    readonly power: number;
    readonly attackScale: number;
    readonly attackAddition: number;
    readonly fixedPenetration: number;
    readonly proportionalPenetration: number;
}

export interface DamageRequest {
    readonly sourceUnitId: UnitId | null;
    readonly targetUnitId: UnitId;
    readonly damageType: DamageType;
    readonly operands: DamageOperands;
    readonly tick: number;
    readonly receptionPolicy?: DamageReceptionPolicy;
}

export interface DamageReceptionPolicy {
    readonly skipModifierEvents: boolean;
    readonly considerInvincibility: boolean;
}

export const NORMAL_DAMAGE_RECEPTION: DamageReceptionPolicy = Object.freeze({
    skipModifierEvents: false,
    considerInvincibility: true,
});

export const SKIPPED_DAMAGE_RECEPTION: DamageReceptionPolicy = Object.freeze({
    skipModifierEvents: true,
    considerInvincibility: false,
});

export interface DamageCancellation {
    readonly stage: "INPUT" | "FORMULA" | "OUTPUT" | "RECEPTION";
    readonly reason: string;
}

export interface DamageResourceConsumption {
    readonly ownerUnitId: UnitId;
    readonly instanceId: EffectInstanceId;
    readonly resource: string;
    readonly amount: number;
}

export interface PendingDamage {
    readonly amount: number;
    readonly cancellation: DamageCancellation | null;
    readonly consumptions: readonly DamageResourceConsumption[];
}

export interface DamageReport {
    readonly request: DamageRequest;
    readonly formulaDamage: number | null;
    readonly outputDamage: number | null;
    readonly hpDamage: number | null;
    readonly hpLoss: number;
    readonly resourceConsumptions: readonly DamageResourceConsumption[];
    readonly cancellation: DamageCancellation | null;
    readonly deathOccurred: boolean;
    readonly fatalProtection: boolean;
}

export interface DamageResolution {
    readonly work: CombatWork;
    readonly report: DamageReport;
}

export function createDamageOperands(power: number): DamageOperands {
    return {
        power,
        attackScale: 1,
        attackAddition: 0,
        fixedPenetration: 0,
        proportionalPenetration: 0,
    };
}
