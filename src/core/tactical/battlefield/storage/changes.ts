import { assertNonnegativeSafeInteger } from "../../../common/assert.js";
import { createWorldPosition } from "../../geometry/coordinate.js";
import type { StableUnit, Unit, UnitId } from "../../unit/unit.js";
import {
    assertUnitCapabilityComposition,
    assertUnitCapabilityPairing,
} from "../../unit/capability/catalog.js";
import { releaseBlockingRelations } from "../blocking/relations.js";
import type { BattlefieldChange, BattlefieldRemovalReason } from "../contract.js";
import { createMechanismRuntime, type MechanismId } from "../mechanism.js";
import {
    createNavigationSpatialEffect,
    createSpatialEffectRegion,
    type SpatialEffectId,
} from "../navigation/effect.js";
import type { BattlefieldContent } from "./state.js";
import type { BattlefieldDependencyChanges } from "./dependencies.js";
import { validateSupportRelations } from "../support/relations.js";

export function ownBattlefieldChanges<U extends Unit>(
    changes: readonly BattlefieldChange<U>[],
    copyUnit: (unit: Readonly<U>) => U,
): BattlefieldChange<U>[] {
    return changes.map((change): BattlefieldChange<U> => {
        switch (change.type) {
            case "REGISTER_UNIT":
            case "UPDATE_UNIT":
                return { ...change, unit: copyUnit(change.unit) };

            case "SET_BLOCKING_RELATIONS":
                return {
                    ...change,
                    relations: change.relations.map((relation) => ({ ...relation })),
                };

            case "SET_SUPPORT_RELATIONS":
                return {
                    ...change,
                    relations: change.relations.map((relation) => ({ ...relation })),
                };

            case "REGISTER_MECHANISM":
            case "UPDATE_MECHANISM":
                return {
                    ...change,
                    mechanism: createMechanismRuntime(change.mechanism),
                };

            case "ADD_EFFECT":
                return { ...change, effect: createNavigationSpatialEffect(change.effect) };

            case "SET_POSITION_AND_RELEASE_BLOCKING":
                return { ...change, position: createWorldPosition(...change.position) };

            case "SET_EFFECT_REGION":
                return { ...change, region: createSpatialEffectRegion(change.region) };

            case "EXPIRE_EFFECTS":
            case "RELEASE_BLOCKING_RELATIONS":
            case "REMOVE_EFFECT":
            case "REMOVE_MECHANISM":
            case "REMOVE_UNIT":
            case "SET_EFFECT_ACTIVE":
            case "SET_MECHANISM_ACTIVE":
            default:
                return change;
        }
    });
}

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
    previous: BattlefieldContent<StableUnit<U>>,
    changes: readonly BattlefieldChange<StableUnit<U>>[],
) {
    const units = copyOnWriteMap(previous.units);
    let blockingRelations = previous.blockingRelations;
    let supportRelations = previous.supportRelations;
    const mechanisms = copyOnWriteMap(previous.mechanisms);
    const effects = copyOnWriteMap(previous.effects);
    const removedUnits: {
        unitId: UnitId;
        reason: BattlefieldRemovalReason;
        unit: StableUnit<U>;
    }[] = [];
    const registeredUnitIds: UnitId[] = [];
    const removedMechanisms: { mechanismId: MechanismId; reason: BattlefieldRemovalReason }[] = [];
    const removedEffects = new Set<SpatialEffectId>();
    const updatedUnitIds = new Set<UnitId>();
    const updatedMechanismIds = new Set<MechanismId>();
    const updatedEffectIds = new Set<SpatialEffectId>();
    let unitMembershipChanged = false;
    let effectMembershipChanged = false;

    const removeEffect = (id: SpatialEffectId): void => {
        effects.edit().delete(id);
        updatedEffectIds.add(id);
        effectMembershipChanged = true;
        removedEffects.add(id);
    };

    for (const change of changes) {
        switch (change.type) {
            case "REGISTER_UNIT":
                assertNonnegativeSafeInteger(change.unit.id, "unit id");
                assertUnitCapabilityPairing(change.unit);

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

                assertUnitCapabilityComposition(previous, change.unit);

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

                for (const effect of effects.value.values()) {
                    const ownedOrAnchoredByUnit =
                        (effect.source.type === "UNIT" && effect.source.unitId === change.unitId) ||
                        (effect.region.type === "FOLLOW_UNIT" &&
                            effect.region.unitId === change.unitId);

                    if (ownedOrAnchoredByUnit) {
                        removeEffect(effect.id);
                    }
                }

                break;
            }

            case "REGISTER_MECHANISM":
                register(mechanisms.edit(), change.mechanism.id, change.mechanism, "mechanism");
                updatedMechanismIds.add(change.mechanism.id);
                break;

            case "UPDATE_MECHANISM": {
                const previous = requireEntry(mechanisms.value, change.mechanism.id, "mechanism");

                if (previous.definition !== change.mechanism.definition) {
                    throw new RangeError("mechanism definition cannot change during update");
                }

                mechanisms.edit().set(change.mechanism.id, change.mechanism);
                updatedMechanismIds.add(change.mechanism.id);
                break;
            }

            case "SET_MECHANISM_ACTIVE":
                mechanisms.edit().set(change.mechanismId, {
                    ...requireEntry(mechanisms.value, change.mechanismId, "mechanism"),
                    active: change.active,
                });
                updatedMechanismIds.add(change.mechanismId);
                break;

            case "REMOVE_MECHANISM":
                requireEntry(mechanisms.value, change.mechanismId, "mechanism");
                mechanisms.edit().delete(change.mechanismId);
                updatedMechanismIds.add(change.mechanismId);
                removedMechanisms.push({
                    mechanismId: change.mechanismId,
                    reason: change.reason,
                });

                for (const effect of effects.value.values()) {
                    if (
                        effect.source.type === "MECHANISM" &&
                        effect.source.mechanismId === change.mechanismId
                    ) {
                        removeEffect(effect.id);
                    }
                }

                break;

            case "ADD_EFFECT":
                register(effects.edit(), change.effect.id, change.effect, "effect");
                updatedEffectIds.add(change.effect.id);
                effectMembershipChanged = true;
                break;

            case "SET_EFFECT_ACTIVE":
                effects.edit().set(change.effectId, {
                    ...requireEntry(effects.value, change.effectId, "effect"),
                    active: change.active,
                });
                updatedEffectIds.add(change.effectId);
                break;

            case "SET_EFFECT_REGION":
                effects.edit().set(change.effectId, {
                    ...requireEntry(effects.value, change.effectId, "effect"),
                    region: change.region,
                });
                updatedEffectIds.add(change.effectId);
                break;

            case "REMOVE_EFFECT":
                requireEntry(effects.value, change.effectId, "effect");
                removeEffect(change.effectId);
                break;

            case "EXPIRE_EFFECTS":
                assertNonnegativeSafeInteger(change.tick, "effect expiry tick");

                for (const effect of effects.value.values()) {
                    if (effect.expiresAtTick !== null && effect.expiresAtTick <= change.tick) {
                        removeEffect(effect.id);
                    }
                }

                break;
        }
    }

    const dependencies: BattlefieldDependencyChanges = {
        updatedUnitIds,
        updatedMechanismIds,
        updatedEffectIds,
        unitMembershipChanged,
        effectMembershipChanged,
    };

    return {
        content: {
            units: units.value,
            mechanisms: mechanisms.value,
            effects: effects.value,
            blockingRelations,
            supportRelations,
        },
        dependencies,
        facts: {
            registeredUnitIds,
            removedUnits,
            removedMechanisms,
            removedEffects: [...removedEffects],
        },
    };
}
