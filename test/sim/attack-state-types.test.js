import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("Attack private data requires initialization and keeps typed activation references in content composition", async () => {
    const { default: ts } = await import("typescript");
    const directory = mkdtempSync(join(tmpdir(), "stronghold-attack-state-types-"));
    const source = (name) => JSON.stringify(fileURLToPath(new URL(`../../src/${name}.js`, import.meta.url)));
    const path = join(directory, "state.mts");
    try {
        writeFileSync(path, `
import type { Ref } from ${source("core/common/ref")};
import type { State as BattleState } from ${source("core/tactical/battle/state")};
import { ref as actionRef, setState } from ${source("core/tactical/unit/action/action")};
import { replace } from ${source("core/tactical/unit/action/operations")};
import type { Activation, Stored as StoredActivation } from ${source("core/tactical/unit/capability/skill/activation")};
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
declare const activation: Ref<Activation<Persistent, Active>>;
const counted = createWithState({
    ...configuration,
    initialize: () => ({ count: 0 }),
    output(current, self) {
        const count: number = self.state.data.count;
        return replace(current, setState(self, { ...self.state, data: { count: count + 1 } }));
    },
    afterOutput(current, self) {
        const count: number = self.state.data.count;
        // @ts-expect-error
        self.state.data.missing;
        return current;
    },
    onEnd(current, self) {
        const count: number = self.state.data.count;
        return current;
    },
});
type Counted = Assert<Equal<typeof counted, Attack<{ count: number }>>>;
const preciseAmmo = createWithState({
    ...configuration,
    initialize: (): { activation: Ref<Activation<Persistent, Active>> | null } => ({ activation }),
    afterOutput(current, self) {
        const sampled = self.state.data.activation;
        type Sampled = Assert<Equal<typeof sampled, Ref<Activation<Persistent, Active>> | null>>;
        if (sampled === null) return current;
        const latest = getActivation(current, sampled);
        type Latest = Assert<Equal<typeof latest, Activation<Persistent, Active> | undefined>>;
        if (latest === undefined) return current;
        const mode: "FIRST" | "SECOND" = latest.data.mode;
        current = consume(current, sampled, 2).state;
        return check(current, sampled);
    },
});
type PreciseAmmo = Assert<Equal<typeof preciseAmmo, Attack<{ activation: Ref<Activation<Persistent, Active>> | null }>>>;
const genericAmmo = createSkillAttack({
    ...configuration,
    ammoPerAction: 2,
    output(current, self) {
        const sampled: Ref<StoredActivation> | null = self.state.data.activation;
        if (sampled !== null) {
            const latest: StoredActivation | undefined = getActivation(current, sampled);
            // @ts-expect-error
            latest!.data.mode;
        }
        return current;
    },
});
type GenericAmmo = Assert<Equal<typeof genericAmmo, Attack<SkillAttackState>>>;
// @ts-expect-error
createWithState<{ count: number }>({ ...configuration });
// @ts-expect-error
create<{ count: number }>(configuration);
// @ts-expect-error
const fabricated: Attack<{ count: number }> = create(configuration);
// @ts-expect-error
const mismatched: Attack<{ count: string }> = counted;
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
