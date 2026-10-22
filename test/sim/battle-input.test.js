import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BattleRuntime } from "../../dist/core/tactical/battle/runtime.js";

import { createBattlefieldMap } from "../../dist/core/tactical/battlefield/map/map.js";
import { definition } from "../helpers/effects.js";
import { initialize } from "../helpers/unit.js";
import { seededPlacement } from "../helpers/aura.js";
import { createDefinition } from "../../dist/core/tactical/unit/archetype/enemy.js";

import { createInput as createRouteDefinition } from "../../dist/core/tactical/battle/creation/route.js";

test("runtime accepts the battle contract Input directly with factory-owned maps and creation references", async () => {
    const { default: ts } = await import("typescript");
    const directory = mkdtempSync(join(tmpdir(), "stronghold-battle-input-types-"));
    const sourceModule = (path) =>
        JSON.stringify(
            fileURLToPath(new URL(`../../src/core/tactical/${path}.js`, import.meta.url)),
        );
    const path = join(directory, "input.mts");
    try {
        writeFileSync(
            path,
            `
import type { Input, Command, Event, Result, Snapshot, Step } from ${sourceModule("battle/contract")};
import { BattleRuntime } from ${sourceModule("battle/runtime")};
import type { BattlefieldMap } from ${sourceModule("battlefield/map/map")};
declare const input: Input;
declare const rawMap: Pick<BattlefieldMap, 'rows' | 'columns' | 'tiles' | 'markers' | 'blockEdges'>;
const runtime = new BattleRuntime(input);
new BattleRuntime(Object.freeze(input));
const commands: readonly Command[] = [];
const step: Step = runtime.step(commands);
const events: readonly Event[] = step.events;
const result: Result | null = step.result;
const snapshot: Snapshot = runtime.snapshot();
// @ts-expect-error Map ownership still requires the domain factory's brand.
new BattleRuntime({ ...input, map: rawMap });
${["initialUnits", "initialMechanisms"]
    .map(
        (field, index) => `
const { ${field}: omitted${index}, ...without${index} } = input;
// @ts-expect-error Every initial collection must be supplied explicitly.
new BattleRuntime(without${index});
`,
    )
    .join("")}
${[
    "nextUnitId",
    "nextMechanismId",
    "nextOverlayId",
    "nextProjectileId",
]
    .map(
        (field) => `
// @ts-expect-error Instance identity allocation belongs to the runtime.
new BattleRuntime({ ...input, ${field}: 100 });
`,
    )
    .join("")}

`,
        );
        const program = ts.createProgram([path], {
            noEmit: true,
            strict: true,
            exactOptionalPropertyTypes: true,
            noUncheckedIndexedAccess: true,
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.NodeNext,
            moduleResolution: ts.ModuleResolutionKind.NodeNext,
            skipLibCheck: true,
            types: [],
        });
        assert.deepEqual(
            ts
                .getPreEmitDiagnostics(program)
                .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")),
            [],
        );
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

const placement = (id, column) => ({
    definition: { id, vitality: { maxHp: 100, defense: 0, resistance: 0 } },
    position: [column, 0],
});

function fixture({ spawnTick = 100 } = {}) {
    const tile = {
        heightType: "LOWLAND",
        buildableType: "ALL",
        passableMask: "ALL",
        playerSideMask: "ALL",
        terrain: "NORMAL",
        mechanism: null,
    };
    const map = createBattlefieldMap(
        1,
        8,
        Array.from({ length: 8 }, () => tile),
    );

    const initial = definition("initial-state", { quota: { remaining: 3 }, marks: [1, 2] });
    const enemy = createDefinition({
        id: "scheduled-enemy",
        vitality: { maxHp: 100, defense: 0, resistance: 0 },
        locomotion: {
            halfBodyWidth: 0, minSpeed: 0, speed: 0,
            steeringParameters: { steeringFactor: 1, maxSteeringForce: 1 },
        },
    });
    const route = createRouteDefinition({
        pathMotionMode: "WALK",
        startPosition: [0, 7],
        endPosition: [0, 7],
        spawnOffset: [0, 0],
        spawnRandomRange: [0.3, 0.3],
        checkpoints: [{ type: "WAIT_FOR_TICKS", durationTicks: 100 }],
        allowDiagonalMove: false,
        visitEveryTileCenter: false,
        visitEveryNodeCenter: false,
        visitEveryCheckPoint: true,
    });
    const fields = {
        map,
        schedule: {
            type: "TIMELINE",
            spawns: [
                {
                    definition: enemy,
                    route,
                    tick: spawnTick,
                    timing: { waveStartedAtTick: 0, fragmentStartedAtTick: 0 },
                    alwaysCheckCurrentPoint: true,
                    notCountInTotal: false,
                },
            ],
        },
        initialUnits: [
            placement("placed-a", 0),
            seededPlacement(initial, initialize({ id: 1, ...placement("placed-b", 1) })),
        ],
        initialMechanisms: [
            { definition: { id: "first-mechanism" } },
            { definition: { id: "plain-mechanism" } },
        ],

        predefines: [
            {
                id: 100,
                alias: "present-mechanism",
                initiallyPresent: true,
                creation: {
                    type: "MECHANISM",
                    definition: { id: "predefined-mechanism" },

                },
            },
            {
                id: 101,
                alias: "present-unit",
                initiallyPresent: true,
                creation: {
                    type: "UNIT",
                    ...placement("predefined-unit", 2),
                },
            },
            {
                id: 102,
                alias: "later-mechanism",
                initiallyPresent: false,
                creation: {
                    type: "MECHANISM",
                    definition: { id: "later-mechanism" },

                },
            },
            {
                id: 103,
                alias: "later-unit",
                initiallyPresent: false,
                creation: {
                    type: "UNIT",
                    ...placement("later-unit", 3),
                },
            },
        ],
        maxTicks: 4,
        routeMoveMultiplier: 1,
        rngState: 17,
    };
    return { fields, effectDefinition: initial };
}

test("runtime allocates initial IDs, resolves creation references, and never reuses predefined instance IDs", () => {
    const { fields, effectDefinition } = fixture();
    const input = fields;
    const runtime = new BattleRuntime(input);
    const initial = runtime.snapshot();

    assert.equal(initial.units[0].definition, fields.initialUnits[0].definition);
    assert.equal(initial.mechanisms[1].definition, fields.initialMechanisms[1].definition);

    assert.deepEqual(
        initial.units.map((unit) => unit.id),
        [0, 1, 2],
    );
    assert.deepEqual(
        initial.mechanisms.map((mechanism) => mechanism.id),
        [0, 1, 2],
    );

    assert.deepEqual(initial.execution, {
        rngState: 17,
        nextCardId: 0,
        nextUnitId: 3,
        nextMechanismId: 3,
        nextOverlayId: 0,
        nextProjectileId: 0,
    });



    assert.equal(initial.units[1].effects.values().toArray()[0].source, 1);
    assert.equal(initial.units[1].effects.values().toArray()[0].definition, effectDefinition);
    assert.equal(initial.units[1].effects.values().toArray()[0].status, "ACTIVE");
    assert.deepEqual(initial.units[1].effects.values().toArray()[0].data, {
        quota: { remaining: 3 },
        marks: [1, 2],
    });

    runtime.step([
        { type: "APPEAR_PREDEFINED", definitionId: 102 },
        { type: "APPEAR_PREDEFINED", definitionId: 103 },
    ]);
    const appeared = runtime.snapshot();
    assert.deepEqual(
        appeared.units.map((unit) => unit.id),
        [0, 1, 2, 3],
    );
    assert.deepEqual(
        appeared.mechanisms.map((mechanism) => mechanism.id),
        [0, 1, 2, 3],
    );

    assert.deepEqual(
        appeared.predefinedPresence.filter((binding) => binding.definitionId >= 102),
        [
            { definitionId: 102, source: { type: "MECHANISM", mechanismId: 3 } },
            { definitionId: 103, source: { type: "UNIT", unitId: 3 } },
        ],
    );

    runtime.step([
        { type: "REMOVE_PREDEFINED", definitionId: 102, reason: "SCRIPT" },
        { type: "REMOVE_PREDEFINED", definitionId: 103, reason: "SCRIPT" },
        { type: "APPEAR_PREDEFINED", definitionId: 102 },
        { type: "APPEAR_PREDEFINED", definitionId: 103 },
    ]);
    const replaced = runtime.snapshot();
    assert.deepEqual(
        replaced.units.map((unit) => unit.id),
        [0, 1, 2, 4],
    );
    assert.deepEqual(
        replaced.mechanisms.map((mechanism) => mechanism.id),
        [0, 1, 2, 4],
    );

    assert.equal(replaced.execution.nextUnitId, 5);
    assert.equal(replaced.execution.nextMechanismId, 5);
    assert.equal(replaced.execution.nextOverlayId, 0);
});

test("one battle input replays allocations, seeded spawning and navigation deterministically", () => {
    const { fields } = fixture({ spawnTick: 0 });
    const input = fields;
    const runtimes = [
        new BattleRuntime(input),
        new BattleRuntime(input),
    ];
    const commands = [
        { type: "APPEAR_PREDEFINED", definitionId: 102 },
        { type: "APPEAR_PREDEFINED", definitionId: 103 },
    ];
    const initial = runtimes[0].snapshot();
    for (let tick = 0; tick < input.maxTicks; tick++) {
        const outputs = runtimes.map((runtime) => runtime.step(tick === 0 ? commands : []));
        assert.deepEqual(outputs[0], outputs[1]);
        assert.deepEqual(runtimes[0].snapshot(), runtimes[1].snapshot());
        assert.deepEqual(runtimes[0].navigation, runtimes[1].navigation);
    }
    const final = runtimes[0].snapshot();
    const spawned = final.units.find((unit) => unit.definition.id === "scheduled-enemy");
    assert.equal(spawned.id, 4);
    assert.notDeepEqual(spawned.position, [7, 0]);
    assert.notEqual(final.execution.rngState, input.rngState);
    assert.equal(initial.execution.rngState, input.rngState);
    assert.equal(runtimes[0].result.reason, "TIME_LIMIT");
    assert.equal(runtimes[0].result.spawnedCount, 1);
});
