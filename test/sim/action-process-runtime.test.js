import { damage as dealDamage, parameters } from "../helpers/vitality.js";
import { ref as unitRef } from "../../dist/core/tactical/unit/query.js";
import * as effects from "../../dist/core/tactical/unit/effect/operations.js";
import { ref as actionRef } from "../../dist/core/tactical/unit/action/action.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { unit } from "../helpers/action-fixture.js";
import { BattleRuntime } from "../../dist/core/tactical/battle/runtime.js";

import { createLegacyCombatSpec } from "../../dist/legacy/combat.js";
import { createDefinition } from "../../dist/core/tactical/unit/archetype/enemy.js";
import { createInput as createRouteDefinition } from "../../dist/core/tactical/battle/creation/route.js";
import { getUnit, updateUnit } from "../../dist/core/tactical/battle/state.js";
import { leave } from "../../dist/core/tactical/battle/execution/unit.js";
import { setState } from "../../dist/core/tactical/unit/action/action.js";
import * as actions from "../../dist/core/tactical/unit/action/operations.js";
import { Definitions } from "../../dist/core/tactical/unit/action/definitions.js";

function spec(initialUnits) {
    return {
        ...createLegacyCombatSpec({
            rows: 1,
            columns: 8,
            operators: [],
            enemies: [],
            maxTicks: 20,
            seed: 17,
        }),
        initialUnits: initialUnits.map((value) => ({
            definition: value.definition,
            position: value.position,
        })),
        schedule: {
            type: "TIMELINE",
            spawns: [
                {
                    definition: createDefinition({
                        id: "future",
                        vitality: { maxHp: 1, defense: 0, resistance: 0 },
                        locomotion: {
                            halfBodyWidth: 0, minSpeed: 0, speed: 0,
                            steeringParameters: { steeringFactor: 1, maxSteeringForce: 100 },
                        },
                    }),
                    route: createRouteDefinition({
                        pathMotionMode: "WALK",
                        startPosition: [0, 7],
                        endPosition: [0, 1],
                        spawnOffset: [0, 0],
                        spawnRandomRange: [0, 0],
                        checkpoints: [],
                        allowDiagonalMove: false,
                        visitEveryTileCenter: false,
                        visitEveryNodeCenter: false,
                        visitEveryCheckPoint: true,
                    }),
                    tick: 19,
                    timing: { waveStartedAtTick: 0, fragmentStartedAtTick: 0 },
                    alwaysCheckCurrentPoint: true,
                    notCountInTotal: false,
                },
            ],
        },
    };
}
const program = (id, extra = {}) => ({
    id,
    intervalTicks: 10,
    speed: 100,
    initialize: (state) => ({ state, value: {} }),
    start: (state) => ({ state, value: { count: 0 } }),
    step: (state) => ({ state, value: false }),
    ...extra,
});

test("action runtime: a newly registered instance first executes once and retained snapshots stay immutable", () => {
    const definition = program("progress", {
        step(state, self) {
            state = actions.replace(state, setState(self, { count: self.state.count + 1 }));
            return { state, value: false };
        },
    });
    const runtime = new BattleRuntime(spec([unit(0, { action: definition }), unit(1)]));
    runtime.step();
    const first = runtime.snapshot(),
        retained = first.units.find(unit => unit.id === 0).action.instances.values()[0];
    assert.equal(retained.state.count, 1);
    assert.equal(retained.definition, definition);
    runtime.step();
    assert.equal(runtime.snapshot().units.find(unit => unit.id === 0).action.instances.values()[0].state.count, 2);
    assert.equal(retained.state.count, 1);
});

test("action runtime: an immediately finished definition starts once in one automatic scheduling pass", () => {
    let starts = 0;
    const definition = program("instant", {
        intervalTicks: 1,
        start(state) {
            starts++;
            return { state, value: {} };
        },
        step: (state) => ({ state, value: true }),
    });
    const runtime = new BattleRuntime(spec([unit(0, { action: definition }), unit(1)]));
    assert.equal(
        runtime.step().events.filter((event) => event.type === "ACTION_FINISHED").length,
        1,
    );
    assert.equal(starts, 1);
    assert.equal(runtime.snapshot().units.find(unit => unit.id === 0).action.instances.values().length, 0);
    runtime.step();
    assert.equal(starts, 2);
});

test("action runtime: cancellation commands complete before a delayed release without disturbing its peer", () => {
    const definition = program("delayed", {
        start: (state) => ({ state, value: { releaseAtTick: state.tick + 1 } }),
        step(state, self) {
            if (state.tick < self.state.releaseAtTick) return { state, value: false };
            state = updateUnit(state, {
                ...getUnit(state, 2),
                vitality: { ...getUnit(state, 2).vitality, hp: getUnit(state, 2).vitality.hp - 7 },
            });
            return { state, value: true };
        },
    });
    const runtime = new BattleRuntime(
        spec([
            unit(0, { action: definition }),
            unit(1, { side: "ALLY", action: definition }),
            unit(2),
        ]),
    );
    runtime.step();
    const first = runtime.snapshot();
    assert.deepEqual(first.units.filter(unit => unit.action !== undefined)
        .map(unit => unit.action.instances.values()[0].id), [0, 0]);
    const cancelled = runtime.step([
        { type: "CANCEL_ACTION_EXECUTION", ref: actionRef(first.units.find(unit => unit.id === 0).action.instances.values()[0]) },
    ]);
    assert.deepEqual(cancelled.events.filter(event => event.type === "ACTION_CANCELLED")
        .map(event => [event.sourceUnitId, event.executionId]), [[0, 0]]);
    assert.deepEqual(cancelled.events.filter(event => event.type === "ACTION_FINISHED")
        .map(event => [event.sourceUnitId, event.executionId]), [[1, 0]]);
    assert.equal(runtime.snapshot().units.find((value) => value.id === 2).vitality.hp, 93);
    assert.equal(first.units.find((value) => value.id === 2).vitality.hp, 100);
});

test("action runtime: nested departure removes a later candidate before its next step", () => {
    const trace = [];
    const definition = program("nested", {
        step(state, self) {
            if (state.tick === 0) return { state, value: false };
            trace.push(self.host.id);
            if (self.host.id === 0)
                state = leave(state, 1, "SCRIPT");
            return { state, value: false };
        },
    });
    const runtime = new BattleRuntime(
        spec([
            unit(0, { action: definition }),
            unit(1, { side: "ALLY", action: definition }),
            unit(2),
        ]),
    );
    runtime.step();
    runtime.step();
    assert.deepEqual(trace, [0]);
    assert.equal(
        runtime.snapshot().units.some((value) => value.id === 1),
        false,
    );
});

test("action runtime: host order advances old instances before selection and defers nested same-tick candidates", () => {
    const trace = [];
    let child;
    const old = program("old", {
        step(state, self) {
            if (state.tick > 0) {
                trace.push(`old/${self.host.id}`);
                if (self.host.id === 0) {
                    state = actions.start(state, unitRef(getUnit(state, 1)), child).state;
                }
            }
            return { state, value: false };
        },
    });
    child = program("child", {
        step(state, self) {
            trace.push(`child/${self.host.id}`);
            return { state, value: false };
        },
    });
    const create = id => unit(id, { side: "ALLY", action: {
        definitions: Definitions.empty().add(old).add(child),
        select(state, self) {
            if (state.tick > 0) trace.push(`select/${self.id}`);
            return { state, value: ["old"] };
        },
    } });
    const runtime = new BattleRuntime(spec([create(0), create(1), unit(2)]));
    runtime.step();
    runtime.step();
    assert.deepEqual(trace, ["old/0", "child/1", "select/0", "old/1", "select/1"]);
    const first = runtime.snapshot().units.find(unit => unit.id === 0);
    const second = runtime.snapshot().units.find(unit => unit.id === 1);
    assert.deepEqual(first.action.instances.values().map(self => self.id), [0]);
    assert.deepEqual(second.action.instances.values().map(self => self.id), [0, 1]);
});

test("action runtime: a late exception publishes neither progressed action state nor domain changes", () => {
    const failure = new Error("continuation failed");
    const definition = program("failure", {
        step(state, self) {
            if (state.tick === 0) return { state, value: false };
            state = actions.replace(state, setState(self, { count: 9 }));
            state = updateUnit(state, { ...getUnit(state, 1), position: [3, 0] });
            throw failure;
        },
    });
    const runtime = new BattleRuntime(spec([unit(0, { action: definition }), unit(1)]));
    runtime.step();
    const before = runtime.snapshot();
    assert.throws(
        () => runtime.step(),
        (error) => error === failure,
    );
    assert.deepEqual(runtime.snapshot(), before);
    assert.equal(before.units.find(unit => unit.id === 0).action.instances.values()[0].state.count, 0);
});

test("action runtime: dependency cleanup can finish nested host death before a thrown end callback", () => {
    const failure = new Error("terminal finish failed");
    let observedDeparture = false;
    const dependency = {
        id: "terminal-dependency",
        initialize: () => ({}),
        onEnd(state, context) {
            state = dealDamage(state, { source: { id: 0 }, target: { id: context.unit.id }, parameters: parameters(100, "TRUE") }).state;
            observedDeparture = getUnit(state, context.unit.id) === undefined;
            throw failure;
        },
    };
    const definition = program("terminal", {
        step(state, self) {
            if (state.tick === 0)
                state = effects.install(state, unitRef(getUnit(state, 1)), dependency, {
                    scopes: [{ type: "ACTION", ref: actionRef(self) }],
                }).state;
            return { state, value: state.tick > 0 };
        },
    });
    const runtime = new BattleRuntime(spec([unit(0, { action: definition }), unit(1)]));
    runtime.step();
    const before = runtime.snapshot();
    assert.throws(
        () => runtime.step(),
        (error) => error === failure,
    );
    assert.equal(observedDeparture, true);
    assert.deepEqual(runtime.snapshot(), before);
    assert.equal(before.units.find((value) => value.id === 1).vitality.hp, 100);
});
