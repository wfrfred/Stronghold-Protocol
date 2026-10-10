import type { EffectValue } from "./effect.js";
import type { StableUnit, Unit } from "../../unit.js";

export interface Binding {
    readonly install: <U extends Unit>(
        unit: U | StableUnit<U>,
        instance: EffectValue,
    ) => StableUnit<U>;
    readonly update: <U extends Unit>(
        unit: U | StableUnit<U>,
        instance: EffectValue,
    ) => StableUnit<U>;
    readonly setParticipation: <U extends Unit>(
        unit: U | StableUnit<U>,
        instance: EffectValue,
        participating: boolean,
    ) => StableUnit<U>;
    readonly remove: <U extends Unit>(
        unit: U | StableUnit<U>,
        instance: EffectValue,
    ) => StableUnit<U>;
    readonly reconcile?: <U extends Unit>(
        previous: U | StableUnit<U>,
        current: U | StableUnit<U>,
    ) => StableUnit<U>;
}
