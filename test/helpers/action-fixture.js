import { initializeUnit } from "../../dist/core/tactical/unit/initialize.js";
import { createBattleState } from "../../dist/core/tactical/battle/state.js";
import {
    create as createBattlefield,
    transition,
} from "../../dist/core/tactical/battlefield/state.js";
import { createBattlefieldMap } from "../../dist/core/tactical/battlefield/map/map.js";
import { createTile } from "../../dist/core/tactical/battlefield/map/tile.js";
import { createShapeGeometry } from "../../dist/core/tactical/geometry/shape.js";
import { createActionDefinition } from "../../dist/core/tactical/unit/capability/action/capability.js";

export const geometry = createShapeGeometry({
    shapes: [{ type: "CIRCLE", offset: [0, 0], radius: 10 }],
});
const hit = createShapeGeometry({ shapes: [{ type: "CIRCLE", offset: [0, 0], radius: 0.1 }] });
const tile = createTile({
    heightType: "LOWLAND",
    buildableType: "ALL",
    passableMask: "ALL",
    playerSideMask: "ALL",
    terrain: "NORMAL",
    mechanism: null,
});
export const map = createBattlefieldMap(1, 32, Array(32).fill(tile));

export function actionDefinition(power = 7, extra = {}) {
    return createActionDefinition({
        triggerBindingId: "primary",
        baseAttackTimeTicks: 10,
        recoveryTicks: 0,
        targetGroups: [
            {
                id: "primary",
                targeting: {
                    type: "DAMAGE",
                    scope: { type: "RANGE", geometry: { type: "SHAPES", geometry } },
                    canTargetAir: true,
                    includeBlockingRelations: false,
                    preferBlockingRelations: false,
                    ignoreTargetFree: false,
                    ignoreInvisible: false,
                    maxTargets: 1,
                },
                operations: [{ type: "DAMAGE", power, damageType: "TRUE" }],
            },
        ],
        followUps: [],
        ...extra,
    });
}

export function unit(
    id,
    { hp = 100, side = id === 0 ? "ALLY" : "ENEMY", action = false, ...fields } = {},
) {
    const definition = {
        id: `action-${id}`,
        vitality: { maxHp: hp },
        offense: { attack: 10 },
        defense: { defense: 0, resistance: 0 },
        allegiance: { side },
        spatial: { layer: "GROUND" },
        hit: { geometry: hit },
        status: { initialFlags: [] },
        ...(action
            ? { action: { normalAction: action === true ? actionDefinition() : action } }
            : {}),
        ...fields,
    };
    for (const [key, value] of Object.entries(definition))
        if (value === undefined) delete definition[key];
    return initializeUnit({ id, position: [id, 0], definition });
}

export function battle(...units) {
    const battlefield = transition(
        createBattlefield({ map }),
        units.map((unit) => ({ type: "REGISTER_UNIT", unit })),
    ).state;
    return createBattleState(battlefield);
}

export function assertData(assert, value) {
    assert.notEqual(typeof value, "function");
    assert.equal(value instanceof Map, false);
    if (value !== null && typeof value === "object") {
        for (const child of Object.values(value)) assertData(assert, child);
    }
}
