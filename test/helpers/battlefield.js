import { create, transition } from "../../dist/core/tactical/battlefield/state.js";
import { createBattlefieldRuntime } from "../../dist/core/tactical/battlefield/runtime.js";
import { createBattlefieldMap } from "../../dist/core/tactical/battlefield/map/map.js";
import { createTile } from "../../dist/core/tactical/battlefield/map/tile.js";

const tile = createTile({
    heightType: "LOWLAND",
    buildableType: "ALL",
    passableMask: "ALL",
    playerSideMask: "ALL",
    terrain: "NORMAL",
    mechanism: null,
});
const defaultMap = createBattlefieldMap(1, 32, Array(32).fill(tile));

/** Build a real, published battlefield from the entities supplied by a test fixture. */
export function fixtureBattlefield(view, mechanisms = view) {
    if (typeof view.advance === "function") return view;
    const units = Array.isArray(view) ? view : view.unitIds.map((id) => view.getUnit(id));
    const field = createBattlefieldRuntime({
        map: Array.isArray(view) ? defaultMap : (view.map ?? defaultMap),
    });
    const changes = units.map((unit) => ({ type: "REGISTER_UNIT", unit }));
    for (const id of mechanisms?.mechanismIds ?? []) {
        changes.push({ type: "REGISTER_MECHANISM", mechanism: mechanisms.getMechanism(id) });
    }
    for (const id of view.projectileIds ?? []) {
        changes.push({ type: "REGISTER_PROJECTILE", projectile: view.getProjectile(id) });
    }
    for (const id of view.navigationModifierIds ?? []) {
        changes.push({
            type: "ADD_NAVIGATION_MODIFIER",
            navigationModifier: view.getNavigationModifier(id),
        });
    }
    const relations =
        view.blockingRelations ??
        units.flatMap((unit) => {
            const blockerUnitId = view.blockerOf?.(unit.id);
            return blockerUnitId === undefined ? [] : [{ blockerUnitId, blockedUnitId: unit.id }];
        });
    if (relations.length > 0) changes.push({ type: "SET_BLOCKING_RELATIONS", relations });
    if ((view.supportRelations?.length ?? 0) > 0)
        changes.push({ type: "SET_SUPPORT_RELATIONS", relations: view.supportRelations });
    field.advance(changes);
    field.apply();
    return field;
}

export function fixtureBattlefieldState(input, mechanisms = input) {
    if (input.units instanceof Map && input.baseline !== undefined) return input;
    const facts = typeof input.snapshot === "function" ? input.snapshot("draft") : input;
    const units = Array.isArray(facts) ? facts : facts.unitIds.map((id) => facts.getUnit(id));
    const state = create({ map: Array.isArray(facts) ? defaultMap : (facts.map ?? defaultMap) });
    const changes = units.map((unit) => ({ type: "REGISTER_UNIT", unit }));
    const mechanismFacts =
        typeof mechanisms.snapshot === "function" ? mechanisms.snapshot("draft") : mechanisms;
    for (const id of mechanismFacts?.mechanismIds ?? [])
        changes.push({ type: "REGISTER_MECHANISM", mechanism: mechanismFacts.getMechanism(id) });
    for (const id of facts.projectileIds ?? [])
        changes.push({ type: "REGISTER_PROJECTILE", projectile: facts.getProjectile(id) });
    for (const id of facts.navigationModifierIds ?? [])
        changes.push({
            type: "ADD_NAVIGATION_MODIFIER",
            navigationModifier: facts.getNavigationModifier(id),
        });
    const relations =
        facts.blockingRelations ??
        units.flatMap((unit) => {
            const blockerUnitId = facts.blockerOf?.(unit.id);
            return blockerUnitId === undefined ? [] : [{ blockerUnitId, blockedUnitId: unit.id }];
        });
    if (relations.length) changes.push({ type: "SET_BLOCKING_RELATIONS", relations });
    if (facts.supportRelations?.length)
        changes.push({ type: "SET_SUPPORT_RELATIONS", relations: facts.supportRelations });
    return transition(state, changes).state;
}
