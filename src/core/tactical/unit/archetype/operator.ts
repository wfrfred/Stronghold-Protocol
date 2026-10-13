import { assertNonnegativeSafeInteger, assertPositiveNumber } from "../../../common/assert.js";
import {
    createActionCapabilityDefinition,
    type ActionCapabilityDefinition,
} from "../capability/action/capability.js";
import type { AllegianceState } from "../capability/allegiance.js";
import {
    createBlockerDefinition,
    type BlockerDefinition,
} from "../capability/blocking/capability.js";
import {
    createDefenseDefinition,
    type DefenseDefinition,
} from "../capability/defense/capability.js";
import {
    createOffenseDefinition,
    type OffenseDefinition,
} from "../capability/offense/capability.js";
import {
    createHitDefinition,
    type HitDefinition,
    type SpatialDefinition,
} from "../capability/spatial.js";
import type { StatusDefinition } from "../capability/status/capability.js";
import type { VitalityDefinition } from "../capability/vitality/capability.js";
import type { DefinitionId } from "../unit.js";
import * as initialization from "../initialize.js";
import {
    createElementalDefinition,
    type ElementalDefinition,
} from "../capability/elemental/capability.js";
import { createSkillDefinition, type SkillDefinition } from "../capability/skill/capability.js";

export interface Definition {
    readonly id: DefinitionId;
    readonly vitality: VitalityDefinition;
    readonly action: ActionCapabilityDefinition;
    readonly allegiance: AllegianceState;
    readonly spatial: SpatialDefinition;
    readonly hit: HitDefinition;
    readonly status: StatusDefinition;
    readonly defense: DefenseDefinition;
    readonly blocker: BlockerDefinition;
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
