import { definition as skillDefinition } from "../helpers/skill.js";
import { Definitions } from '../../dist/core/tactical/unit/action/definitions.js';
import { create as createAttack } from '../../dist/content/tactical/actions/attack.js';
import { Effects } from "../../dist/core/tactical/unit/effect/effects.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { create as createFieldState, transition as transitionBattlefield } from '../../dist/core/tactical/battlefield/state.js';
import { view as viewBattlefield } from '../../dist/core/tactical/battlefield/view.js';
import { createBattlefieldMap } from "../../dist/core/tactical/battlefield/map/map.js";
import { createTile } from "../../dist/core/tactical/battlefield/map/tile.js";
import { initialize } from "../helpers/unit.js";
import { copy } from "../../dist/core/tactical/unit/snapshot.js";
import { createDefinition as createActionCapabilityDefinition } from "../../dist/core/tactical/unit/capability/action/capability.js";

const map = () =>
    createBattlefieldMap(
        1,
        3,
        Array.from({ length: 3 }, () =>
            createTile({
                heightType: "LOWLAND",
                buildableType: "ALL",
                passableMask: "ALL",
                playerSideMask: "ALL",
                terrain: "NORMAL",
                mechanism: null,
            }),
        ),
    );

const definition = () => ({
    id: "paired-capabilities",
    targetable: {}, spatialPresence: {}, occupancy: {}, tileBinding: { heightType: null, buildableType: "ALL", advancedBuildableMask: null },
    deployable: {
        cost: 10,
        redeployTicks: 30,
        slots: 1,
        buildableType: "MELEE",
        advancedBuildableMask: 1,
        refund: { rate: 0.5, limit: "BASE_COST" },
    },
    vitality: { maxHp: 100 },
    offense: { attack: 10 },
    defense: { defense: 20, resistance: 10 },
    action: createActionCapabilityDefinition({ definitions: Definitions.empty().add(createAttack({ id: 'normal', speed: 100,
            triggerBindingId: "primary",
            intervalTicks: 3,
            recoveryTicks: 0,
            followUps: [],
            targetGroups: [
                {
                    id: "primary",
                    operations: [{ type: "DAMAGE", power: 10, damageType: "PHYSICAL" }],
                    targeting: {
                        type: "DAMAGE",
                        scope: {
                            type: "RANGE",
                            geometry: {
                                type: "SHAPES",
                                geometry: {
                                    shapes: [{ type: "CIRCLE", offset: [0, 0], radius: 1 }],
                                },
                            },
                        },
                        canTargetAir: false,
                        includeBlockingRelations: false,
                        preferBlockingRelations: false,
                        ignoreTargetFree: false,
                        ignoreInvisible: false,
                        maxTargets: 1,
                    },
                },
            ],
         })) }),
    elemental: {
        maxEp: 1000,
        recoveryPerSecond: 0,
        elementResistance: 0,
        damageResistance: 0,
        burstRecoverySpeed: 1,
        bursts: Object.fromEntries(["NEURAL", "EROSION", "BURN", "NECROSIS"].map(type => [type, { durationTicks: 300, onStart: battle => battle }])),
    },
    skill: skillDefinition({
        id: "paired-skill",
        sp: { initial: 0, capacity: 10, requirement: 10, recovery: { type: "TIME", intervalTicks: 30 } },
    }),
    allegiance: { side: "ALLY" },
    spatial: { layer: "GROUND" },
    hit: { geometry: { shapes: [{ type: "CIRCLE", offset: [0, 0], radius: 0.25 }] } },
    blocker: { capacity: 1, geometry: { radius: 0.5 } },
    blockable: { weight: 1 },
    locomotion: {
        moveSpeedPerTick: 0.1,
        steeringParameters: { steeringFactor: 1, maxSteeringForce: 1 },
    },
});

test("battlefield registration retains initialized capabilities and shared definitions", () => {
    let runtime = createFieldState({ map: map() });
    const unit = initialize({ id: 1, definition: definition(), position: [0, 0] });
    runtime = transitionBattlefield(runtime, [{ type: "REGISTER_UNIT", unit }]).state;
    assert.equal(viewBattlefield(runtime).getUnit(1), unit);
    assert.deepEqual(
        viewBattlefield(runtime)
            .unitsAt([0, 0])
            .map((value) => value.id),
        [1],
    );
});

test("battlefield transition preserves configured capability composition on update", () => {
    let runtime = createFieldState({ map: map() });
    const unit = initialize({ id: 1, definition: definition(), position: [0, 0] });
    const bare = initialize({ id: 2, definition: { id: "bare" }, position: [2, 0] });
    runtime = transitionBattlefield(runtime, [
        { type: "REGISTER_UNIT", unit },
        { type: "REGISTER_UNIT", unit: bare },
    ]).state;
    const updated = {
        ...unit,
        action: { ...unit.action, states: new Map(unit.action.states).set("normal", { ...unit.action.states.get("normal"), cooldown: { periodTicks: 3, readyAtTick: 7 } }) },
        spatialPresence: { present: false },
        occupancy: { claims: [] },
    };
    runtime = transitionBattlefield(runtime, [{ type: "UPDATE_UNIT", unit: updated }]).state;
    assert.deepEqual(viewBattlefield(runtime).getUnit(1).action, updated.action);
    assert.deepEqual(viewBattlefield(runtime).unitsAt([0, 0]), []);
    const restored = { ...updated, spatialPresence: { present: true }, occupancy: { claims: [] } };
    runtime = transitionBattlefield(runtime, [{ type: "UPDATE_UNIT", unit: restored }]).state;
    assert.deepEqual(
        viewBattlefield(runtime)
            .unitsAt([0, 0])
            .map((value) => value.id),
        [1],
    );
});

test("unit snapshots copy partial composition without enforcing battlefield registration", () => {
    const unit = initialize({ id: 1, definition: definition(), position: [0, 0] });
    const partial = {
        effects: Effects.empty(),
        id: unit.id,
        lifecycle: unit.lifecycle,
        definition: unit.definition,
        position: unit.position,
    };
    assert.deepEqual(copy(partial), partial);
});

test("Unit with an acting definition and no action state remains statically legal", async () => {
    const { default: ts } = await import("typescript");
    const directory = mkdtempSync(join(tmpdir(), "stronghold-registration-types-"));
    const sourceModule = (name) =>
        JSON.stringify(
            fileURLToPath(new URL(`../../src/core/tactical/${name}.js`, import.meta.url)),
        );
    const path = join(directory, "missing-action.mts");
    try {
        writeFileSync(
            path,
            `
import type { Unit, Definition } from ${sourceModule("unit/unit")};
import { Effects } from ${sourceModule("unit/effect/effects")};
import type { Action } from ${sourceModule("unit/capability/action/capability")};
import type { ImmutableData } from ${sourceModule("../common/immutable-data")};
import type { BattlefieldMap } from ${sourceModule("battlefield/map/map")};
import { create, transition } from ${sourceModule("battlefield/state")};
type ActingDefinition = Definition & Action['definition'];
declare const definition: ImmutableData<ActingDefinition>;
declare const map: BattlefieldMap;
const unit = { id: 1, definition, position: [0, 0], effects: Effects.empty(), lifecycle: 'PRESENT' } satisfies Unit;
const baseUnit: Unit = unit;
const battlefield = create({ map });
transition(battlefield, [{ type: 'REGISTER_UNIT', unit: baseUnit }]);
const custom = create<typeof unit>({ map });
transition(custom, [{ type: 'REGISTER_UNIT', unit }]);
`,
        );
        const program = ts.createProgram([path], {
            noEmit: true,
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.NodeNext,
            moduleResolution: ts.ModuleResolutionKind.NodeNext,
            strict: true,
            exactOptionalPropertyTypes: true,
            noUncheckedIndexedAccess: true,
            skipLibCheck: true,
            types: [],
        });
        const diagnostics = ts
            .getPreEmitDiagnostics(program)
            .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
        assert.deepEqual(diagnostics, []);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
