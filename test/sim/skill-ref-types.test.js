import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("Skill capabilities erase private program types while activation Refs retain proven data", async () => {
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
import { createDefinition, initialize as initializeSkill, hasSkill, type Definition, type Skill, type State } from ${source("tactical/unit/capability/skill/capability")};
import { ref, setData, type Activation } from ${source("tactical/unit/capability/skill/activation")};
import { get as getInstance, replace, setData as setPersistentData } from ${source("tactical/unit/capability/skill/instance")};
import { activate, cancel } from ${source("tactical/unit/capability/skill/operations")};
import { get, replaceActivation } from ${source("tactical/unit/capability/skill/query")};
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type Persistent = { count: number };
type Active = { mode: "FIRST" | "SECOND" };
declare const battle: BattleState;
declare const self: Activation<Active>;
declare const specialized: Ref<Activation<Active> & { readonly marker: 17 }>;
const definition: Definition<Persistent, Active> = createDefinition({
    id: "typed-skill", initialize: () => ({ count: 0 }), sp: null,
    onEnter: (current, program) => {
        const count: number = program.state.data.count;
        return replace(current, setPersistentData(program, { count: count + 1 }));
    },
    activation: { trigger: "MANUAL", sustain: { type: "INFINITE" },
        initialize: (_battle, program) => ({ mode: program.state.data.count === 0 ? "FIRST" : "SECOND" }),
        onStart: (current, activation) => {
            const proof = ref(activation);
            type Proof = Assert<Equal<typeof proof, Ref<Activation<Active>>>>;
            const mode: "FIRST" | "SECOND" | undefined = get(current, proof)?.data.mode;
            const program = getInstance(current, activation.host, definition);
            if (program === undefined) return current;
            const count: number = program.state.data.count;
            return replace(current, setPersistentData(program, { count: count + 1 }));
        },
        onTick: (current, activation) => replaceActivation(current, ref(activation), setData(activation, { mode: "SECOND" })),
    },
});
const initialized = initialize(battle, { id: 0, position: [0, 0], definition: { id: "typed-host", skill: definition } }).value;
const state = initializeSkill(battle, definition).value;
type CommonState = Assert<Equal<typeof state, State>>;
// @ts-expect-error Unit capability state does not expose a program's private data.
initialized.skill.data.count;
// @ts-expect-error even direct capability initialization returns common State.
state.data.count;
// @ts-expect-error the erased input still requires the activation data initializer.
initialize(battle, { id: 1, position: [0, 0], definition: { id: "invalid", skill: { id: "invalid", initialize: () => ({}), sp: null, activation: { trigger: "MANUAL", sustain: { type: "INFINITE" } } } } });
const knownProgram = getInstance(battle, units.ref(initialized), definition);
const knownCount: number | undefined = knownProgram?.state.data.count;
// @ts-expect-error restoring a private program requires its Definition token.
getInstance(battle, units.ref(initialized));
const started = activate(battle, units.ref(initialized));
if (started.value.type === "ACTIVATED") {
    const current = get(started.state, started.value.ref);
    type Current = Assert<Equal<typeof current, Activation | undefined>>;
    // @ts-expect-error a Unit ref alone cannot prove the active program's private type.
    current?.data.mode;
    const restored = get(started.state, started.value.ref, definition);
    type Restored = Assert<Equal<typeof restored, Activation<Active> | undefined>>;
    const mode: "FIRST" | "SECOND" | undefined = restored?.data.mode;
}
const known = ref(self);
type Known = Assert<Equal<typeof known, Ref<Activation<Active>>>>;
const weaker: Ref<Activation<Active>> = specialized;
const erased: Ref<Activation> = weaker;
cancel(battle, erased, "SCRIPT");
const candidates = units.all(battle).filter(hasSkill).map(units.ref).toArray();
type Candidates = Assert<Equal<typeof candidates, readonly Ref<Unit & Skill>[]>>;
const host = units.get(battle, self.host);
// @ts-expect-error a typed activation does not type its host's private persistent state.
host?.skill.data.count;
// @ts-expect-error Skill capability has no content program type parameters.
type GenericCapability = Skill<Persistent, Active>;
// @ts-expect-error callers cannot select private types when activating through a Unit ref.
activate<Persistent, Active>(battle, units.ref(initialized));
// @ts-expect-error
const forged: Ref<Activation<Active>> = { host: units.ref(initialized), id: 0 };
// @ts-expect-error
const stronger: Ref<Activation<Active> & { readonly marker: 17 }> = weaker;
// @ts-expect-error
const mismatched: Ref<Activation<{ count: number }>> = weaker;
// @ts-expect-error
get(battle, units.ref(initialized));
// @ts-expect-error
get(battle, 0);
// @ts-expect-error
get(battle, self);
// @ts-expect-error
get(battle, erased)!.data.mode;
// @ts-expect-error
setData(self, { mode: "INVALID" });
// @ts-expect-error writeback cannot infer a different private state from the replacement value.
replaceActivation(battle, known, { ...self, data: { mode: "INVALID" } });
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
