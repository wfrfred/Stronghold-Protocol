import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("Attack persistent and execution data keep separate types and typed activation references", async () => {
    const { default: ts } = await import("typescript");
    const directory = mkdtempSync(join(tmpdir(), "stronghold-attack-state-types-"));
    const source = (name) => JSON.stringify(fileURLToPath(new URL(`../../src/${name}.js`, import.meta.url)));
    const path = join(directory, "state.mts");
    try {
        writeFileSync(path, `
import type { Ref } from ${source("core/common/ref")};
import type { State as BattleState, Result } from ${source("core/tactical/battle/state")};
import { ref as actionRef, setState } from ${source("core/tactical/unit/action/action")};
import { replace, getState, replaceState } from ${source("core/tactical/unit/action/operations")};
import type { Activation } from ${source("core/tactical/unit/capability/skill/activation")};
import { get as getActivation } from ${source("core/tactical/unit/capability/skill/query")};
import { consume, check } from ${source("core/tactical/unit/capability/skill/ammo")};
import { create, createWithState, isAttack, type Attack, type Configuration } from ${source("content/tactical/actions/attack")};
import { create as createSkillAttack, type State as SkillAttackState } from ${source("content/tactical/actions/skill")};
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
declare const configuration: Configuration;
declare const battle: BattleState;
declare const unknownDefinition: unknown;
type Persistent = { count: number };
type Active = { mode: "FIRST" | "SECOND" };
declare const activation: Ref<Activation<Active>>;
const counted = createWithState({
    ...configuration,
    initialize: current => ({ state: current, value: { count: 0 } }),
    start: (current, source, self): Result<{ sampled: number }> => ({ state: current, value: { sampled: self.data.count } }),
    output(current, self) {
        const persistent = getState(current, self.source, self.definition)!;
        const count: number = persistent.data.count;
        current = replaceState(current, self.source, { ...persistent, data: { count: count + 1 } });
        return replace(current, setState(self, { ...self.state, data: { sampled: count } }));
    },
    afterOutput(current, self) {
        const sampled: number = self.state.data.sampled;
        // @ts-expect-error
        self.state.data.missing;
        // @ts-expect-error
        self.state.data.count;
        return current;
    },
    onEnd(current, self) {
        const count: number = getState(current, self.source, self.definition)!.data.count;
        return current;
    },
});
type Counted = Assert<Equal<typeof counted, Attack<Persistent, { sampled: number }>>>;
const preciseAmmo = createWithState({
    ...configuration,
    initialize: current => ({ state: current, value: {} }),
    start: (current): { state: BattleState; value: { activation: Ref<Activation<Active>> | null } } => ({ state: current, value: { activation } }),
    afterOutput(current, self) {
        const sampled = self.state.data.activation;
        type Sampled = Assert<Equal<typeof sampled, Ref<Activation<Active>> | null>>;
        if (sampled === null) return current;
        const latest = getActivation(current, sampled);
        type Latest = Assert<Equal<typeof latest, Activation<Active> | undefined>>;
        if (latest === undefined) return current;
        const mode: "FIRST" | "SECOND" = latest.data.mode;
        current = consume(current, sampled, 2).state;
        return check(current, sampled);
    },
});
type PreciseAmmo = Assert<Equal<typeof preciseAmmo, Attack<{}, { activation: Ref<Activation<Active>> | null }>>>;
const genericAmmo = createSkillAttack({
    ...configuration,
    ammoPerAction: 2,
    output(current, self) {
        const sampled: Ref<Activation> | null = self.state.data.activation;
        if (sampled !== null) {
            const latest: Activation | undefined = getActivation(current, sampled);
            // @ts-expect-error
            latest!.data.mode;
        }
        return current;
    },
});
type GenericAmmo = Assert<Equal<typeof genericAmmo, Attack<object, SkillAttackState>>>;
// @ts-expect-error
createWithState<{ count: number }, {}>({ ...configuration });
// @ts-expect-error
create<{ count: number }>(configuration);
// @ts-expect-error
const fabricated: Attack<{ count: number }, {}> = create(configuration);
// @ts-expect-error
const mismatched: Attack<{ count: string }, { sampled: number }> = counted;
// @ts-expect-error
const wrongExecution: Attack<Persistent, { sampled: string }> = counted;
// @ts-expect-error
const raw: SkillAttackState = { activation: { host: { id: 0 }, id: 0 } };
if (isAttack(unknownDefinition)) {
    const identity: string = unknownDefinition.id;
    // @ts-expect-error
    unknownDefinition.step;
    // @ts-expect-error
    unknownDefinition.attack.output;
}
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
