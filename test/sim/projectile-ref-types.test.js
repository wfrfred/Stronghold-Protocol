import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("Projectile Refs preserve private state types through creation, queries and covariance", async () => {
    const { default: ts } = await import("typescript");
    const directory = mkdtempSync(join(tmpdir(), "stronghold-projectile-ref-types-"));
    const source = name => JSON.stringify(fileURLToPath(new URL(`../../src/core/${name}.js`, import.meta.url)));
    const path = join(directory, "refs.mts");
    try {
        writeFileSync(path, `
import type { Ref } from ${source("common/ref")};
import type { State as BattleState } from ${source("tactical/battle/state")};
import { battlefieldView } from ${source("tactical/battle/state")};
import type { Unit } from ${source("tactical/unit/unit")};
import type { Projectile } from ${source("tactical/battlefield/projectile/projectile")};
import type { Projectiles } from ${source("tactical/battlefield/projectile/projectiles")};
import { createDefinition } from ${source("tactical/battlefield/projectile/definition")};
import { all, ref, getProjectile, launchProjectile, replaceProjectile, createProjectileOperations, type ProjectileLaunchInput } from ${source("tactical/battlefield/projectile/operations")};
import { stopProjectile } from ${source("tactical/battlefield/projectile/settlement")};
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type Stored = ReturnType<Projectiles["values"]>[number];
declare const battle: BattleState;
declare const input: ProjectileLaunchInput<{ charges: number }>;
declare const unit: Ref<Unit>;
declare const projectile: Projectile<{ charges: number }>;
declare const specialized: Ref<Projectile<{ charges: number }> & { readonly marker: 17 }>;
const definition = createDefinition({
    id: "charges", initialize: () => ({ charges: 2 }), acceptsContact: () => false,
    contact: (current, context) => {
        const charges: number = context.projectile.state.charges;
        return replaceProjectile(current, { ...context.projectile, state: { charges: charges - 1 } });
    },
});
const launched = launchProjectile(battle, definition, input, 0);
type Launched = Assert<Equal<typeof launched.value, Ref<Projectile<{ charges: number }>>>>;
const current = getProjectile(launched.state, launched.value);
type Current = Assert<Equal<typeof current, Projectile<{ charges: number }> | undefined>>;
const known = ref(projectile);
type Known = Assert<Equal<typeof known, Ref<Projectile<{ charges: number }>>>>;
const weaker: Ref<Projectile<{ charges: number }>> = specialized;
const erased: Ref<Stored> = weaker;
const candidates = all(battle);
type Candidates = Assert<Equal<typeof candidates, Ref<Stored>[]>>;
const fromView = battlefieldView(battle).getProjectile(known);
type FromView = Assert<Equal<typeof fromView, Projectile<{ charges: number }> | undefined>>;
const operations = createProjectileOperations(0);
const fromOperations = operations.get(battle, known);
type FromOperations = Assert<Equal<typeof fromOperations, Projectile<{ charges: number }> | undefined>>;
stopProjectile(battle, weaker, 1);
// @ts-expect-error
const forged: Ref<Projectile<{ charges: number }>> = { id: 0 };
// @ts-expect-error
const strengthened: Ref<Projectile<{ charges: number }> & { readonly marker: 17 }> = weaker;
// @ts-expect-error
const mismatched: Ref<Projectile<{ label: string }>> = weaker;
// @ts-expect-error
getProjectile(battle, unit);
// @ts-expect-error
getProjectile(battle, 0);
// @ts-expect-error
getProjectile(battle, projectile);
// @ts-expect-error
getProjectile(battle, weaker, definition);
// @ts-expect-error
stopProjectile(battle, 0, 1);
// @ts-expect-error
ref(0);
// @ts-expect-error
getProjectile(battle, erased)!.definition.contact;
// @ts-expect-error
replaceProjectile(battle, { ...projectile, state: { charges: "wrong" } });
// @ts-expect-error
launchProjectile(battle, definition, { ...input, initialState: { charges: "wrong" } }, 0);
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
