import type { Ref } from "../../../common/ref.js";
import type { Unit } from "../../unit/unit.js";
import type { Vitality } from "../../unit/capability/vitality/capability.js";

export interface HealingParameters {
    readonly power: number;
    readonly multiplier: number;
}

export interface HealingRequest {
    readonly source: Ref<Unit> | null;
    readonly target: Ref<Unit & Vitality>;
    readonly parameters: HealingParameters;
}

export interface CalculatedHealing {
    readonly amount: number;
}

export interface HealingCancellation {
    readonly reason: string;
}

export interface PendingHealing {
    readonly amount: number;
    readonly cancellation: HealingCancellation | null;
}

export interface ApplicationResult {
    readonly hpBefore: number;
    readonly hpAfter: number;
    readonly hpGain: number;
}

export type HealingOutcome =
    | { readonly kind: "REJECTED" }
    | { readonly kind: "CANCELLED"; readonly received: PendingHealing }
    | { readonly kind: "UNAVAILABLE"; readonly received: PendingHealing }
    | {
          readonly kind: "APPLIED";
          readonly received: PendingHealing;
          readonly application: ApplicationResult;
      };
