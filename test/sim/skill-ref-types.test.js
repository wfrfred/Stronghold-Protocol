import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("Skill activation Refs preserve persistent and activation data across heterogeneous lookup", async () => {
    const { default: ts } = await import("typescript");
    const directory = mkdtempSync(join(tmpdir(), "stronghold-skill-ref-types-"));
    const source = (name) => JSON.stringify(fileURLToPath(new URL(`../../src/core/${name}.js`, import.meta.url)));
    const path = join(directory, "refs.mts");
    try {
        writeFileSync(path, `
import type { Ref } from ${source("common/ref")};
import type { State as BattleState } from ${source("tactical/battle/state")};
import type { Unit } from ${source("tactical/unit/unit")};
import { initialize } from ${source("tactical/unit/initialize")};
import * as units from ${source("tactical/unit/query")};
import { createDefinition, initialize as initializeSkill, hasSkill, type Definition, type Skill, type Stored } from ${source("tactical/unit/capability/skill/capability")};
import { ref, setData, type Activation, type Stored as StoredActivation } from ${source("tactical/unit/capability/skill/activation")};
import { activate, cancel } from ${source("tactical/unit/capability/skill/operations")};
import { get, replaceActivation } from ${source("tactical/unit/capability/skill/query")};
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type Persistent = { count: number };
type Active = { mode: "FIRST" | "SECOND" };
declare const battle: BattleState;
declare const self: Activation<Persistent, Active>;
declare const specialized: Ref<Activation<Persistent, Active> & { readonly marker: 17 }>;
const definition: Definition<Persistent, Active> = createDefinition({
    id: "typed-skill", initialize: () => ({ count: 0 }), sp: null,
    activation: { trigger: "MANUAL", sustain: { type: "INFINITE" },
        initialize: (_battle, host) => ({ mode: host.skill.data.count === 0 ? "FIRST" : "SECOND" }),
        onTick: (current, activation) => replaceActivation(current, setData(activation, { mode: "SECOND" })),
    },
});
const initialized = initialize(battle, { id: 0, position: [0, 0], definition: { id: "typed-host", skill: definition } }).value;
const host = { ...initialized, skill: initializeSkill(battle, definition).value };
// @ts-expect-error generic Unit assembly exposes the heterogeneous storage view.
initialized.skill.data.count;
// @ts-expect-error the erased input still requires the activation data initializer.
initialize(battle, { id: 1, position: [0, 0], definition: { id: "invalid", skill: { id: "invalid", initialize: () => ({}), sp: null, activation: { trigger: "MANUAL", sustain: { type: "INFINITE" } } } } });
const persistent: number = host.skill.data.count;
const started = activate(battle, units.ref(host));
if (started.value.type === "ACTIVATED") {
    const current = get(started.state, started.value.ref);
    type Current = Assert<Equal<typeof current, Activation<Persistent, Active> | undefined>>;
    if (current !== undefined) {
        const mode: "FIRST" | "SECOND" = current.data.mode;
        const latestHost = units.get(started.state, current.host);
        const count: number | undefined = latestHost?.skill.data.count;
    }
}
const known = ref(self);
type Known = Assert<Equal<typeof known, Ref<Activation<Persistent, Active>>>>;
const weaker: Ref<Activation<Persistent, Active>> = specialized;
const erased: Ref<StoredActivation> = weaker;
cancel(battle, erased, "SCRIPT");
const candidates = units.filter(battle, hasSkill);
type Candidates = Assert<Equal<typeof candidates, Ref<Unit & Stored>[]>>;
// @ts-expect-error
const forged: Ref<Activation<Persistent, Active>> = { host: units.ref(host), id: 0 };
// @ts-expect-error
const stronger: Ref<Activation<Persistent, Active> & { readonly marker: 17 }> = weaker;
// @ts-expect-error
const mismatched: Ref<Activation<Persistent, { count: number }>> = weaker;
// @ts-expect-error
get(battle, units.ref(host));
// @ts-expect-error
get(battle, 0);
// @ts-expect-error
get(battle, self);
// @ts-expect-error
get(battle, erased)!.data.mode;
// @ts-expect-error
setData(self, { mode: "INVALID" });
// @ts-expect-error
replaceActivation(battle, { ...self, data: { mode: "INVALID" } });
`);
        const program = ts.createProgram([path], {
            noEmit: true, strict: true, exactOptionalPropertyTypes: true,
            noUncheckedIndexedAccess: true, target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
            skipLibCheck: true, types: [],
        });
        assert.deepEqual(ts.getPreEmitDiagnostics(program).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")), []);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
