import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("store supports object keys and typed queries without permitting construction or narrowing writes", async () => {
    const { default: ts } = await import("typescript");
    const directory = mkdtempSync(join(tmpdir(), "stronghold-store-types-"));
    const source = name => JSON.stringify(fileURLToPath(new URL(`../../src/core/common/${name}.js`, import.meta.url)));
    const path = join(directory, "store.mts");

    try {
        writeFileSync(path, `
import { Store } from ${source("collection/store")};
import type { Query } from ${source("query")};
interface Item { readonly id: number }
interface Named extends Item { readonly name: string }
const key = { id: 1 };
const empty = Store.empty<object, Item | undefined>();
const added: Store<object, Item | undefined> = empty.add(key, { id: 1 });
const replaced: Store<object, Item | undefined> = added.replace(key, undefined);
const removed: Store<object, Item | undefined> = replaced.remove(key);
const size: number = removed.size;
const found: Item | undefined = added.get(key);
const keys: Query<object> = added.keys();
const values: Query<Item | undefined> = added.values();
const named: Query<Named> = values.filter((value): value is Named =>
    value !== undefined && "name" in value && typeof value.name === "string");
const names: readonly string[] = named.map(value => value.name).toArray();
// @ts-expect-error Store construction is controlled by its factory.
new Store();
// @ts-expect-error Keys retain their declared type.
added.get("other");
// @ts-expect-error Writes retain the declared value contract.
added.add(key, { unrelated: true });
// @ts-expect-error Replacements retain the declared value contract.
added.replace(key, { unrelated: true });
// @ts-expect-error Query materialization is readonly.
names.push("changed");
const precise = Store.empty<object, Named>().add(key, { id: 1, name: "first" });
const broad: Store<object, Item> = precise;
const changed = broad.replace(key, { id: 2 });
// @ts-expect-error A write through a widened store does not regain the old value proof.
const narrowed: Store<object, Named> = changed;
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
