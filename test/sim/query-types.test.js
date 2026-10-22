import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("query guards preserve narrowed values while ordinary predicates and terminals retain their contracts", async () => {
    const { default: ts } = await import("typescript");
    const directory = mkdtempSync(join(tmpdir(), "stronghold-query-types-"));
    const source = name => JSON.stringify(fileURLToPath(new URL(`../../src/core/common/${name}.js`, import.meta.url)));
    const path = join(directory, "query.mts");

    try {
        writeFileSync(path, `
import { create, type Query } from ${source("query")};
import { sort, topK } from ${source("collection")};
interface Base { readonly id: number }
interface Named extends Base { readonly name: string }
declare const values: readonly Base[];
declare const isNamed: (value: Base) => value is Named;
const all: Query<Base> = create(() => values[Symbol.iterator]());
const named: Query<Named> = all.filter(isNamed);
const names: readonly string[] = named.map(value => value.name).toArray();
const found: Named | undefined = all.find(isNamed);
const ordinary: (value: Base) => boolean = value => value.id > 0;
const filtered = all.filter(ordinary);
filtered.map(value => {
    // @ts-expect-error boolean predicates do not install new properties.
    return value.name;
});
// @ts-expect-error boolean find results remain Base values.
const invalidFind: Named | undefined = all.find(ordinary);
const flattened: Query<string> = named.flatMap(value => new Set([value.name]));
const limited: Query<Named> = named.take(2);
const total: number = named.reduce((sum, value) => sum + value.name.length, 0);
const exists: boolean = named.some(value => value.name.length > 0);
const iterator: Iterator<Base> = all[Symbol.iterator]();
const sorted: readonly Named[] = sort(named, (left, right) => left.id - right.id);
const best: readonly Named[] = topK(named, 2, (left, right) => left.id - right.id);
// @ts-expect-error query materialization is readonly.
names.push("changed");
// @ts-expect-error sorting produces readonly results.
sorted.push({ id: 3, name: "changed" });
// @ts-expect-error topK produces readonly results.
best.push({ id: 3, name: "changed" });
// @ts-expect-error constructing a query requires a cursor factory.
create(values[Symbol.iterator]());
`);
        const program = ts.createProgram([path], {
            strict: true, noEmit: true, skipLibCheck: true,
            exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true,
            target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
            moduleResolution: ts.ModuleResolutionKind.NodeNext, types: [],
        });

        assert.deepEqual(ts.getPreEmitDiagnostics(program).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")), []);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
