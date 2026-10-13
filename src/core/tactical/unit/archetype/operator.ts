import { assertNonnegativeSafeInteger, assertPositiveNumber } from "../../../common/assert.js";
import {
    createDefinition as createActionCapabilityDefinition,
    type Definition as ActionCapabilityDefinition,
} from "../capability/action/capability.js";
import type { Definition as AllegianceDefinition } from "../capability/allegiance.js";
import {
    createDefinition as createBlockerDefinition,
    type Definition as BlockerDefinition,
} from "../capability/blocker.js";
import {
    createDefinition as createDefenseDefinition,
    type Definition as DefenseDefinition,
} from "../capability/defense/capability.js";
import {
    createDefinition as createOffenseDefinition,
    type Definition as OffenseDefinition,
} from "../capability/offense/capability.js";
import {
    createHitDefinition,
    type HitDefinition,
    type SpatialDefinition,
} from "../capability/spatial.js";
import type { Definition as StatusDefinition } from "../capability/status/capability.js";
import type { Definition as VitalityDefinition } from "../capability/vitality/capability.js";
import type { DefinitionId } from "../unit.js";
import * as initialization from "../initialize.js";
import {
    createDefinition as createElementalDefinition,
    type Definition as ElementalDefinition,
} from "../capability/elemental/capability.js";
import {
    createDefinition as createSkillDefinition,
    type Definition as SkillDefinition,
} from "../capability/skill/capability.js";

export interface Definition {
    readonly id: DefinitionId;
    readonly vitality: VitalityDefinition;
    readonly action: ActionCapabilityDefinition;
    readonly allegiance: AllegianceDefinition;
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
