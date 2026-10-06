import { createActionDefinition, type ActingUnitDefinition } from "./capability/action.js";
import { createAllegianceState, type AllegiantUnitDefinition } from "./capability/allegiance.js";
import { createBlockerDefinition, type BlockingUnitDefinition } from "./capability/blocking.js";
import { createDefenseDefinition, type DefendedUnitDefinition } from "./capability/defense.js";
import { createTargetableState, type TargetableUnitDefinition } from "./capability/targetable.js";
import type { VitalUnitDefinition } from "./capability/vitality.js";
import { initializeUnit, type InitializedUnit, type UnitInitialization } from "./initialize.js";

export interface OperatorDefinition
    extends
        VitalUnitDefinition,
        ActingUnitDefinition,
        AllegiantUnitDefinition,
        TargetableUnitDefinition,
        DefendedUnitDefinition,
        BlockingUnitDefinition {}

export type Operator<D extends OperatorDefinition = OperatorDefinition> = InitializedUnit<D>;

export type OperatorInitialization<D extends OperatorDefinition = OperatorDefinition> =
    UnitInitialization<D>;

export function createOperatorDefinition(definition: OperatorDefinition): OperatorDefinition {
    const id: unknown = definition.id;

    if (typeof id !== "string" || id.length === 0) {
        throw new TypeError("operator definition id must be nonempty");
    }
    if (!Number.isFinite(definition.vitality.maxHp) || definition.vitality.maxHp <= 0) {
        throw new RangeError("operator maxHp must be finite and positive");
    }

    return Object.freeze({
        id,
        vitality: Object.freeze({ maxHp: definition.vitality.maxHp }),
        action: createActionDefinition(definition.action),
        allegiance: createAllegianceState(definition.allegiance),
        targetable: createTargetableState(definition.targetable),
        defense: createDefenseDefinition(definition.defense),
        blocker: createBlockerDefinition(definition.blocker),
    });
}

export function initializeOperator<D extends OperatorDefinition>(
    input: OperatorInitialization<D>,
): Operator<D> {
    if (!Number.isSafeInteger(input.id) || input.id < 0) {
        throw new RangeError("operator id must be a nonnegative safe integer");
    }

    return initializeUnit(input);
}
