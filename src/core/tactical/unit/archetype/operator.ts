import { assertNonnegativeSafeInteger } from "../../../common/assert.js";
import {
    createDefinition as createActionCapabilityDefinition,
    type Definition as ActionCapabilityDefinition,
} from "../capability/action/capability.js";
import type { Definition as AllegianceDefinition } from "../capability/allegiance/capability.js";
import type { Definition as BlockerDefinition } from "../capability/blocking/blocker.js";
import {
    createDefinition as createOffenseDefinition,
    type Definition as OffenseDefinition,
} from "../capability/offense/capability.js";
import { createHitDefinition, type HitDefinition } from "../capability/spatial/capability.js";
import type { Definition as VitalityDefinition } from "../capability/vitality/capability.js";
import type { Definition as DeployableDefinition } from "../capability/deployable/capability.js";
import type { Definition as LayerDefinition } from "../capability/layer/capability.js";
import type { Unit, Definition as UnitDefinition } from "../unit.js";
import * as initialization from "../initialize.js";
import type { Product } from "../capability/catalog.js";
import type { Result, State as BattleState } from "../../battle/state.js";
import type { Definition as TargetableDefinition } from "../capability/targetable/capability.js";
import type { Definition as OccupancyDefinition } from "../capability/occupancy/capability.js";
import type { Definition as PresenceDefinition } from "../capability/presence/capability.js";
import {
    createDefinition as createElementalDefinition,
    type Definition as ElementalDefinition,
} from "../capability/elemental/capability.js";
import {
    createDefinition as createSkillDefinition,
    type Definition as SkillDefinition,
} from "../capability/skill/capability.js";

export interface Definition extends UnitDefinition {
    readonly vitality: VitalityDefinition;
    readonly action: ActionCapabilityDefinition;
    readonly allegiance: AllegianceDefinition;
    readonly layer: LayerDefinition;
    readonly hit: HitDefinition;
    readonly blocker: BlockerDefinition;
    readonly offense?: OffenseDefinition;
    readonly skill?: SkillDefinition;
    readonly elemental?: ElementalDefinition;
    readonly deployable?: DeployableDefinition;
    readonly targetable?: TargetableDefinition;
    readonly occupancy?: OccupancyDefinition;
    readonly spatialPresence?: PresenceDefinition;
}

export type Operator<D extends Definition = Definition> = Unit & Product<D>;

export type Input<D extends Definition = Definition> = initialization.Input<D>;

export function createDefinition(definition: Definition): Definition {
    if (definition.id.length === 0) {
        throw new TypeError("operator definition id must be nonempty");
    }

    return Object.freeze({
        id: definition.id,
        ...(definition.onEnter === undefined ? {} : { onEnter: definition.onEnter }),
        ...(definition.onTick === undefined ? {} : { onTick: definition.onTick }),
        ...(definition.onLeave === undefined ? {} : { onLeave: definition.onLeave }),
        ...(definition.deployable === undefined ? {} : { deployable: definition.deployable }),
        ...(definition.targetable === undefined ? {} : { targetable: definition.targetable }),
        ...(definition.occupancy === undefined ? {} : { occupancy: definition.occupancy }),
        ...(definition.spatialPresence === undefined
            ? {}
            : { spatialPresence: definition.spatialPresence }),
        vitality: Object.freeze({ ...definition.vitality }),
        action: createActionCapabilityDefinition(definition.action),
        allegiance: definition.allegiance,
        layer: definition.layer,
        hit: createHitDefinition(definition.hit),
        ...(definition.offense === undefined
            ? {}
            : { offense: createOffenseDefinition(definition.offense) }),
        blocker: definition.blocker,
        ...(definition.elemental === undefined
            ? {}
            : { elemental: createElementalDefinition(definition.elemental) }),
        ...(definition.skill === undefined
            ? {}
            : { skill: createSkillDefinition(definition.skill) }),
    });
}

export function initialize<D extends Definition>(
    battle: BattleState,
    input: Input<D>,
): Result<Operator<D>> {
    assertNonnegativeSafeInteger(input.id, "operator id");

    return initialization.initialize(battle, input);
}
