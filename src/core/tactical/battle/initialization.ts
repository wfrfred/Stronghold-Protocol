import { instantiateUnitPlacement } from "./creation/placement.js";
import { instantiateMechanismPlacement } from "./creation/mechanism.js";
import { advancePredefined } from "./steps/predefined.js";
import type { Input } from "./contract.js";
import { registerUnit, updateMechanism, type State as BattleState } from "./state.js";
import { enter } from "./execution/unit.js";

export function initializeBattlefield(input: Input, state: BattleState): BattleState {
    for (const placement of input.initialUnits) {
        const initialized = instantiateUnitPlacement(state, placement);
        state = registerUnit(initialized.state, initialized.value);
        state = enter(state, initialized.value.id);
    }

    for (const placement of input.initialMechanisms) {
        const instantiated = instantiateMechanismPlacement(placement, state.execution);
        state = { ...state, execution: instantiated.execution };
        state = updateMechanism(state, instantiated.mechanism);
    }

    return advancePredefined(
        state,
        input.predefines,
        input.predefines
            .filter((definition) => definition.initiallyPresent)
            .map((definition) => ({ type: "APPEAR_PREDEFINED", definitionId: definition.id })),
    );
}
