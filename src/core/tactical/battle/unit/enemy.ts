import type { Locomotion, LocomotiveUnitDefinition } from "./capabilities/locomotion.js";
import type { Vitality, VitalUnitDefinition } from "./capabilities/vitality.js";
import type { Unit } from "./unit.js";

export interface EnemyDefinition
    extends VitalUnitDefinition,
    LocomotiveUnitDefinition {
}

export type Enemy =
    Unit<EnemyDefinition>
    & Vitality
    & Locomotion;
