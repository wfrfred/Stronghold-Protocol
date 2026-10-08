import { assertNonnegativeSafeInteger, assertPositiveNumber } from "../../../common/assert.js";
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
import {
    createStatusDefinition,
    type StatusUnitDefinition,
} from "../capability/status/capability.js";
import type { VitalUnitDefinition } from "../capability/vitality/capability.js";
import { initializeUnit, type InitializedUnit, type UnitInitialization } from "../initialize.js";
import { createSkillDefinition, type SkillDefinition } from "../capability/skill/capability.js";

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
    readonly skill?: SkillDefinition;
}

export type Operator<D extends OperatorDefinition = OperatorDefinition> = InitializedUnit<D>;

export type OperatorInitialization<D extends OperatorDefinition = OperatorDefinition> =
    UnitInitialization<D>;

export function createOperatorDefinition(definition: OperatorDefinition): OperatorDefinition {
    if (definition.id.length === 0) {
        throw new TypeError("operator definition id must be nonempty");
    }

    assertPositiveNumber(definition.vitality.maxHp, "operator maxHp");

    return Object.freeze({
        id: definition.id,
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
        ...(definition.skill === undefined
            ? {}
            : { skill: createSkillDefinition(definition.skill) }),
    });
}

export function initializeOperator<D extends OperatorDefinition>(
    input: OperatorInitialization<D>,
): Operator<D> {
    assertNonnegativeSafeInteger(input.id, "operator id");

    return initializeUnit(input);
}
