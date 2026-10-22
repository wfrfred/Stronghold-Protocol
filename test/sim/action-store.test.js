import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Actions } from "../../dist/core/tactical/unit/action/actions.js";
import { Definitions } from "../../dist/core/tactical/unit/action/definitions.js";
import { States } from "../../dist/core/tactical/unit/action/states.js";
import { ref } from "../../dist/core/tactical/unit/action/action.js";
import * as operations from "../../dist/core/tactical/unit/action/operations.js";
import { initialize } from "../../dist/core/tactical/unit/initialize.js";
import { registerUnit } from "../../dist/core/tactical/battle/state.js";
import * as units from "../../dist/core/tactical/unit/query.js";
import { fixtureBattle } from "../helpers/unit.js";

const definition = (id, data = {}, execution = {}) => ({
    id,
    intervalTicks: 10,
    speed: 100,
    initialize: state => ({ state, value: data }),
    start: state => ({ state, value: execution }),
    step: state => ({ state, value: false }),
});
const host = (id = 0) => initialize(fixtureBattle(), {
    id,
    position: [0, 0],
    definition: { id: `action-host-${id}`, action: { definitions: Definitions.empty() } },
}).value;
const execution = (owner, configured, id = 0, state = {}) => ({
    id,
    host: units.ref(owner),
    definition: configured,
    startedAtTick: 4,
    status: "RUNNING",
    state,
});
const persistent = (configured, data) => ({
    definition: configured,
    data,
    cooldown: { periodTicks: 10, readyAtTick: 0 },
});

test("Action Definitions preserve paired programs and snapshot-bound query order", () => {
    const first = definition("number", { count: 3 }, { remaining: 2 });
    const second = definition("string", { mode: "first" }, { targets: [] });
    const original = Definitions.empty().add(first).add(second);
    const values = original.values();
    const changed = original.add(definition("third"));

    assert.deepEqual(values.map(value => value.id).toArray(), ["number", "string"]);
    assert.deepEqual(values.map(value => value.id).toArray(), ["number", "string"]);
    assert.deepEqual(changed.keys().toArray(), ["number", "string", "third"]);
    assert.strictEqual(original.get(first.id), first);
    assert.strictEqual(original.get(first.id, first), first);
    assert.equal(original.get(first.id, { ...first }), undefined);
    assert.equal(original.get("missing"), undefined);
    assert.deepEqual(original.read(first.id, configured => configured.initialize(fixtureBattle()).value), { count: 3 });
    assert.deepEqual(original.read(second.id, configured => configured.initialize(fixtureBattle()).value), { mode: "first" });
    assert.equal(original.read("missing", () => assert.fail("missing programs must not dispatch")), undefined);
    assert.throws(() => original.add({ ...first }), RangeError);
    assert.throws(() => Definitions.empty().add({ ...first, id: "" }), TypeError);
    assert.throws(() => Definitions.empty().add({ ...first, intervalTicks: -1 }), RangeError);
    assert.throws(() => Definitions.empty().add({ ...first, speed: Infinity }), RangeError);
});

test("Action instance queries restore only matching complete host identities", () => {
    const owner = host(0);
    const foreignOwner = host(1);
    const configured = definition("shared");
    const self = execution(owner, configured, 0, { count: 1 });
    const foreign = execution(foreignOwner, configured, 0, { count: 2 });
    const actions = Actions.empty().add(self);

    assert.strictEqual(actions.get(0), self);
    assert.strictEqual(actions.get(ref(self)), self);
    assert.strictEqual(actions.get(0, configured), self);
    assert.equal(actions.get(ref(foreign)), undefined);
    assert.equal(actions.get(0, { ...configured }), undefined);
    assert.strictEqual(actions.replace(ref(foreign), { ...foreign, state: { count: 9 } }), actions);
    assert.throws(() => actions.add({ ...self, id: 2 }), RangeError);
    assert.equal(actions.nextId, 1);
});

test("Action replacements preserve definition, address and start facts without reviving removed identities", () => {
    const owner = host();
    const configured = definition("paired");
    const self = execution(owner, configured, 0, { count: 1 });
    const reference = ref(self);
    const original = Actions.empty().add(self);
    const query = original.values();
    const updated = { ...self, state: { count: 2 } };
    const changed = original.replace(reference, updated);

    assert.strictEqual(original.replace(reference, self), original);
    assert.strictEqual(original.get(reference), self);
    assert.strictEqual(changed.get(reference), updated);
    assert.strictEqual(query.toArray()[0], self);
    assert.strictEqual(query.toArray()[0], self);
    assert.equal(changed.nextId, original.nextId);
    assert.throws(() => original.replace(reference, { ...self, id: 1 }), /identity cannot change/);
    assert.throws(() => original.replace(reference, { ...self, host: units.ref(host(1)) }), /host cannot change/);
    assert.throws(() => original.replace(reference, { ...self, definition: { ...configured } }), /definition cannot change/);
    assert.throws(() => original.replace(reference, { ...self, startedAtTick: 5 }), /start tick cannot change/);
    const removed = changed.remove(self.id);
    assert.equal(removed.get(reference), undefined);
    assert.strictEqual(removed.replace(reference, updated), removed);
    assert.strictEqual(removed.remove(self.id), removed);
    assert.equal(removed.nextId, 1);
    assert.deepEqual(original.toJSON().instances[0].state, { count: 1 });
    assert.deepEqual(changed.toJSON().instances[0].state, { count: 2 });
});

test("Action persistent States expose queries while Definition witnesses retain private data", () => {
    const first = definition("first");
    const second = definition("second");
    const one = persistent(first, { count: 1 });
    const two = persistent(second, { label: "ready" });
    const original = States.empty().add(one).add(two);
    const query = original.values();
    const updated = { ...one, data: { count: 2 } };
    const changed = original.replace(first, updated);

    assert.equal(original.size, 2);
    assert.strictEqual(original.get(first.id), one);
    assert.strictEqual(original.get(first.id, first), one);
    assert.equal(original.get(first.id, { ...first }), undefined);
    assert.deepEqual(original.read(first.id, self => self.data), { count: 1 });
    assert.deepEqual(changed.read(first.id, self => self.data), { count: 2 });
    assert.deepEqual(original.keys().toArray(), ["first", "second"]);
    assert.strictEqual(query.toArray()[0], one);
    assert.strictEqual(query.toArray()[0], one);
    assert.strictEqual(original.replace(first, one), original);
    assert.throws(() => original.add(one), RangeError);
    assert.throws(() => original.replace(first, { ...one, definition: { ...first } }), /definition cannot change/);
    assert.throws(() => original.replace({ ...first }, one), /definition cannot change/);
    assert.strictEqual(States.empty().replace(first, one), States.empty());
    assert.deepEqual(JSON.parse(JSON.stringify(original)).map(self => [self.definition.id, self.data]), [
        ["first", { count: 1 }],
        ["second", { label: "ready" }],
    ]);
});

test("Action initialization, start and termination retain persistent state and execution pairing", () => {
    const ended = [];
    const configured = {
        ...definition("program", { starts: 0 }, { remaining: 2 }),
        start(battle, source, self) {
            return {
                state: operations.replaceState(battle, source, { ...self, data: { starts: self.data.starts + 1 } }),
                value: { remaining: 2 },
            };
        },
        onEnd(battle, self, end) {
            ended.push([self.status, self.state.remaining, end]);
            return battle;
        },
    };
    const initial = fixtureBattle();
    const created = initialize(initial, {
        id: 0,
        position: [0, 0],
        definition: { id: "program-host", action: { definitions: Definitions.empty().add(configured) } },
    });
    const before = registerUnit(created.state, created.value);
    const source = units.ref(created.value);
    const started = operations.start(before, source, configured);

    assert.equal(started.value.type, "STARTED");
    assert.deepEqual(operations.getState(before, source, configured).data, { starts: 0 });
    assert.deepEqual(operations.getState(started.state, source, configured).data, { starts: 1 });
    assert.deepEqual(operations.get(started.state, started.value.ref).state, { remaining: 2 });
    const stopped = operations.cancel(started.state, started.value.ref, "TEST");
    assert.equal(operations.get(stopped, started.value.ref), undefined);
    assert.deepEqual(operations.getState(stopped, source, configured).data, { starts: 1 });
    assert.deepEqual(ended, [["ENDING", 2, { type: "CANCELLED", reason: "TEST" }]]);
    assert.deepEqual(operations.get(started.state, started.value.ref).state, { remaining: 2 });
});

test("Action public Views cannot be written as complete instances and read keeps both private types paired", async () => {
    const { default: ts } = await import("typescript");
    const directory = mkdtempSync(join(tmpdir(), "stronghold-action-store-types-"));
    const source = name => JSON.stringify(fileURLToPath(new URL(`../../src/core/tactical/${name}.js`, import.meta.url)));
    const path = join(directory, "actions.mts");

    try {
        writeFileSync(path, `
import type { Ref } from ${source("../common/ref")};
import type { Query } from ${source("../common/query")};
import type { State as BattleState } from ${source("battle/state")};
import type { Unit } from ${source("unit/unit")};
import type { Action as ActionCapability } from ${source("unit/capability/action/capability")};
import type { Definition, View as DefinitionView } from ${source("unit/action/definition")};
import { ref, type Action, type View } from ${source("unit/action/action")};
import type { State, View as StateView } from ${source("unit/action/state")};
import { Actions } from ${source("unit/action/actions")};
import { States } from ${source("unit/action/states")};
import { Definitions } from ${source("unit/action/definitions")};
import * as operations from ${source("unit/action/operations")};
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
declare const battle: BattleState;
declare const source: Ref<Unit & ActionCapability>;
declare const precise: Action<{ readonly count: number }, { readonly remaining: number }>;
declare const persistent: State<{ readonly count: number }, { readonly remaining: number }>;
declare const publicState: StateView;
declare const publicAction: View;
declare const configured: Definition<{ readonly count: number }, { readonly remaining: number }>;
const preciseRef = ref(precise);
const publicRef: Ref<View> = preciseRef;
const values = Actions.empty().values();
type Values = Assert<Equal<typeof values, Query<View>>>;
const known = Actions.empty().get(preciseRef);
type Known = Assert<Equal<typeof known, typeof precise | undefined>>;
const current = operations.get(battle, preciseRef);
type Current = Assert<Equal<typeof current, typeof precise | undefined>>;
const unknown = Actions.empty().get(publicRef);
type Unknown = Assert<Equal<typeof unknown, View | undefined>>;
// @ts-expect-error Public instances have no private execution data.
publicAction.state;
// @ts-expect-error Public persistent states have no private data.
publicState.data;
// @ts-expect-error A public instance cannot be inserted as a paired program.
Actions.empty().add(publicAction);
// @ts-expect-error A public Ref cannot authorize a private state replacement.
Actions.empty().replace(publicRef, precise);
// @ts-expect-error The Ref fixes the private execution type.
Actions.empty().replace(preciseRef, { ...precise, state: { unrelated: true } });
// @ts-expect-error Public State cannot be inserted as persistent program data.
States.empty().add(publicState);
// @ts-expect-error The Definition fixes the persistent private type.
States.empty().replace(configured, { ...persistent, data: { unrelated: true } });
const stateValues = States.empty().values();
type StateValues = Assert<Equal<typeof stateValues, Query<StateView>>>;
const knownState = States.empty().get(configured.id, configured);
type KnownState = Assert<Equal<typeof knownState, typeof persistent | undefined>>;
const definitions = Definitions.empty().values();
type DefinitionValues = Assert<Equal<typeof definitions, Query<DefinitionView>>>;
Actions.empty().read(0, self => self.definition.step(battle, self));
States.empty().read(configured.id, self => { self.definition.start(battle, source, self); });
`);
        const program = ts.createProgram([path], {
            noEmit: true, strict: true, exactOptionalPropertyTypes: true,
            noUncheckedIndexedAccess: true, target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
            skipLibCheck: true, types: [],
        });
        assert.deepEqual(ts.getPreEmitDiagnostics(program).map(diagnostic =>
            ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")), []);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
