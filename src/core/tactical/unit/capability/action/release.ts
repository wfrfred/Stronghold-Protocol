import { assertNonnegativeSafeInteger } from "../../../../common/assert.js";
import type { Ref } from "../../../../common/ref.js";
import type { State as BattleState, Result } from "../../../battle/state.js";
import type { Actions } from "../../action/actions.js";
import * as actions from "../../action/operations.js";
import type { Unit } from "../../unit.js";
import * as units from "../../query.js";
import type { Action } from "./capability.js";

type StoredAction = ReturnType<Actions["values"]>[number];

export type Directive =
    { readonly type: "CONTINUE" } | { readonly type: "INTERRUPT"; readonly recoveryTicks: number };

export interface Hook {
    readonly id: string;
    readonly enabled: (
        battle: BattleState,
        self: Unit & Action,
        action: Ref<StoredAction>,
    ) => boolean;
    readonly invoke: (
        battle: BattleState,
        self: Unit & Action,
        action: Ref<StoredAction>,
    ) => Result<Directive>;
}

export function beforeRelease(battle: BattleState, ref: Ref<StoredAction>): Result<Directive> {
    const action = actions.get(battle, ref);
    const source = action === undefined ? undefined : units.get(battle, action.source);

    if (action?.status !== "RUNNING" || source?.lifecycle !== "PRESENT") {
        return { state: battle, value: { type: "CONTINUE" } };
    }

    const candidates = source.action.beforeRelease.map(({ id }) => id);

    for (const id of candidates) {
        const currentAction = actions.get(battle, ref);
        const current =
            currentAction === undefined ? undefined : units.get(battle, currentAction.source);
        const candidate = current?.action.beforeRelease.find((entry) => entry.id === id);

        if (
            currentAction?.status !== "RUNNING" ||
            current?.lifecycle !== "PRESENT" ||
            !candidate?.enabled(battle, current, ref)
        ) {
            continue;
        }

        const invoked = candidate.invoke(battle, current, ref);
        battle = invoked.state;

        if (invoked.value.type === "INTERRUPT") {
            assertNonnegativeSafeInteger(invoked.value.recoveryTicks, "action release recovery");

            return { state: battle, value: invoked.value };
        }
    }

    return { state: battle, value: { type: "CONTINUE" } };
}
