import type { BattlefieldChange } from "../battlefield/contract.js";
import { instantiateUnitPlacement } from "./creation/placement.js";
import { instantiateMechanismPlacement } from "./creation/mechanism.js";
import { instantiateNavigationModifierPlacement } from "./creation/navigation-modifier.js";
import { changePredefinedInstances } from "./steps/predefined.js";
import type { Input } from "./contract.js";
import { advanceBattlefield, type BattleState } from "./execution/context.js";

export function initializeBattlefield(input: Input, state: BattleState) {
    const initialChanges: BattlefieldChange[] = [];
    const initialUnitIds: number[] = [];
    const initialMechanismIds: number[] = [];

    for (const placement of input.initialUnits) {
        const instantiated = instantiateUnitPlacement(placement, state.execution, 0);

        initialChanges.push(...instantiated.changes);
        initialUnitIds.push(instantiated.unit.id);
        state.execution = instantiated.execution;
    }

    for (const placement of input.initialMechanisms) {
        const instantiated = instantiateMechanismPlacement(placement, state.execution);
        initialChanges.push(...instantiated.changes);
        initialMechanismIds.push(instantiated.mechanism.id);
        state.execution = instantiated.execution;
    }
    for (const placement of input.initialNavigationModifiers) {
        const instantiated = instantiateNavigationModifierPlacement(
            placement,
            state.execution,
            initialUnitIds,
            initialMechanismIds,
        );
        initialChanges.push(...instantiated.changes);
        state.execution = instantiated.execution;
    }

    const initialized = changePredefinedInstances(
        input.predefines,
        [],
        input.predefines
            .filter((definition) => definition.initiallyPresent)
            .map((definition) => ({
                type: "APPEAR_PREDEFINED",
                definitionId: definition.id,
            })),
        state.execution,
    );

    state.execution = initialized.execution;
    advanceBattlefield(state, [...initialChanges, ...initialized.changes]);

    return initialized.presence;
}
