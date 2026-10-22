import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("Projectile Refs preserve private state types through creation, updates and public queries", async () => {
    const { default: ts } = await import("typescript");
    const directory = mkdtempSync(join(tmpdir(), "stronghold-projectile-ref-types-"));
    const source = name => JSON.stringify(fileURLToPath(new URL(`../../src/core/${name}.js`, import.meta.url)));
    const path = join(directory, "refs.mts");
    try {
        writeFileSync(path, `
import type { Ref } from ${source("common/ref")};
import type { Query } from ${source("common/query")};
import type { State as BattleState } from ${source("tactical/battle/state")};
import { battlefieldView } from ${source("tactical/battle/state")};
import type { Unit } from ${source("tactical/unit/unit")};
import type { Projectile, View } from ${source("tactical/battlefield/projectile/projectile")};
import { Projectiles } from ${source("tactical/battlefield/projectile/projectiles")};
import type { Definition } from ${source("tactical/battlefield/projectile/definition")};
import { ref, get, create, update, stop, type CreateInput } from ${source("tactical/battlefield/projectile/operations")};
import { advance } from ${source("tactical/battlefield/projectile/advance")};
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
declare const battle: BattleState;
declare const input: CreateInput<{ charges: number }>;
declare const unit: Ref<Unit>;
declare const projectile: Projectile<{ charges: number }>;
declare const specialized: Ref<Projectile<{ charges: number }> & { readonly marker: 17 }>;
const definition: Definition<{ charges: number }> = {
    id: "charges",
    onCreate(current, self) {
        const charges: number = self.state.charges;
        return update(current, ref(self), latest => ({ state: { charges: latest.state.charges + charges } }));
    },
    onAdvance(current, self) {
        return update(current, ref(self), latest => ({ position: [latest.position[0] + 1, 0] }));
    },
    onTerminate(current, self, reason) {
        const charges: number = self.state.charges;
        const ending: "ACTIVE" | "ENDING" = self.lifecycle;
        if (reason === "DISPEL") return current;
        return update(current, ref(self), latest => ({ state: { charges: latest.state.charges - charges } }));
    },
};
const created = create(battle, definition, input);
type Created = Assert<Equal<typeof created.value, Ref<Projectile<{ charges: number }>>>>;
const current = get(created.state, created.value);
type Current = Assert<Equal<typeof current, Projectile<{ charges: number }> | undefined>>;
const known = ref(projectile);
type Known = Assert<Equal<typeof known, Ref<Projectile<{ charges: number }>>>>;
const weaker: Ref<Projectile<{ charges: number }>> = specialized;
const erased: Ref<View> = weaker;
const entries = Projectiles.empty().add(projectile);
const publicEntries: Query<View> = entries.values();
const candidates = entries.values().map(ref).toArray();
type Candidates = Assert<Equal<typeof candidates, readonly Ref<View>[]>>;
advance(battle, candidates);
entries.replace(known, projectile);
entries.read(known.id, self => {
    self.definition.onCreate?.(battle, self);
    self.definition.onAdvance?.(battle, self);
    self.definition.onTerminate?.(battle, self, "EXPLICIT");
    update(battle, ref(self), latest => ({ state: latest.state, position: latest.position }));
});
update(battle, known, latest => {
    const charges: number = latest.state.charges;
    // @ts-expect-error snapshots supplied to transform are read-only.
    latest.position = [1, 0];
    // @ts-expect-error private state values retain the precise Ref's type.
    const wrong: string = latest.state.charges;
    return { state: { charges: charges - 1 } };
});
update(battle, known, () => ({}));
update(battle, known, latest => ({ position: latest.position }));
// @ts-expect-error a precise reference fixes replacement state inference.
entries.replace(known, { ...projectile, state: { charges: "wrong" } });
// @ts-expect-error public references do not prove writable private state types.
entries.replace(erased, projectile);
// @ts-expect-error public views cannot be inserted as complete instances.
entries.add(get(battle, erased)!);
// @ts-expect-error snapshots retain unknown payloads, not writable type proofs.
entries.replace(known, entries.snapshot()[0]!);
const fromView = battlefieldView(battle).getProjectile(known);
type FromView = Assert<Equal<typeof fromView, Projectile<{ charges: number }> | undefined>>;
stop(battle, erased);
stop(battle, weaker, "DISPEL");
// @ts-expect-error
const forged: Ref<Projectile<{ charges: number }>> = { id: 0 };
// @ts-expect-error
const strengthened: Ref<Projectile<{ charges: number }> & { readonly marker: 17 }> = weaker;
// @ts-expect-error
const mismatched: Ref<Projectile<{ label: string }>> = weaker;
// @ts-expect-error
get(battle, unit);
// @ts-expect-error
get(battle, 0);
// @ts-expect-error
get(battle, projectile);
// @ts-expect-error
get(battle, weaker, definition);
// @ts-expect-error
stop(battle, 0);
// @ts-expect-error
ref(0);
// @ts-expect-error
get(battle, erased)!.definition.onAdvance;
// @ts-expect-error
get(battle, erased)!.state;
// @ts-expect-error
update(battle, erased, () => ({ state: {} }));
// @ts-expect-error
update(battle, known, () => ({ state: { charges: "wrong" } }));
// @ts-expect-error
update(battle, unit, () => ({ position: [0, 0] }));
// @ts-expect-error
create(battle, definition, { ...input, state: { charges: "wrong" } });
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
