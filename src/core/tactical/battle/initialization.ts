import type { BattlefieldChange } from "../battlefield/contract.js";
import type { BattlefieldRuntime } from "../battlefield/runtime.js";
import { instantiateUnitPlacement } from "./creation/placement.js";
import { instantiateMechanismPlacement } from "./creation/mechanism.js";
import { instantiateNavigationModifierPlacement } from "./creation/navigation-modifier.js";
import { changePredefinedInstances } from "./steps/predefined.js";
import type { Input } from "./contract.js";
import type { BattleExecutionState } from "./execution/state.js";
import type { CombatResources } from "./resources.js";
import { advanceEffectSources } from "./steps/effect-sources.js";

export function initializeBattlefield(
    input: Input,
    battlefield: BattlefieldRuntime,
    execution: BattleExecutionState,
    combatResources: CombatResources,
) {
    const initialChanges: BattlefieldChange[] = [];
    const initialUnitIds: number[] = [];
    const initialMechanismIds: number[] = [];

    for (const placement of input.initialUnits) {
        const instantiated = instantiateUnitPlacement(placement, execution, 0);

        initialChanges.push(...instantiated.changes);
        initialUnitIds.push(instantiated.unit.id);
        execution = instantiated.execution;
    }

    for (const placement of input.initialMechanisms) {
        const instantiated = instantiateMechanismPlacement(placement, execution, initialUnitIds);
        initialChanges.push(...instantiated.changes);
        initialMechanismIds.push(instantiated.mechanism.id);
        execution = instantiated.execution;
    }
    for (const placement of input.initialNavigationModifiers) {
        const instantiated = instantiateNavigationModifierPlacement(
            placement,
            execution,
            initialUnitIds,
            initialMechanismIds,
        );
        initialChanges.push(...instantiated.changes);
        execution = instantiated.execution;
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
        execution,
    );

    battlefield.apply([...initialChanges, ...initialized.changes]);

    const preparedSources = advanceEffectSources(
        {
            battlefield: battlefield.view,
            tick: 0,
            execution: initialized.execution,
        },
        combatResources,
    );
    battlefield.apply(preparedSources.changes);

    return { predefinedPresence: initialized.presence, execution: preparedSources.execution };
}
