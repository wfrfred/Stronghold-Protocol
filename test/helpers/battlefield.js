import { create, transition } from "../../dist/core/tactical/battlefield/state.js";
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

export function fixtureBattlefieldState(input, mechanisms = input) {
    if (input.units instanceof Map && input.baseline !== undefined) return input;
    const units = Array.isArray(input) ? input : input.unitIds.map((id) => input.getUnit(id));
    let state = create({ map: Array.isArray(input) ? defaultMap : (input.map ?? defaultMap) });
    const changes = units.map((unit) => ({ type: "REGISTER_UNIT", unit }));
    for (const id of mechanisms?.mechanismIds ?? [])
        changes.push({ type: "REGISTER_MECHANISM", mechanism: mechanisms.getMechanism(id) });
    for (const id of input.projectileIds ?? [])
        state = { ...state, projectiles: state.projectiles.add(input.getProjectile(id)) };
    for (const id of input.navigationModifierIds ?? [])
        changes.push({
            type: "ADD_NAVIGATION_MODIFIER",
            navigationModifier: input.getNavigationModifier(id),
        });
    const relations =
        input.blockingRelations ??
        units.flatMap((unit) => {
            const blockerUnitId = input.blockerOf?.(unit.id);
            return blockerUnitId === undefined ? [] : [{ blockerUnitId, blockedUnitId: unit.id }];
        });
    if (relations.length) changes.push({ type: "SET_BLOCKING_RELATIONS", relations });
    if (input.supportRelations?.length)
        changes.push({ type: "SET_SUPPORT_RELATIONS", relations: input.supportRelations });
    return transition(state, changes).state;
}
