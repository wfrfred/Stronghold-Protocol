import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("Contribution selection preserves payload types independently of attributes", async () => {
    const { default: ts } = await import("typescript");
    const directory = mkdtempSync(join(tmpdir(), "stronghold-contribution-types-"));
    const module = (name) => JSON.stringify(fileURLToPath(new URL(`../../src/core/tactical/unit/${name}.js`, import.meta.url)));
    const path = join(directory, "contributions.mts");
    try {
        writeFileSync(path, `
import { set, resolve, type Contribution } from ${module("contribution/contribution")};
import * as attribute from ${module("contribution/attribute")};
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
declare const volumes: readonly Contribution<number>[];
const selectedVolumes = resolve(volumes);
type Volumes = Assert<Equal<typeof selectedVolumes, readonly number[]>>;
const nextVolumes = set(volumes, { id: "extra", value: 1 });
type NextVolumes = Assert<Equal<typeof nextVolumes, readonly Contribution<number>[]>>;
type Budget = { readonly fixed: number; readonly ratio: number };
declare const budgets: readonly Contribution<Budget>[];
const selectedBudgets = resolve(budgets);
type Budgets = Assert<Equal<typeof selectedBudgets, readonly Budget[]>>;
declare const modifiers: readonly Contribution<readonly attribute.Modifier[]>[];
const selectedModifiers = resolve(modifiers);
type Modifiers = Assert<Equal<typeof selectedModifiers, readonly (readonly attribute.Modifier[])[]>>;
attribute.apply(100, selectedModifiers.flat());
declare const inputs: readonly Contribution<(amount: number) => number>[];
const selectedInputs = resolve(inputs);
type Inputs = Assert<Equal<typeof selectedInputs, readonly ((amount: number) => number)[]>>;
const evaluated: readonly number[] = selectedInputs.map(input => input(2));
// @ts-expect-error
type ImplicitAttribute = Contribution;
// @ts-expect-error
attribute.apply(100, selectedVolumes);
// @ts-expect-error
attribute.apply(100, selectedBudgets);
// @ts-expect-error
attribute.apply(100, selectedModifiers);
// @ts-expect-error
resolve(inputs, input => input(2));
`);
        const program = ts.createProgram([path], {
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            exactOptionalPropertyTypes: true,
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.NodeNext,
            moduleResolution: ts.ModuleResolutionKind.NodeNext,
        });
        const diagnostics = ts.getPreEmitDiagnostics(program);
        assert.deepEqual(diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")), []);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
