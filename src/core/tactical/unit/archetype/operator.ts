import {
    createActionCapabilityDefinition,
    type ActingUnitDefinition,
} from "../capability/action/capability.js";
import { createAllegianceState, type AllegiantUnitDefinition } from "../capability/allegiance.js";
import { createBlockerDefinition, type BlockingUnitDefinition } from "../capability/blocking.js";
import {
    createDefenseDefinition,
    type DefendedUnitDefinition,
} from "../capability/defense/capability.js";
import {
    createOffenseDefinition,
    type OffenseDefinition,
} from "../capability/offense/capability.js";
import {
    createHitDefinition,
    createSpatialDefinition,
    type HitUnitDefinition,
    type SpatialUnitDefinition,
} from "../capability/spatial.js";
import { createStatusDefinition, type StatusUnitDefinition } from "../capability/status.js";
import type { VitalUnitDefinition } from "../capability/vitality/capability.js";
import { initializeUnit, type InitializedUnit, type UnitInitialization } from "../initialize.js";

export interface OperatorDefinition
    extends
        VitalUnitDefinition,
        ActingUnitDefinition,
        AllegiantUnitDefinition,
        SpatialUnitDefinition,
        HitUnitDefinition,
        StatusUnitDefinition,
        DefendedUnitDefinition,
        BlockingUnitDefinition {
    readonly offense?: OffenseDefinition;
}

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
        action: createActionCapabilityDefinition(definition.action),
        allegiance: createAllegianceState(definition.allegiance),
        spatial: createSpatialDefinition(definition.spatial),
        hit: createHitDefinition(definition.hit),
        status: createStatusDefinition(definition.status),
        defense: createDefenseDefinition(definition.defense),
        ...(definition.offense === undefined
            ? {}
            : { offense: createOffenseDefinition(definition.offense) }),
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
