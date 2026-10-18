import { assertNonnegativeSafeInteger } from "../../../common/assert.js";
import type {
    BattlefieldChange,
    BattlefieldRemovalReason,
    BattlefieldView,
} from "../../battlefield/contract.js";
import type { MechanismDefinition } from "../../battlefield/mechanism.js";
import {
    createUnitPlacementDefinition,
    instantiateUnitPlacement,
    type UnitPlacementDefinition,
} from "../creation/placement.js";
import type { Command } from "../contract.js";
import { enter, leave } from "../execution/unit.js";
import {
    advanceBattlefield,
    battlefieldView,
    type State as BattleState,
    type Result,
} from "../state.js";

export interface PredefinedUnitCreation extends UnitPlacementDefinition {
    readonly type: "UNIT";
}

export interface PredefinedMechanismCreation {
    readonly type: "MECHANISM";
    readonly definition: MechanismDefinition;
}

export type Source =
    | { readonly type: "UNIT"; readonly unitId: number }
    | { readonly type: "MECHANISM"; readonly mechanismId: number };

export interface PredefinedDefinition {
    readonly id: number;
    readonly alias: string | null;
    readonly initiallyPresent: boolean;
    readonly creation: PredefinedUnitCreation | PredefinedMechanismCreation;
}

export interface PredefinedPresence {
    readonly definitionId: number;
    readonly source: Source;
}

export type PredefinedCommand =
    | { readonly type: "APPEAR_PREDEFINED"; readonly definitionId: number }
    | {
          readonly type: "REMOVE_PREDEFINED";
          readonly definitionId: number;
          readonly reason: BattlefieldRemovalReason;
      };

interface PredefinedTransition {
    readonly presence: readonly PredefinedPresence[];
    readonly changes: readonly BattlefieldChange[];
}

export function createPredefinedDefinition(definition: PredefinedDefinition): PredefinedDefinition {
    assertNonnegativeSafeInteger(definition.id, "predefined definition id");

    const creation = definition.creation;

    return Object.freeze({
        id: definition.id,
        alias: definition.alias,
        initiallyPresent: definition.initiallyPresent,
        creation:
            creation.type === "UNIT"
                ? Object.freeze({
                      type: creation.type,
                      ...createUnitPlacementDefinition(creation),
                  })
                : Object.freeze({ ...creation }),
    });
}

export function predefinedIdsForAlias(
    definitions: readonly PredefinedDefinition[],
    alias: string,
): readonly number[] {
    return definitions
        .filter((definition) => definition.alias === alias)
        .map((definition) => definition.id);
}

function nextIdentity(value: number): number {
    const next = value + 1;

    if (!Number.isSafeInteger(next)) {
        throw new RangeError("predefined instance identity overflow");
    }

    return next;
}

export function changePredefinedInstances(
    state: BattleState,
    definitions: readonly PredefinedDefinition[],
    initialPresence: readonly PredefinedPresence[],
    commands: readonly PredefinedCommand[],
): Result<PredefinedTransition> {
    if (commands.length === 0) {
        return { state, value: { presence: initialPresence, changes: [] } };
    }

    const presence = new Map(initialPresence.map((binding) => [binding.definitionId, binding]));
    const changes: BattlefieldChange[] = [];

    for (const command of commands) {
        const definition = definitions.find((definition) => definition.id === command.definitionId);

        if (definition === undefined) {
            throw new RangeError(`unknown predefined definition: ${command.definitionId}`);
        }

        const binding = presence.get(command.definitionId);

        if (command.type === "REMOVE_PREDEFINED") {
            if (binding === undefined) {
                continue;
            }

            changes.push(
                binding.source.type === "UNIT"
                    ? { type: "REMOVE_UNIT", unitId: binding.source.unitId, reason: command.reason }
                    : {
                          type: "REMOVE_MECHANISM",
                          mechanismId: binding.source.mechanismId,
                          reason: command.reason,
                      },
            );
            presence.delete(command.definitionId);
            continue;
        }
        if (binding !== undefined) {
            continue;
        }

        const creation = definition.creation;
        let source: Source;

        if (creation.type === "UNIT") {
            const initialized = instantiateUnitPlacement(state, creation);
            state = initialized.state;
            const instantiated = initialized.value;

            source = Object.freeze({ type: "UNIT", unitId: instantiated.unit.id });
            changes.push(...instantiated.changes);
        } else {
            let execution = state.execution;
            source = Object.freeze({ type: "MECHANISM", mechanismId: execution.nextMechanismId });
            changes.push({
                type: "REGISTER_MECHANISM",
                mechanism: {
                    id: execution.nextMechanismId,
                    definition: creation.definition,
                    active: true,
                },
            });
            execution = { ...execution, nextMechanismId: nextIdentity(execution.nextMechanismId) };

            state = { ...state, execution };
        }

        presence.set(command.definitionId, { definitionId: command.definitionId, source });
    }

    return {
        state,
        value: {
            presence: changes.length === 0 ? initialPresence : [...presence.values()],
            changes,
        },
    };
}

export function reconcilePredefinedPresence(
    presence: readonly PredefinedPresence[],
    battlefield: BattlefieldView,
): readonly PredefinedPresence[] {
    const remaining = presence.filter(
        ({ source }) => source.type !== "UNIT" || battlefield.getUnit(source.unitId) !== undefined,
    );

    return remaining.length === presence.length ? presence : remaining;
}

export function advancePredefined(
    state: BattleState,
    definitions: readonly PredefinedDefinition[],
    commands: readonly Command[],
): BattleState {
    for (const command of commands) {
        if (command.type !== "APPEAR_PREDEFINED" && command.type !== "REMOVE_PREDEFINED") {
            continue;
        }

        const transition = changePredefinedInstances(
            state,
            definitions,
            reconcilePredefinedPresence(state.predefinedPresence, battlefieldView(state)),
            [command],
        );
        state = transition.state;
        state = {
            ...state,
            predefinedPresence: transition.value.presence,
        };

        for (const change of transition.value.changes) {
            if (change.type === "REMOVE_UNIT") {
                state = leave(state, change.unitId, change.reason);
            } else {
                state = advanceBattlefield(state, [change]);
            }
        }

        state = enter(
            state,
            transition.value.changes.flatMap((change) =>
                change.type === "REGISTER_UNIT" ? [change.unit.id] : [],
            ),
        );
    }

    return {
        ...state,
        predefinedPresence: reconcilePredefinedPresence(
            state.predefinedPresence,
            battlefieldView(state),
        ),
    };
}
