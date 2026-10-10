import { assertNonnegativeSafeInteger } from "../../../common/assert.js";
import type { StableUnit, Unit, UnitId } from "../../unit/unit.js";
import {
    assertUnitCapabilityComposition,
    assertUnitCapabilityPairing,
} from "../../unit/capability/catalog.js";
import { releaseBlockingRelations } from "../blocking/relations.js";
import type { BattlefieldChange, BattlefieldRemovalReason } from "../contract.js";
import type { MechanismId } from "../mechanism.js";
import type { NavigationModifierId } from "../navigation/modifier.js";
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
    previous: BattlefieldContent<StableUnit<U>>,
    changes: readonly BattlefieldChange<StableUnit<U>>[],
) {
    const units = copyOnWriteMap(previous.units);
    const projectiles = copyOnWriteMap(previous.projectiles);
    let blockingRelations = previous.blockingRelations;
    let supportRelations = previous.supportRelations;
    const mechanisms = copyOnWriteMap(previous.mechanisms);
    const navigationModifiers = copyOnWriteMap(previous.navigationModifiers);
    const removedUnits: {
        unitId: UnitId;
        reason: BattlefieldRemovalReason;
        unit: StableUnit<U>;
    }[] = [];
    const registeredUnitIds: UnitId[] = [];
    const removedMechanisms: { mechanismId: MechanismId; reason: BattlefieldRemovalReason }[] = [];
    const removedNavigationModifiers = new Set<NavigationModifierId>();
    const updatedUnitIds = new Set<UnitId>();
    const updatedMechanismIds = new Set<MechanismId>();
    const updatedNavigationModifierIds = new Set<NavigationModifierId>();
    let unitMembershipChanged = false;
    let navigationModifierMembershipChanged = false;

    const removeNavigationModifier = (id: NavigationModifierId): void => {
        navigationModifiers.edit().delete(id);
        updatedNavigationModifierIds.add(id);
        navigationModifierMembershipChanged = true;
        removedNavigationModifiers.add(id);
    };

    for (const change of changes) {
        switch (change.type) {
            case "REGISTER_PROJECTILE":
                assertNonnegativeSafeInteger(change.projectile.id, "projectile id");
                register(projectiles.edit(), change.projectile.id, change.projectile, "projectile");
                break;

            case "UPDATE_PROJECTILE": {
                const previous = requireEntry(
                    projectiles.value,
                    change.projectile.id,
                    "projectile",
                );

                if (previous.definitionRef.id !== change.projectile.definitionRef.id) {
                    throw new RangeError("projectile definition cannot change during update");
                }

                projectiles.edit().set(change.projectile.id, change.projectile);
                break;
            }

            case "REMOVE_PROJECTILE":
                requireEntry(projectiles.value, change.projectileId, "projectile");
                projectiles.edit().delete(change.projectileId);
                break;

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

                for (const navigationModifier of navigationModifiers.value.values()) {
                    const ownedOrAnchoredByUnit =
                        (navigationModifier.source.type === "UNIT" &&
                            navigationModifier.source.unitId === change.unitId) ||
                        (navigationModifier.region.type === "FOLLOW_UNIT" &&
                            navigationModifier.region.unitId === change.unitId);

                    if (ownedOrAnchoredByUnit) {
                        removeNavigationModifier(navigationModifier.id);
                    }
                }

                break;
            }

            case "REGISTER_MECHANISM":
                assertNonnegativeSafeInteger(change.mechanism.id, "mechanism id");
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

                for (const navigationModifier of navigationModifiers.value.values()) {
                    if (
                        navigationModifier.source.type === "MECHANISM" &&
                        navigationModifier.source.mechanismId === change.mechanismId
                    ) {
                        removeNavigationModifier(navigationModifier.id);
                    }
                }

                break;

            case "ADD_NAVIGATION_MODIFIER":
                assertNonnegativeSafeInteger(
                    change.navigationModifier.id,
                    "navigation modifier id",
                );
                register(
                    navigationModifiers.edit(),
                    change.navigationModifier.id,
                    change.navigationModifier,
                    "navigation modifier",
                );
                updatedNavigationModifierIds.add(change.navigationModifier.id);
                navigationModifierMembershipChanged = true;
                break;

            case "SET_NAVIGATION_MODIFIER_ACTIVE":
                navigationModifiers.edit().set(change.navigationModifierId, {
                    ...requireEntry(
                        navigationModifiers.value,
                        change.navigationModifierId,
                        "navigation modifier",
                    ),
                    active: change.active,
                });
                updatedNavigationModifierIds.add(change.navigationModifierId);
                break;

            case "SET_NAVIGATION_MODIFIER_REGION":
                navigationModifiers.edit().set(change.navigationModifierId, {
                    ...requireEntry(
                        navigationModifiers.value,
                        change.navigationModifierId,
                        "navigation modifier",
                    ),
                    region: change.region,
                });
                updatedNavigationModifierIds.add(change.navigationModifierId);
                break;

            case "REMOVE_NAVIGATION_MODIFIER":
                requireEntry(
                    navigationModifiers.value,
                    change.navigationModifierId,
                    "navigation modifier",
                );
                removeNavigationModifier(change.navigationModifierId);
                break;

            case "EXPIRE_NAVIGATION_MODIFIERS":
                assertNonnegativeSafeInteger(change.tick, "navigation modifier expiry tick");

                for (const navigationModifier of navigationModifiers.value.values()) {
                    if (
                        navigationModifier.expiresAtTick !== null &&
                        navigationModifier.expiresAtTick <= change.tick
                    ) {
                        removeNavigationModifier(navigationModifier.id);
                    }
                }

                break;
        }
    }

    const dependencies: BattlefieldDependencyChanges = {
        updatedUnitIds,
        updatedMechanismIds,
        updatedNavigationModifierIds,
        unitMembershipChanged,
        navigationModifierMembershipChanged,
    };

    return {
        content: {
            units: units.value,
            projectiles: projectiles.value,
            mechanisms: mechanisms.value,
            navigationModifiers: navigationModifiers.value,
            blockingRelations,
            supportRelations,
        },
        dependencies,
        facts: {
            registeredUnitIds,
            removedUnits,
            removedMechanisms,
            removedNavigationModifiers: [...removedNavigationModifiers],
        },
    };
}
