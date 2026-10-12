import assert from "node:assert/strict";
import { test } from "node:test";
import { createLegacyCombatSpec } from "../../dist/legacy/combat.js";
import { create, transition } from "../../dist/core/tactical/battlefield/state.js";
import { createBattleState, getUnit } from "../../dist/core/tactical/battle/state.js";
import { startAction } from "../../dist/core/tactical/unit/capability/action/execution.js";
import { CombatResources } from "../../dist/core/tactical/battle/resources.js";
import { initializeUnit } from "../../dist/core/tactical/unit/initialize.js";
import { createShapeGeometry } from "../../dist/core/tactical/geometry/shape.js";
import { createActionDefinition } from "../../dist/core/tactical/unit/capability/action/capability.js";
import { compileAction } from "../../dist/core/tactical/unit/capability/action/compile.js";

test("action event order: lethal damage settles support loss before the action finishes", () => {
    const geometry = createShapeGeometry({
        shapes: [{ type: "CIRCLE", offset: [0, 0], radius: 5 }],
    });
    const action = createActionDefinition({
        triggerBindingId: "primary",
        baseAttackTimeTicks: 10,
        recoveryTicks: 0,
        targetGroups: [{
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
            operations: [{ type: "DAMAGE", power: 10, damageType: "TRUE" }],
        }],
        followUps: [],
    });
    const common = {
        spatial: Object.freeze({ layer: "GROUND" }),
        hit: Object.freeze({ geometry }),
        status: Object.freeze({ initialFlags: Object.freeze([]) }),
        defense: Object.freeze({ defense: 0, resistance: 0 }),
    };
    const attacker = initializeUnit({
        id: 0,
        position: [0, 0],
        definition: Object.freeze({
            ...common,
            id: "attacker",
            vitality: Object.freeze({ maxHp: 100 }),
            allegiance: Object.freeze({ side: "ALLY" }),
            action: Object.freeze({ normalAction: action }),
        }),
    });
    const support = initializeUnit({
        id: 1,
        position: [1, 0],
        definition: Object.freeze({
            ...common,
            id: "support",
            vitality: Object.freeze({ maxHp: 1 }),
            allegiance: Object.freeze({ side: "ENEMY" }),
            tileBinding: Object.freeze({
                heightType: "HIGHLAND",
                buildableType: "ALL",
                advancedBuildableMask: null,
            }),
        }),
        states: { occupancy: { claims: [{ position: [0, 1], slot: "SUPPORT", type: "PRESENT" }] } },
    });
    const recipient = initializeUnit({
        id: 2,
        position: [1, 0],
        definition: Object.freeze({
            ...common,
            id: "supported",
            vitality: Object.freeze({ maxHp: 100 }),
            allegiance: Object.freeze({ side: "ENEMY" }),
        }),
        states: { occupancy: { claims: [{ position: [0, 1], slot: "DEPLOYMENT", type: "PRESENT" }] } },
    });
    const spec = createLegacyCombatSpec({
        rows: 1, columns: 4, operators: [], enemies: [], maxTicks: 10, seed: 17,
    });
    const battlefield = transition(create({ map: spec.map }), [
        ...[attacker, support, recipient].map(unit => ({ type: "REGISTER_UNIT", unit })),
        { type: "SET_SUPPORT_RELATIONS", relations: [{ supportedUnitId: 2, supportUnitId: 1 }] },
    ]).state;
    const resources = new CombatResources();
    const compiled = compileAction(action, resources);
    const output = startAction(createBattleState(battlefield), {
      sourceUnitId: 0, compiled: { ...compiled, program: [{ type: "RELEASE", markerId: "damage" }, ...compiled.program] }, tick: 0, mayStart: true,
    }, resources);

    assert.deepEqual(output.events.map(event => event.type), [
        "ACTION", "ACTION_RELEASED", "DAMAGE", "SUPPORT_LOST", "ACTION_FINISHED",
    ]);
    const lost = output.events.find(event => event.type === "SUPPORT_LOST");
    assert.equal(lost.supportedUnitId, 2);
    assert.equal(lost.supportUnitId, 1);
    assert.equal(getUnit(output, 1), undefined);
    assert.equal(getUnit(output, 2).vitality.hp, 100);
    assert.deepEqual(output.battlefield.supportRelations, []);
});
