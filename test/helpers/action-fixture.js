import { damage as damageTargeting, healing as healingTargeting } from "./targeting.js";
import {
    create as createBattlefield,
    addUnits,
} from "../../dist/core/tactical/battlefield/state.js";
import { createBattleState } from "../../dist/core/tactical/battle/state.js";
import { createBattlefieldMap } from "../../dist/core/tactical/battlefield/map/map.js";
import { createTile } from "../../dist/core/tactical/battlefield/map/tile.js";
import { initialize } from "./unit.js";
import { Definitions } from "../../dist/core/tactical/unit/action/definitions.js";
import { create as createAttack } from "../../dist/content/tactical/actions/attack.js";

export const geometry = [{ type: "CIRCLE", offset: [0, 0], radius: 10 }];
const hit = { type: "CIRCLE", offset: [0, 0], radius: 0.1 };
const tile = createTile({
    heightType: "LOWLAND", meleeBlockable: true,
    buildableType: "ALL",
    passableMask: "ALL",
    playerSideMask: "ALL",
    terrain: "NORMAL",
    mechanism: null,
});
export const map = createBattlefieldMap(1, 32, Array(32).fill(tile));

export function actionDefinition(power = 7, extra = {}) {
    const { baseAttackTimeTicks = 10, ...configuration } = extra;
    return createAttack(
        {
            id: "primary",
            intervalTicks: baseAttackTimeTicks,
            speed: 100,
            triggerBindingId: "primary",
            targetGroups: [
                {
                    id: "primary",
                    targeting: damageTargeting({
                        type: "DAMAGE",
                        scope: { type: "RANGE", geometry },
                        canTargetAir: true,
                        includeBlockingRelations: false,
                        preferBlockingRelations: false,
                        ignoreTargetFree: false,
                        ignoreInvisible: false,
                        maxTargets: 1,
                    }),
                    operations: [{ type: "DAMAGE", power, damageType: "TRUE" }],
                },
            ],
            followUps: [],
            ...configuration,
        },
    );
}

export function unit(
    id,
    { hp = 100, side = id === 0 ? "ALLY" : "ENEMY", action = false, ...fields } = {},
) {
    const capability =
        action === false
            ? undefined
            : action === true
              ? { definitions: Definitions.empty().add(actionDefinition()) }
              : "definitions" in action
                ? action
                : { definitions: Definitions.empty().add(action) };
    const definition = {
        id: `action-${id}`,
        vitality: { maxHp: hp, defense: 0, resistance: 0 },
        targetable: { restrictions: [] }, spatialPresence: {}, occupancy: {},
        offense: { attack: 10 },
        allegiance: { side },
        layer: { type: "GROUND" },
        hitbox: { shape: hit },
        ...(capability === undefined ? {} : { action: capability }),
        ...fields,
    };
    for (const [key, value] of Object.entries(definition))
        if (value === undefined) delete definition[key];
    return initialize({ id, position: [id, 0], definition });
}

export function battle(...units) {
    return createBattleState(
        addUnits(createBattlefield({ map }), units),
    );
}

export function assertData(assert, value) {
    assert.notEqual(typeof value, "function");
    assert.equal(value instanceof Map, false);
    if (value !== null && typeof value === "object")
        for (const child of Object.values(value)) assertData(assert, child);
}
