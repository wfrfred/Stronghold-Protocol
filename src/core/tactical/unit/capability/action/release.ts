import { assertNonnegativeSafeInteger } from "../../../../common/assert.js";
import {
    battlefieldView,
    getUnit,
    transitionUnit,
    type BattleState,
    type Result,
} from "../../../battle/state.js";
import { emptyCall, type CallContext } from "../../../battle/execution/call.js";
import type { BattlefieldView } from "../../../battlefield/contract.js";
import type { Hook } from "../../hook/hook.js";
import type { Unit, UnitId } from "../../unit.js";
import { hasAction, type Action } from "./capability.js";

export type ActionReleaseDirective =
    { readonly type: "CONTINUE" } | { readonly type: "INTERRUPT"; readonly recoveryTicks: number };

export interface ActionReleaseContext {
    readonly battlefield: BattlefieldView;
    readonly unit: Unit & Action;
    readonly tick: number;
    readonly call: CallContext;
}

export type ActionReleaseHook = Hook<
    BattleState,
    ActionReleaseContext,
    void,
    ActionReleaseDirective
>;

export function beforeActionRelease(
    state: BattleState,
    unitId: UnitId,
    tick: number,
    call: CallContext = emptyCall,
): Result<boolean> {
    const unit = getUnit(state, unitId);

    if (unit === undefined || !hasAction(unit)) {
        return { state, value: false };
    }

    const candidates = unit.action.beforeRelease;

    for (const candidate of candidates) {
        const current = getUnit(state, unitId);

        if (
            current === undefined ||
            !hasAction(current) ||
            !current.action.beforeRelease.includes(candidate)
        ) {
            continue;
        }

        const context: ActionReleaseContext = {
            battlefield: battlefieldView(state),
            tick,
            unit: current,
            call,
        };

        if (!candidate.enabled(context)) {
            continue;
        }

        const invoked = candidate.invoke(state, context, undefined);
        state = invoked.state;
        const directive = invoked.value;

        if (directive.type === "CONTINUE") {
            continue;
        }

        assertNonnegativeSafeInteger(directive.recoveryTicks, "action release recovery");
        const recoveryUntilTick = tick + directive.recoveryTicks;
        assertNonnegativeSafeInteger(recoveryUntilTick, "action release recovery deadline");
        state = transitionUnit(state, unitId, (current) => {
            return !hasAction(current) || current.action.recoveryUntilTick >= recoveryUntilTick
                ? current
                : { ...current, action: { ...current.action, recoveryUntilTick } };
        });

        return { state, value: true };
    }

    return { state, value: false };
}
