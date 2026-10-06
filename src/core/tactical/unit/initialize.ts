import { createWorldPosition, type WorldPosition } from "../geometry/coordinate.js";
import {
    createActionState,
    hasActionDefinition,
    type Action,
    type ActingUnitDefinition,
} from "./capability/action.js";
import {
    copyAllegianceState,
    hasAllegianceDefinition,
    type Allegiance,
    type AllegiantUnitDefinition,
} from "./capability/allegiance.js";
import {
    hasBlockableDefinition,
    hasBlockerDefinition,
    type Blockable,
    type BlockableUnitDefinition,
    type Blocker,
    type BlockingUnitDefinition,
} from "./capability/blocking.js";
import {
    createLocomotionState,
    type Locomotion,
    type LocomotiveUnitDefinition,
} from "./capability/locomotion/state.js";
import {
    copyTargetableState,
    hasTargetableDefinition,
    type Targetable,
    type TargetableUnitDefinition,
} from "./capability/targetable.js";
import {
    hasVitalityDefinition,
    type Vitality,
    type VitalUnitDefinition,
} from "./capability/vitality.js";
import type { Unit, UnitDefinition, UnitId } from "./unit.js";

export interface UnitInitialization<D extends UnitDefinition = UnitDefinition> {
    readonly id: UnitId;
    readonly definition: D;
    readonly position: WorldPosition;
    readonly tick?: number;
}

export type InitializedUnit<D extends UnitDefinition> = Unit<D> &
    (D extends VitalUnitDefinition ? Vitality : unknown) &
    (D extends LocomotiveUnitDefinition ? Locomotion : unknown) &
    (D extends AllegiantUnitDefinition ? Allegiance : unknown) &
    (D extends ActingUnitDefinition ? Action : unknown) &
    (D extends TargetableUnitDefinition ? Targetable : unknown) &
    (D extends BlockingUnitDefinition ? Blocker : unknown) &
    (D extends BlockableUnitDefinition ? Blockable : unknown);

export function initializeUnit<D extends UnitDefinition>(
    input: UnitInitialization<D>,
): InitializedUnit<D> {
    const { id, definition, position } = input;
    const unit: Unit<D> = {
        id,
        definition,
        position: Object.isFrozen(position) ? position : createWorldPosition(...position),
    };

    if (hasVitalityDefinition(definition)) {
        Object.assign(unit, { vitality: { hp: definition.vitality.maxHp } });
    }
    if ("locomotion" in definition) {
        Object.assign(unit, { locomotion: createLocomotionState() });
    }
    if (hasAllegianceDefinition(definition)) {
        Object.assign(unit, { allegiance: copyAllegianceState(definition.allegiance) });
    }
    if (hasActionDefinition(definition)) {
        Object.assign(unit, { action: createActionState(input.tick ?? 0) });
    }
    if (hasTargetableDefinition(definition)) {
        Object.assign(unit, { targetable: copyTargetableState(definition.targetable) });
    }
    if (hasBlockerDefinition(definition)) {
        Object.assign(unit, { blocker: { capacity: definition.blocker.capacity, enabled: true } });
    }
    if (hasBlockableDefinition(definition)) {
        Object.assign(unit, { blockable: { weight: definition.blockable.weight, enabled: true } });
    }

    return unit as InitializedUnit<D>;
}
