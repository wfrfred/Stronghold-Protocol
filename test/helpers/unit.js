import { initialize as initializeUnit } from "../../dist/core/tactical/unit/initialize.js";
import { createBattleState, getUnit, updateUnit } from "../../dist/core/tactical/battle/state.js";
import { create } from "../../dist/core/tactical/battlefield/state.js";
import { createBattlefieldMap } from "../../dist/core/tactical/battlefield/map/map.js";
import { createTile } from "../../dist/core/tactical/battlefield/map/tile.js";
import { Definitions } from "../../dist/core/tactical/unit/action/definitions.js";

const tile = createTile({
    heightType: "LOWLAND", meleeBlockable: true, buildableType: "ALL", passableMask: "ALL",
    playerSideMask: "ALL", terrain: "NORMAL", mechanism: null,
});
const map = createBattlefieldMap(1, 32, Array(32).fill(tile));

export function fixtureBattle(tick = 0, execution = {}) {
    const battle = createBattleState(create({ map }));
    return { ...battle, tick, execution: { ...battle.execution, ...execution } };
}

export function fixtureDefinition(capability) {
    switch (capability) {
        case "offense": return { attack: 0 };
        case "vitality": return { maxHp: 100, defense: 0, resistance: 0 };
        case "action": return { definitions: Definitions.empty() };
        case "locomotion": return {
            halfBodyWidth: 0, minSpeed: 0, speed: 0,
            steeringParameters: { steeringFactor: 1, maxSteeringForce: 100 },
        };
        case "targetable": return { restrictions: [] };
        case "spatialPresence":
        case "occupancy": return {};
        default: throw new Error(`fixture definition required for ${capability}`);
    }
}

const definitions = new WeakMap();

export function initialize({ states = {}, tick = 0, definition, ...input }) {
    const additional = ["targetable", "spatialPresence", "occupancy"].filter(
        key => key in states && !(key in definition),
    );
    let paired = definition;
    if (additional.length) {
        let versions = definitions.get(definition);
        if (versions === undefined) definitions.set(definition, versions = new Map());
        const key = additional.join(":");
        paired = versions.get(key);
        if (paired === undefined) {
            paired = { ...definition, ...Object.fromEntries(additional.map(key => [key, fixtureDefinition(key)])) };
            versions.set(key, paired);
        }
    }
    for (const key of Object.keys(states)) {
        if (!(key in paired)) throw new Error(`prepared capability ${key} requires configuration`);
    }
    const result = initializeUnit(fixtureBattle(tick), { ...input, definition: paired });
    return { ...result.value, ...states };
}

export function placement({ states = {}, definition, ...input }) {
    return {
        ...input,
        definition: {
            ...definition,
            onEnter(battle, id) {
                const unit = getUnit(battle, id);
                const next = updateUnit(battle, { ...unit, ...states });
                return definition.onEnter?.(next, id) ?? next;
            },
        },
    };
}
