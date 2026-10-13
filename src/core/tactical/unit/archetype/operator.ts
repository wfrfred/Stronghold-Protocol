import { assertNonnegativeSafeInteger, assertPositiveNumber } from "../../../common/assert.js";
import {
    createActionCapabilityDefinition,
    type ActingUnitDefinition,
} from "../capability/action/capability.js";
import type { AllegiantUnitDefinition } from "../capability/allegiance.js";
import {
    createBlockerDefinition,
    type BlockingUnitDefinition,
} from "../capability/blocking/capability.js";
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
    type HitUnitDefinition,
    type SpatialUnitDefinition,
} from "../capability/spatial.js";
import type { StatusUnitDefinition } from "../capability/status/capability.js";
import type { VitalUnitDefinition } from "../capability/vitality/capability.js";
import * as initialization from "../initialize.js";
import {
    createElementalDefinition,
    type ElementalDefinition,
} from "../capability/elemental/capability.js";
import { createSkillDefinition, type SkillDefinition } from "../capability/skill/capability.js";

export interface Definition
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
    readonly elemental?: ElementalDefinition;
}

export type Operator<D extends Definition = Definition> = initialization.Result<D>;

export type Input<D extends Definition = Definition> = initialization.Input<D>;

export function createDefinition(definition: Definition): Definition {
    if (definition.id.length === 0) {
        throw new TypeError("operator definition id must be nonempty");
    }

    assertPositiveNumber(definition.vitality.maxHp, "operator maxHp");

    return Object.freeze({
        id: definition.id,
        vitality: Object.freeze({ maxHp: definition.vitality.maxHp }),
        action: createActionCapabilityDefinition(definition.action),
        allegiance: definition.allegiance,
        spatial: definition.spatial,
        hit: createHitDefinition(definition.hit),
        status: definition.status,
        defense: createDefenseDefinition(definition.defense),
        ...(definition.offense === undefined
            ? {}
            : { offense: createOffenseDefinition(definition.offense) }),
        blocker: createBlockerDefinition(definition.blocker),
        ...(definition.elemental === undefined
            ? {}
            : { elemental: createElementalDefinition(definition.elemental) }),
        ...(definition.skill === undefined
            ? {}
            : { skill: createSkillDefinition(definition.skill) }),
    });
}

export function initialize<D extends Definition>(input: Input<D>): Operator<D> {
    assertNonnegativeSafeInteger(input.id, "operator id");

    return initialization.initialize(input);
}
