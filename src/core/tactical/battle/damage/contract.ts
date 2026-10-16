import type { Ref } from "../../../common/ref.js";
import type { Unit } from "../../unit/unit.js";
import type { Vitality } from "../../unit/capability/vitality/capability.js";

export type DamageType = "PHYSICAL" | "ARTS" | "TRUE" | "ELEMENTAL";

export interface AttackParameters {
    readonly power: number;
    readonly multiplier: number;
    readonly addition: number;
}

export interface Penetration {
    readonly fixed: number;
    readonly proportional: number;
}

export type DamageParameters =
    | {
          readonly type: "PHYSICAL" | "ARTS";
          readonly attack: AttackParameters;
          readonly penetration: Penetration;
      }
    | {
          readonly type: "TRUE" | "ELEMENTAL";
          readonly attack: AttackParameters;
      };

export interface DamageRequest {
    readonly source: Ref<Unit> | null;
    readonly target: Ref<Unit & Vitality>;
    readonly parameters: DamageParameters;
}

export interface CalculatedDamage {
    readonly type: DamageType;
    readonly amount: number;
}

export interface DamageCancellation {
    readonly reason: string;
}

export interface PendingDamage {
    readonly amount: number;
    readonly cancellation: DamageCancellation | null;
}

export interface ApplicationResult {
    readonly hpBefore: number;
    readonly hpAfter: number;
    readonly hpLoss: number;
}

export type DamageOutcome =
    | { readonly kind: "REJECTED" }
    | { readonly kind: "CANCELLED"; readonly received: PendingDamage }
    | { readonly kind: "UNAVAILABLE"; readonly received: PendingDamage }
    | {
          readonly kind: "APPLIED";
          readonly received: PendingDamage;
          readonly application: ApplicationResult;
      };
