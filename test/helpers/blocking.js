import { initialize } from "./unit.js";
import {
    createBattleState,
    getUnit,
    registerUnit,
    updateUnit,
} from "../../dist/core/tactical/battle/state.js";
import { create } from "../../dist/core/tactical/battlefield/state.js";
import { createBattlefieldMap } from "../../dist/core/tactical/battlefield/map/map.js";
import { createTile } from "../../dist/core/tactical/battlefield/map/tile.js";
import * as blocking from "../../dist/core/tactical/battle/blocking/operations.js";
import * as query from "../../dist/core/tactical/battle/blocking/query.js";
import * as blocker from "../../dist/core/tactical/unit/capability/blocking/blocker.js";
import * as attribute from "../../dist/core/tactical/unit/contribution/attribute.js";

export function fixture(units = [], { rows = 3, columns = 12 } = {}) {
    const tile = createTile({
        heightType: "LOWLAND", meleeBlockable: true, buildableType: "ALL", passableMask: "ALL",
        playerSideMask: "ALL", terrain: "NORMAL", mechanism: null,
    });
    const map = createBattlefieldMap(rows, columns, Array(rows * columns).fill(tile));
    let battle = createBattleState(create({ map }));
    for (const unit of units) battle = registerUnit(battle, unit);
    return battle;
}

export function holder(id = 10, { position = [2, 1], capacity = 1, radius = 1, side = "ALLY", definition = {}, states = {} } = {}) {
    return initialize({
        id, position,
        definition: {
            id: `blocking-holder-${id}`,
            ...(side === undefined ? {} : { allegiance: { side } }),
            spatialPresence: {}, vitality: { maxHp: 100, defense: 0, resistance: 0 },
            blocker: { capacity, geometry: { radius } },
            ...definition,
        },
        states,
    });
}

export function target(id = 20, { position = [2.25, 1], volume = 1, side = "ENEMY", definition = {}, states = {} } = {}) {
    return initialize({
        id, position,
        definition: {
            id: `blocking-target-${id}`,
            ...(side === undefined ? {} : { allegiance: { side } }),
            spatialPresence: {}, vitality: { maxHp: 100, defense: 0, resistance: 0 },
            layer: { type: "GROUND" }, blockable: { volume },
            ...definition,
        },
        states,
    });
}

export function change(battle, id, transform) {
    return updateUnit(battle, transform(getUnit(battle, id)));
}

export function acquire(battle, id = 10) {
    return blocking.search(battle, { id });
}

export function blockedIds(battle, id = 10) {
    return query.blocked(battle, { id }).map(ref => ref.id);
}

export function ownerId(battle, id = 20) {
    return query.blockerOf(battle, { id })?.id;
}

export function capacity(battle, id, value) {
    return change(battle, id, unit => ({
        ...unit,
        blocker: blocker.setCapacityContribution(unit.blocker, {
            id: "test-capacity", value: [attribute.create({ addition: value - unit.definition.blocker.capacity })],
        }),
    }));
}

export function hook(id, invoke, accepts) {
    return {
        id,
        ...(accepts === undefined ? {} : { accepts }),
        invoke(battle, context) {
            return { state: invoke(battle, context), value: undefined };
        },
    };
}
