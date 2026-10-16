import { assertNonnegativeSafeInteger } from "../../../../common/assert.js";
import type { Ref } from "../../../../common/ref.js";
import type { State as BattleState, Result } from "../../../battle/state.js";
import type { Actions } from "../../action/actions.js";
import * as actions from "../../action/operations.js";
import type { Unit } from "../../unit.js";
import * as units from "../../query.js";
import * as hook from "../../hook/hook.js";
import type { Action } from "./capability.js";

type StoredAction = ReturnType<Actions["values"]>[number];

export type Directive =
    { readonly type: "CONTINUE" } | { readonly type: "INTERRUPT"; readonly recoveryTicks: number };

export interface Context {
    readonly source: Ref<Unit & Action>;
    readonly action: Ref<StoredAction>;
}

export type Hook = hook.Hook<Context, Directive>;

export type ReleasedHook = hook.Hook<Context, void>;

export function beforeRelease(battle: BattleState, ref: Ref<StoredAction>): Result<Directive> {
    const action = actions.get(battle, ref);

    if (action === undefined) {
        return { state: battle, value: { type: "CONTINUE" } };
    }

    const context: Context = { action: ref, source: action.source };
    const result = hook.dispatch<Context, Directive>(
        battle,
        context,
        { type: "CONTINUE" },
        {
            candidates: (current) =>
                units.get(current, context.source)?.action.beforeRelease.map(({ id }) => id) ?? [],
            find: (current, id) =>
                units
                    .get(current, context.source)
                    ?.action.beforeRelease.find((entry) => entry.id === id),
            stop: (current, directive) =>
                directive.type === "INTERRUPT" || !running(current, context),
        },
    );

    if (result.value.type === "INTERRUPT") {
        assertNonnegativeSafeInteger(result.value.recoveryTicks, "action release recovery");
    }

    return result;
}

export function released(battle: BattleState, ref: Ref<StoredAction>): BattleState {
    const action = actions.get(battle, ref);

    if (action === undefined) {
        return battle;
    }

    const context: Context = { action: ref, source: action.source };

    return hook.dispatch(battle, context, undefined, {
        candidates: (current) =>
            units.get(current, context.source)?.action.released.map(({ id }) => id) ?? [],
        find: (current, id) =>
            units.get(current, context.source)?.action.released.find((entry) => entry.id === id),
        stop: (current) => !running(current, context),
    }).state;
}

function running(battle: BattleState, context: Context): boolean {
    return (
        actions.get(battle, context.action)?.status === "RUNNING" &&
        units.get(battle, context.source)?.lifecycle === "PRESENT"
    );
}
