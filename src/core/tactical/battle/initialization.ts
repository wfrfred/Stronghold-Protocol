import { maintain } from "../battlefield/storage/state.js";
import type { Mechanism } from "../battlefield/mechanism.js";
import type { Unit } from "../unit/unit.js";
import { instantiateUnitPlacement } from "./creation/placement.js";
import { instantiateMechanismPlacement } from "./creation/mechanism.js";
import { instantiatePredefinedInstances } from "./steps/predefined.js";
import type { Input } from "./contract.js";
import { setBattlefield, type State as BattleState } from "./state.js";
import { enter } from "./execution/unit.js";

export function initializeBattlefield(input: Input, state: BattleState): BattleState {
    const initialUnits: Unit[] = [];
    const initialMechanisms: Mechanism[] = [];

    for (const placement of input.initialUnits) {
        const initialized = instantiateUnitPlacement(state, placement);
        state = initialized.state;
        initialUnits.push(initialized.value);
    }

    for (const placement of input.initialMechanisms) {
        const instantiated = instantiateMechanismPlacement(placement, state.execution);
        initialMechanisms.push(instantiated.mechanism);
        state = { ...state, execution: instantiated.execution };
    }

    const initialized = instantiatePredefinedInstances(state, input.predefines);
    state = initialized.state;
    initialUnits.push(...initialized.value.units);
    initialMechanisms.push(...initialized.value.mechanisms);

    if (initialUnits.length === 0 && initialMechanisms.length === 0) {
        return state;
    }

    const previous = state.battlefield;
    const units = new Map(previous.units);
    const mechanisms = new Map(previous.mechanisms);

    for (const unit of initialUnits) {
        if (units.has(unit.id)) {
            throw new RangeError(`duplicate unit: ${unit.id}`);
        }

        units.set(unit.id, unit);
    }

    for (const mechanism of initialMechanisms) {
        if (mechanisms.has(mechanism.id)) {
            throw new RangeError(`duplicate mechanism: ${mechanism.id}`);
        }

        mechanisms.set(mechanism.id, mechanism);
    }

    state = setBattlefield(
        state,
        maintain(
            previous,
            {
                ...previous,
                units: initialUnits.length === 0 ? previous.units : units,
                mechanisms: initialMechanisms.length === 0 ? previous.mechanisms : mechanisms,
            },
            {
                updatedUnitIds: new Set(initialUnits.map((unit) => unit.id)),
                unitOrderChanged: initialUnits.length > 0,
            },
        ),
    );
    state = enter(
        state,
        initialUnits.map((unit) => unit.id),
    );

    return state;
}
