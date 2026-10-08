import assert from "node:assert/strict";
import { test } from "node:test";
import { createLegacyCombatSpec } from "../../dist/legacy/combat.js";
import { createBattleSystems } from "../../dist/core/tactical/battle/systems.js";
import { BattlefieldRuntime } from "../../dist/core/tactical/battlefield/runtime.js";
import { initializeUnit } from "../../dist/core/tactical/unit/initialize.js";
import { copyUnitSnapshot } from "../../dist/core/tactical/unit/snapshot.js";
import { createShapeGeometry } from "../../dist/core/tactical/geometry/shape.js";
import { createActionDefinition } from "../../dist/core/tactical/unit/capability/action/capability.js";
import { compileAction } from "../../dist/core/tactical/unit/capability/action/compile.js";

test("action event order: release and damage precede support loss produced by the phase commit", () => {
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
    const battlefield = BattlefieldRuntime.create({ map: spec.map }, copyUnitSnapshot);
    battlefield.apply([
        ...[attacker, support, recipient].map(unit => ({ type: "REGISTER_UNIT", unit })),
        { type: "SET_SUPPORT_RELATIONS", relations: [{ supportedUnitId: 2, supportUnitId: 1 }] },
    ]);
    const systems = createBattleSystems(spec, {
        compileAction: (definition, resources) => {
            const compiled = compileAction(definition, resources);

            return {
                ...compiled,
                program: [
                    { type: "RELEASE", markerId: "damage" },
                    ...compiled.program,
                ],
            };
        },
    });
    const initialized = systems.initialize(battlefield, {
        rngState: 17,
        nextUnitId: 3,
        nextNavigationRequestId: 0,
        nextMechanismId: 0,
        nextNavigationModifierId: 0,
    });
    const output = systems.step(battlefield, initialized.states, initialized.execution, 0, []);

    assert.deepEqual(output.events.map(event => event.type), [
        "ACTION", "ACTION_RELEASED", "DAMAGE", "ACTION_FINISHED", "SUPPORT_LOST", "UNIT_REMOVED",
    ]);
    const lost = output.events.find(event => event.type === "SUPPORT_LOST");
    assert.equal(lost.supportedUnitId, 2);
    assert.equal(lost.supportUnitId, 1);
    assert.equal(battlefield.getUnit(1), undefined);
    assert.equal(battlefield.getUnit(2).vitality.hp, 100);
    assert.deepEqual(battlefield.supportRelations, []);
});
