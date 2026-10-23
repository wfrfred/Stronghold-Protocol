import { assertNonnegativeSafeInteger } from "../../common/assert.js";
import type { Identified, Ref } from "../../common/ref.js";
import type { State as BattleState } from "../battle/state.js";
import type { Departure } from "../unit/unit.js";

export type MechanismId = number;

export interface MechanismView {
    readonly mechanismIds: readonly MechanismId[];
    getMechanism(id: MechanismId): Mechanism | undefined;
}

export interface MechanismDefinition {
    readonly id: string;
    readonly onUnitLeave?: (
        state: BattleState,
        mechanismId: MechanismId,
        departure: Departure,
    ) => BattleState;
}

export interface Mechanism<D extends MechanismDefinition = MechanismDefinition> extends Identified<{
    readonly id: MechanismId;
}> {
    readonly id: MechanismId;
    readonly definition: D;
    readonly active: boolean;
}

export function ref<M extends Mechanism>(mechanism: M): Ref<M> {
    return { id: mechanism.id } as Ref<M>;
}

export function createMechanismDefinition(definition: MechanismDefinition): MechanismDefinition {
    if (definition.id.length === 0) {
        throw new TypeError("mechanism definition id must be nonempty");
    }

    return definition;
}

export function createMechanism<D extends MechanismDefinition>(
    mechanism: Mechanism<D>,
): Mechanism<D> {
    assertNonnegativeSafeInteger(mechanism.id, "mechanism id");

    return {
        id: mechanism.id,
        definition: mechanism.definition,
        active: mechanism.active,
    };
}
