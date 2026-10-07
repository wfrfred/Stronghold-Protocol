import type {
    BattlefieldChange,
    BattlefieldRemovalReason,
    BattlefieldView,
} from "../battlefield/contract.js";
import type { MechanismDefinition } from "../battlefield/mechanism.js";
import {
    createSpatialEffectRegion,
    type NavigationEffectDefinition,
    type SpatialEffectSource,
    type SpatialEffectRegion,
} from "../battlefield/navigation/effect.js";
import {
    createUnitPlacementDefinition,
    instantiateUnitPlacement,
    type UnitPlacementDefinition,
} from "./creation/placement.js";
import type { BattleExecutionState } from "./execution/state.js";
import type { BattlePhase, BattleSystem } from "./system.js";
import type { BattleEvent } from "./contract.js";
import type { EffectTransitionResources } from "../unit/capability/effects/contract.js";
import { removeUnitWithEffects } from "./execution/unit-lifecycle.js";
import { combatWorkChanges, createCombatWork } from "./execution/work.js";

export interface PredefinedUnitCreation extends UnitPlacementDefinition {
    readonly type: "UNIT";
}

export interface PredefinedMechanismCreation {
    readonly type: "MECHANISM";
    readonly definition: MechanismDefinition;
    readonly navigationEffects: readonly {
        readonly definition: NavigationEffectDefinition;
        readonly region: Extract<SpatialEffectRegion, { readonly type: "FIXED" }>;
    }[];
}

export interface PredefinedInstanceDefinition {
    readonly id: number;
    readonly alias: string | null;
    readonly initiallyPresent: boolean;
    readonly creation: PredefinedUnitCreation | PredefinedMechanismCreation;
}

export interface PredefinedPresence {
    readonly definitionId: number;
    readonly source: SpatialEffectSource;
}

export type PredefinedCommand =
    | { readonly type: "APPEAR_PREDEFINED"; readonly definitionId: number }
    | {
          readonly type: "REMOVE_PREDEFINED";
          readonly definitionId: number;
          readonly reason: BattlefieldRemovalReason;
      };

export interface PredefinedTransition {
    readonly presence: readonly PredefinedPresence[];
    readonly execution: BattleExecutionState;
    readonly changes: readonly BattlefieldChange[];
}

export function createPredefinedInstanceDefinition(
    definition: PredefinedInstanceDefinition,
): PredefinedInstanceDefinition {
    if (!Number.isSafeInteger(definition.id) || definition.id < 0) {
        throw new RangeError("predefined definition id must be a nonnegative safe integer");
    }
    if (definition.alias !== null && typeof definition.alias !== "string") {
        throw new TypeError("predefined alias must be a string or null");
    }
    if (typeof definition.initiallyPresent !== "boolean") {
        throw new TypeError("predefined presence must be boolean");
    }

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
                : Object.freeze({
                      ...creation,
                      navigationEffects: Object.freeze(
                          creation.navigationEffects.map((effect) => {
                              const region = createSpatialEffectRegion(effect.region);

                              if (region.type !== "FIXED") {
                                  throw new TypeError("predefined mechanism effects must be fixed");
                              }

                              return Object.freeze({
                                  definition: effect.definition,
                                  region,
                              });
                          }),
                      ),
                  }),
    });
}

export function predefinedIdsForAlias(
    definitions: readonly PredefinedInstanceDefinition[],
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
    definitions: readonly PredefinedInstanceDefinition[],
    initialPresence: readonly PredefinedPresence[],
    commands: readonly PredefinedCommand[],
    initialExecution: BattleExecutionState,
    tick = 0,
): PredefinedTransition {
    if (commands.length === 0) {
        return { presence: initialPresence, execution: initialExecution, changes: [] };
    }

    const presence = new Map(initialPresence.map((binding) => [binding.definitionId, binding]));
    const changes: BattlefieldChange[] = [];
    let execution = initialExecution;

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
        let source: SpatialEffectSource;

        if (creation.type === "UNIT") {
            const instantiated = instantiateUnitPlacement(creation, execution, tick);

            source = Object.freeze({ type: "UNIT", unitId: instantiated.unit.id });
            changes.push(...instantiated.changes);
            execution = instantiated.execution;
        } else {
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

            for (const contribution of creation.navigationEffects) {
                changes.push({
                    type: "ADD_EFFECT",
                    effect: {
                        id: execution.nextSpatialEffectId,
                        definition: contribution.definition,
                        source,
                        active: true,
                        region: contribution.region,
                        expiresAtTick: null,
                    },
                });
                execution = {
                    ...execution,
                    nextSpatialEffectId: nextIdentity(execution.nextSpatialEffectId),
                };
            }
        }

        presence.set(command.definitionId, { definitionId: command.definitionId, source });
    }

    return {
        presence: changes.length === 0 ? initialPresence : [...presence.values()],
        execution,
        changes,
    };
}

export function copyPredefinedPresence(
    presence: readonly PredefinedPresence[],
): readonly PredefinedPresence[] {
    return presence.map((binding) => ({ ...binding, source: { ...binding.source } }));
}

function reconcilePredefinedPresence(
    presence: readonly PredefinedPresence[],
    battlefield: BattlefieldView,
): readonly PredefinedPresence[] {
    const remaining = presence.filter(
        ({ source }) => source.type !== "UNIT" || battlefield.getUnit(source.unitId) !== undefined,
    );

    return remaining.length === presence.length ? presence : remaining;
}

export function createPredefinedSystem(
    definitions: readonly PredefinedInstanceDefinition[],
    resources: EffectTransitionResources,
): BattleSystem<readonly PredefinedPresence[]> & {
    readonly step: BattlePhase<readonly PredefinedPresence[]>;
    readonly resolve: BattlePhase<readonly PredefinedPresence[]>;
} {
    return {
        createState: () => [],

        step(input, state) {
            const presence = reconcilePredefinedPresence(state, input.battlefield);
            const commands = input.commands.filter(
                (command): command is PredefinedCommand =>
                    command.type === "APPEAR_PREDEFINED" || command.type === "REMOVE_PREDEFINED",
            );
            const changed = changePredefinedInstances(
                definitions,
                presence,
                commands,
                input.execution,
                input.tick,
            );

            if (changed.changes.length === 0) {
                return {
                    state: changed.presence,
                    changes: [],
                    events: [],
                    execution: changed.execution,
                };
            }

            const units = new Map(
                input.battlefield.unitIds.map((id) => [id, input.battlefield.getUnit(id)!]),
            );
            const changes: BattlefieldChange[] = [];
            const events: BattleEvent[] = [];
            let execution = changed.execution;

            for (const change of changed.changes) {
                if (change.type === "REGISTER_UNIT" || change.type === "UPDATE_UNIT") {
                    units.set(change.unit.id, change.unit);
                }
                if (change.type !== "REMOVE_UNIT") {
                    changes.push(change);
                    continue;
                }

                const work = removeUnitWithEffects(
                    createCombatWork(
                        {
                            unitIds: [...units.keys()],
                            getUnit: (id) => units.get(id),
                            blockerOf: (id) => input.battlefield.blockerOf(id),
                            blockedBy: (id) => input.battlefield.blockedBy(id),
                        },
                        execution,
                        input.battlefield,
                    ),
                    change.unitId,
                    change.reason,
                    resources,
                    input.tick,
                );
                const settled = combatWorkChanges(work);

                for (const update of settled) {
                    if (update.type === "REGISTER_UNIT" || update.type === "UPDATE_UNIT") {
                        units.set(update.unit.id, update.unit);
                    } else if (update.type === "REMOVE_UNIT") {
                        units.delete(update.unitId);
                    }
                }

                changes.push(...settled);
                events.push(...work.events);
                execution = work.execution;
            }

            return {
                state: changed.presence,
                changes,
                events,
                execution,
            };
        },

        resolve(input, state) {
            return {
                state: reconcilePredefinedPresence(state, input.battlefield),
                changes: [],
                events: [],
                execution: input.execution,
            };
        },
    };
}
