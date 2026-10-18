import { assertNonnegativeSafeInteger } from "../../../common/assert.js";
import type { Unit, Id } from "../../unit/unit.js";
import { releaseBlockingRelations } from "../blocking/relations.js";
import type { BattlefieldChange, BattlefieldRemovalReason } from "../contract.js";
import type { MechanismId } from "../mechanism.js";
import type { BattlefieldContent } from "./state.js";
import type { BattlefieldDependencyChanges } from "./dependencies.js";
import { validateSupportRelations } from "../support/relations.js";

function requireEntry<K extends number, V>(entries: ReadonlyMap<K, V>, id: K, name: string): V {
    const entry = entries.get(id);

    if (entry === undefined) {
        throw new RangeError(`unknown ${name}: ${id}`);
    }

    return entry;
}

function register<K extends number, V>(entries: Map<K, V>, id: K, value: V, name: string): void {
    if (entries.has(id)) {
        throw new RangeError(`duplicate ${name}: ${id}`);
    }

    entries.set(id, value);
}

function copyOnWriteMap<K, V>(source: ReadonlyMap<K, V>) {
    let owned: Map<K, V> | undefined;

    return {
        get value(): ReadonlyMap<K, V> {
            return owned ?? source;
        },
        edit(): Map<K, V> {
            owned ??= new Map(source);

            return owned;
        },
    };
}

export function applyBattlefieldChanges<U extends Unit>(
    previous: BattlefieldContent<U>,
    changes: readonly BattlefieldChange<U>[],
) {
    const units = copyOnWriteMap(previous.units);
    let blockingRelations = previous.blockingRelations;
    let supportRelations = previous.supportRelations;
    const mechanisms = copyOnWriteMap(previous.mechanisms);
    const removedUnits: {
        unitId: Id;
        reason: BattlefieldRemovalReason;
        unit: U;
    }[] = [];
    const registeredUnitIds: Id[] = [];
    const removedMechanisms: { mechanismId: MechanismId; reason: BattlefieldRemovalReason }[] = [];
    const updatedUnitIds = new Set<Id>();
    let unitMembershipChanged = false;

    for (const change of changes) {
        switch (change.type) {
            case "REGISTER_UNIT":
                assertNonnegativeSafeInteger(change.unit.id, "unit id");

                register(units.edit(), change.unit.id, change.unit, "unit");
                registeredUnitIds.push(change.unit.id);
                updatedUnitIds.add(change.unit.id);
                unitMembershipChanged = true;
                break;

            case "UPDATE_UNIT": {
                const previous = requireEntry(units.value, change.unit.id, "unit");

                if (previous.definition !== change.unit.definition) {
                    throw new RangeError("unit definition cannot change during update");
                }

                units.edit().set(change.unit.id, change.unit);
                updatedUnitIds.add(change.unit.id);
                break;
            }

            case "SET_BLOCKING_RELATIONS":
                blockingRelations = change.relations;
                break;

            case "SET_SUPPORT_RELATIONS":
                validateSupportRelations(units.value, change.relations);
                supportRelations = change.relations;
                break;

            case "RELEASE_BLOCKING_RELATIONS":
                blockingRelations = releaseBlockingRelations(blockingRelations, change.unitId);
                break;

            case "SET_POSITION_AND_RELEASE_BLOCKING": {
                const unit = requireEntry(units.value, change.unitId, "unit");
                units.edit().set(change.unitId, { ...unit, position: change.position });
                updatedUnitIds.add(change.unitId);
                blockingRelations = releaseBlockingRelations(blockingRelations, change.unitId);
                break;
            }

            case "REMOVE_UNIT": {
                const unit = requireEntry(units.value, change.unitId, "unit");
                units.edit().delete(change.unitId);
                updatedUnitIds.add(change.unitId);
                unitMembershipChanged = true;
                removedUnits.push({ unitId: change.unitId, reason: change.reason, unit });

                break;
            }

            case "REGISTER_MECHANISM":
                assertNonnegativeSafeInteger(change.mechanism.id, "mechanism id");
                register(mechanisms.edit(), change.mechanism.id, change.mechanism, "mechanism");
                break;

            case "UPDATE_MECHANISM": {
                const previous = requireEntry(mechanisms.value, change.mechanism.id, "mechanism");

                if (previous.definition !== change.mechanism.definition) {
                    throw new RangeError("mechanism definition cannot change during update");
                }

                mechanisms.edit().set(change.mechanism.id, change.mechanism);
                break;
            }

            case "SET_MECHANISM_ACTIVE":
                mechanisms.edit().set(change.mechanismId, {
                    ...requireEntry(mechanisms.value, change.mechanismId, "mechanism"),
                    active: change.active,
                });
                break;

            case "REMOVE_MECHANISM":
                requireEntry(mechanisms.value, change.mechanismId, "mechanism");
                mechanisms.edit().delete(change.mechanismId);
                removedMechanisms.push({
                    mechanismId: change.mechanismId,
                    reason: change.reason,
                });

                break;
        }
    }

    const dependencies: BattlefieldDependencyChanges = {
        updatedUnitIds,
        unitMembershipChanged,
    };

    return {
        content: {
            units: units.value,
            projectiles: previous.projectiles,
            mechanisms: mechanisms.value,
            blockingRelations,
            supportRelations,
        },
        dependencies,
        facts: {
            registeredUnitIds,
            removedUnits,
            removedMechanisms,
        },
    };
}
