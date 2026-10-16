import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("Hook contracts distinguish fixed context, state and the forwarded value, including void", async () => {
    const { default: ts } = await import("typescript");
    const directory = mkdtempSync(join(tmpdir(), "stronghold-hook-types-"));
    const source = name => JSON.stringify(fileURLToPath(new URL(`../../src/core/tactical/${name}.js`, import.meta.url)));
    const path = join(directory, "hooks.mts");
    try {
        writeFileSync(path, `
import { dispatch, set, type Hook, type DispatchOptions } from ${source("unit/hook/hook")};
import type { State as BattleState, Result } from ${source("battle/state")};
interface Context { readonly activation: { readonly id: number } }
declare const battle: BattleState;
declare const context: Context;
const program: Hook<Context, number> = {
    id: "number",
    accepts(battle, context, current) {
        const state: BattleState = battle;
        const event: number = context.activation.id;
        const amount: number = current;
        return state.tick >= event && amount > 0;
    },
    invoke(battle, context, current) {
        // @ts-expect-error fixed event facts are readonly.
        context.activation.id = current;
        return { state: battle, value: current + context.activation.id };
    },
};
const options: DispatchOptions<Context, number> = {
    candidates: () => [program.id],
    find: () => program,
    stop: (battle, current) => battle.tick > current,
};
const result: Result<number> = dispatch(battle, context, 1, options);
const notification: Hook<Context, void> = {
    id: "notification", invoke: (state, event) => ({ state, value: undefined }),
};
const notified: Result<void> = dispatch(battle, context, undefined, {
    candidates: () => [notification.id], find: () => notification,
});
const contextless: Hook<void, void> = {
    id: "contextless", invoke: state => ({ state, value: undefined }),
};
dispatch(battle, undefined, undefined, {
    candidates: () => [contextless.id], find: () => contextless,
});
set([program], { ...program, id: "replacement" });
// @ts-expect-error query predicates cannot return a state transition.
const badPredicate: Hook<Context, number> = { id: "bad", accepts: () => ({ state: battle, value: true }), invoke: program.invoke };
// @ts-expect-error operation values are returned directly rather than inside a second Result.
const nestedResult: Hook<Context, number> = { id: "bad", invoke: () => ({ state: battle, value: { value: 1 } }) };
// @ts-expect-error the invoke result must forward the declared operation value.
const wrongValue: Hook<Context, number> = { id: "bad", invoke: () => ({ state: battle, value: "one" }) };
// @ts-expect-error notification callbacks must return Result<void>.
const bareState: Hook<Context, void> = { id: "bad", invoke: () => battle };
// @ts-expect-error contexts are explicit fixed dispatch inputs, not refreshed by a resolver.
const liveContext: DispatchOptions<Context, number> = { ...options, context: () => context };
// @ts-expect-error the old four-parameter Hook contract is removed.
type LegacyHook = Hook<BattleState, Context, number, number>;
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
