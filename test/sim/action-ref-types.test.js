import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("Action Refs preserve definition state and covariance across heterogeneous storage", async () => {
    const { default: ts } = await import("typescript");
    const directory = mkdtempSync(join(tmpdir(), "stronghold-action-ref-types-"));
    const source = (name) =>
        JSON.stringify(fileURLToPath(new URL(`../../src/core/${name}.js`, import.meta.url)));
    const path = join(directory, "refs.mts");
    try {
        writeFileSync(
            path,
            `
import type { Ref } from ${source("common/ref")};
import type { Query } from ${source("common/query")};
import type { State as BattleState } from ${source("tactical/battle/state")};
import type { Unit } from ${source("tactical/unit/unit")};
import type { Action as ActionCapability } from ${source("tactical/unit/capability/action/capability")};
import type { Action, View } from ${source("tactical/unit/action/action")};
import { Actions } from ${source("tactical/unit/action/actions")};
import type { Definition } from ${source("tactical/unit/action/definition")};
import { ref } from ${source("tactical/unit/action/action")};
import { Definitions } from ${source("tactical/unit/action/definitions")};
import { all, start, get, cancel, update, getState, replaceState } from ${source("tactical/unit/action/operations")};
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
declare const battle: BattleState;
declare const source: Ref<Unit & ActionCapability>;
declare const action: Action<object, { count: number }>;
declare const specialized: Ref<Action<object, { count: number }> & { readonly marker: 17 }>;
const definition: Definition<object, { count: number }> = {
    id: "count", intervalTicks: 10, speed: 100,
    initialize: current => ({ state: current, value: {} }),
    start: current => ({ state: current, value: { count: 0 } }),
    step: (current, self) => ({ state: update(current, ref(self), state => ({ count: state.count + 1 })), value: false }),
};
const definitions = Definitions.empty().add(definition);
const recoveredDefinition = definitions.get("count", definition);
type RecoveredDefinition = Assert<Equal<typeof recoveredDefinition, Definition<object, { count: number }> | undefined>>;
const started = start(battle, source, definition);
if (started.value.type === "STARTED") {
    const current = get(started.state, started.value.ref);
    type Current = Assert<Equal<typeof current, Action<object, { count: number }> | undefined>>;
}
const known = ref(action);
const host: Ref<Unit & ActionCapability> = known.host;
type Host = Assert<Equal<typeof known.host, Ref<Unit & ActionCapability>>>;
// @ts-expect-error
const hostless: Pick<typeof known, "host" | "id"> = { id: 0 };
type Known = Assert<Equal<typeof known, Ref<Action<object, { count: number }>>>>;
const weaker: Ref<Action<object, { count: number }>> = specialized;
const erased: Ref<View> = weaker;
const candidates = all(battle);
type Candidates = Assert<Equal<typeof candidates, readonly Ref<View>[]>>;
const entries = Actions.empty().add(action);
const publicEntries: Query<View> = entries.values();
const exactEntry = entries.get(known);
type ExactEntry = Assert<Equal<typeof exactEntry, Action<object, { count: number }> | undefined>>;
entries.replace(known, { ...action, state: { count: 1 } });
// @ts-expect-error public views cannot be inserted as complete instances.
entries.add(get(battle, erased)!);
// @ts-expect-error public references do not prove writable private state types.
entries.replace(erased, action);
// @ts-expect-error a precise reference fixes replacement state inference.
entries.replace(known, { ...action, state: { count: "wrong" } });
// @ts-expect-error ordinary definition enumeration hides content callbacks.
definitions.values().find(value => value.id === "count")!.step;
cancel(battle, erased, "SCRIPT");
// @ts-expect-error
const forged: Ref<Action<object, { count: number }>> = { id: 0 };
// @ts-expect-error
const stronger: Ref<Action<object, { count: number }> & { readonly marker: 17 }> = weaker;
// @ts-expect-error
const mismatched: Ref<Action<object, { label: string }>> = weaker;
// @ts-expect-error
get(battle, source);
// @ts-expect-error
get(battle, 0);
// @ts-expect-error
get(battle, action);
// @ts-expect-error
get(battle, erased)!.definition.step;
// @ts-expect-error
get(battle, erased)!.state.count;
update(battle, known, current => {
    const count: number = current.count;
    return { count: count + 1 };
});
// @ts-expect-error the reference fixes the execution state returned by the transformer.
update(battle, known, () => ({ count: "invalid" }));
// @ts-expect-error public references do not expose a private state to transform.
update(battle, erased, current => current);
// @ts-expect-error a Unit reference cannot identify an Action state.
update(battle, source, () => ({ count: 1 }));
// @ts-expect-error updates locate instances through their reference rather than an object snapshot.
update(battle, action, () => ({ count: 1 }));
const persistent: Definition<{ uses: number }, { target: string }> = {
    id: "persistent", intervalTicks: 10, speed: 100,
    initialize: current => ({ state: current, value: { uses: 0 } }),
    start: (current, host, self) => ({
        state: replaceState(current, host, { ...self, data: { uses: self.data.uses + 1 } }),
        value: { target: "sampled" },
    }),
    step: (current, self) => {
        const stored = getState(current, self.host, self.definition)!;
        const uses: number = stored.data.uses;
        const target: string = self.state.target;
        // @ts-expect-error
        const wrongPersistent: string = stored.data.uses;
        // @ts-expect-error
        const wrongExecution: number = self.state.target;
        // @ts-expect-error
        replaceState(current, self.host, { ...stored, data: { uses: "invalid" } });
        return { state: current, value: false };
    },
};
declare const actionHost: Unit & ActionCapability;
// @ts-expect-error ordinary persistent state queries hide content data.
actionHost.action.states.get("persistent")!.data;
const persistentEntry = actionHost.action.states.get("persistent", persistent)!;
const usage: number = persistentEntry.data.uses;
actionHost.action.states.replace(persistent, { ...persistentEntry, data: { uses: 2 } });
// @ts-expect-error the known Definition fixes persistent state inference.
actionHost.action.states.replace(persistent, { ...persistentEntry, data: { uses: "wrong" } });
Definitions.empty().add(definition).add(persistent).read("persistent", configured => {
    const stored = getState(battle, source, configured)!;
    // @ts-expect-error
    stored.data.uses;
    return replaceState(battle, source, stored);
});
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
