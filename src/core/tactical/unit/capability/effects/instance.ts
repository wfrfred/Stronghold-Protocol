import type { EffectProgramRef } from "./program.js";
import type { UnitId } from "../../unit.js";

export type EffectInstanceId = number;

export interface EffectAddress {
    readonly unitId: UnitId;
    readonly instanceId: EffectInstanceId;
}

export interface EffectLifecycleFacts {
    readonly started: boolean;
    readonly participating: boolean;
    readonly finished: boolean;
    readonly parent: EffectAddress | null;
}

export type EffectLifetimeOwner =
    | { readonly type: "UNIT"; readonly unitId: UnitId }
    | {
          readonly type: "EXECUTION";
          readonly unitId: UnitId;
          readonly executionId: number;
      };

export interface EffectInstanceMetadata {
    readonly id: EffectInstanceId;
    readonly sourceUnitId: UnitId | null;
    readonly lifetimeOwner: EffectLifetimeOwner | null;
    readonly acquiredSequence: number;
    readonly expiresAtTick: number | null;
}

export interface EffectInstanceValue extends EffectInstanceMetadata, EffectLifecycleFacts {
    readonly programRef: { readonly id: string };
    readonly state: object;
}

export interface EffectInstance<S extends object> extends EffectInstanceValue {
    readonly programRef: EffectProgramRef<S>;
    readonly state: S;
}
