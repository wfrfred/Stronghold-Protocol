import { maintain } from "../../dist/core/tactical/battlefield/storage/state.js";
import { create } from "../../dist/core/tactical/battlefield/state.js";
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
    if (input.units instanceof Map && input.navigation !== undefined) return input;
    const units = Array.isArray(input) ? input : input.unitIds.map((id) => input.getUnit(id));
    let state = create({ map: Array.isArray(input) ? defaultMap : (input.map ?? defaultMap) });
    if (input.navigation !== undefined) state = { ...state, navigation: input.navigation };
    const registeredMechanisms = (mechanisms?.mechanismIds ?? []).map(id => [id, mechanisms.getMechanism(id)]);
    for (const id of input.projectileIds ?? [])
        state = { ...state, projectiles: state.projectiles.add(input.getProjectile(id)) };
    const relations =
        input.blockingRelations ??
        units.flatMap((unit) => {
            const blockerUnitId = input.blockerOf?.(unit.id);
            return blockerUnitId === undefined ? [] : [{ blockerUnitId, blockedUnitId: unit.id }];
        });
    return maintain(state, {
        ...state,
        units: new Map(units.map(unit => [unit.id, unit])),
        mechanisms: new Map(registeredMechanisms),
        blockingRelations: relations.length ? relations : state.blockingRelations,
        supportRelations: input.supportRelations?.length ? input.supportRelations : state.supportRelations,
    });
}
