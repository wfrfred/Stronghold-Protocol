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
import type { State as BattleState } from ${source("tactical/battle/state")};
import type { Unit } from ${source("tactical/unit/unit")};
import type { Action as ActionCapability } from ${source("tactical/unit/capability/action/capability")};
import type { Action } from ${source("tactical/unit/action/action")};
import type { Actions } from ${source("tactical/unit/action/actions")};
import type { Definition } from ${source("tactical/unit/action/definition")};
import { ref, setState } from ${source("tactical/unit/action/action")};
import { Definitions } from ${source("tactical/unit/action/definitions")};
import { all, start, get, cancel, replace } from ${source("tactical/unit/action/operations")};
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type Stored = ReturnType<Actions["values"]>[number];
declare const battle: BattleState;
declare const source: Ref<Unit & ActionCapability>;
declare const action: Action<{ count: number }>;
declare const specialized: Ref<Action<{ count: number }> & { readonly marker: 17 }>;
const definition: Definition<{ count: number }> = {
    id: "count", intervalTicks: 10, speed: 100,
    start: current => ({ state: current, value: { count: 0 } }),
    step: (current, self) => ({ state: replace(current, setState(self, { count: self.state.count + 1 })), value: false }),
};
const definitions = Definitions.empty().add(definition);
const recoveredDefinition = definitions.get("count", definition);
type RecoveredDefinition = Assert<Equal<typeof recoveredDefinition, Definition<{ count: number }> | undefined>>;
const started = start(battle, source, definition);
if (started.value.type === "STARTED") {
    const current = get(started.state, started.value.ref);
    type Current = Assert<Equal<typeof current, Action<{ count: number }> | undefined>>;
}
const known = ref(action);
type Known = Assert<Equal<typeof known, Ref<Action<{ count: number }>>>>;
const weaker: Ref<Action<{ count: number }>> = specialized;
const erased: Ref<Stored> = weaker;
const candidates = all(battle);
type Candidates = Assert<Equal<typeof candidates, Ref<Stored>[]>>;
cancel(battle, erased, "SCRIPT");
// @ts-expect-error
const forged: Ref<Action<{ count: number }>> = { id: 0 };
// @ts-expect-error
const stronger: Ref<Action<{ count: number }> & { readonly marker: 17 }> = weaker;
// @ts-expect-error
const mismatched: Ref<Action<{ label: string }>> = weaker;
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
// @ts-expect-error
setState(action, { count: "invalid" });
// @ts-expect-error
replace(battle, { ...action, state: { count: "invalid" } });
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
