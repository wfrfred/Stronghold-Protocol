import type { BattlefieldChange } from "../battlefield/contract.js";
import { instantiateUnitPlacement } from "./creation/placement.js";
import { instantiateMechanismPlacement } from "./creation/mechanism.js";
import { changePredefinedInstances } from "./steps/predefined.js";
import type { Input } from "./contract.js";
import { advanceBattlefield, type State as BattleState } from "./state.js";
import { enter } from "./execution/unit.js";

export function initializeBattlefield(input: Input, state: BattleState): BattleState {
    const initialChanges: BattlefieldChange[] = [];
    const initialUnitIds: number[] = [];

    for (const placement of input.initialUnits) {
        const initialized = instantiateUnitPlacement(state, placement);
        state = initialized.state;
        const instantiated = initialized.value;

        initialChanges.push(...instantiated.changes);
        initialUnitIds.push(instantiated.unit.id);
    }

    for (const placement of input.initialMechanisms) {
        const instantiated = instantiateMechanismPlacement(placement, state.execution);
        initialChanges.push(...instantiated.changes);
        state = { ...state, execution: instantiated.execution };
    }

    const initialized = changePredefinedInstances(
        state,
        input.predefines,
        state.predefinedPresence,
        input.predefines
            .filter((definition) => definition.initiallyPresent)
            .map((definition) => ({
                type: "APPEAR_PREDEFINED",
                definitionId: definition.id,
            })),
    );
    state = initialized.state;

    state = {
        ...state,
        predefinedPresence: initialized.value.presence,
    };
    state = advanceBattlefield(state, [...initialChanges, ...initialized.value.changes]);
    state = enter(state, [
        ...initialUnitIds,
        ...initialized.value.changes.flatMap((change) =>
            change.type === "REGISTER_UNIT" ? [change.unit.id] : [],
        ),
    ]);

    return state;
}
