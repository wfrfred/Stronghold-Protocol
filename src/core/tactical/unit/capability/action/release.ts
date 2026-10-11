import { assertNonnegativeSafeInteger } from "../../../../common/assert.js";
import { getUnit, transitionUnit, type BattleState } from "../../../battle/execution/context.js";
import type { Hook } from "../../hook/hook.js";
import type { Unit, UnitId } from "../../unit.js";
import { hasAction, type Action } from "./capability.js";

export type ActionReleaseDirective =
    { readonly type: "CONTINUE" } | { readonly type: "INTERRUPT"; readonly recoveryTicks: number };

export interface ActionReleaseContext {
    readonly battle: BattleState;
    readonly unit: Unit & Action;
    readonly tick: number;
}

export type ActionReleaseHook = Hook<ActionReleaseContext, void, ActionReleaseDirective>;

export function beforeActionRelease(state: BattleState, unitId: UnitId, tick: number): boolean {
    const unit = getUnit(state, unitId);

    if (unit === undefined || !hasAction(unit)) {
        return false;
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
            battle: state,
            tick,
            get unit() {
                return getUnit(state, unitId)! as Unit & Action;
            },
        };

        if (!candidate.enabled(context)) {
            continue;
        }

        const directive = candidate.invoke(context, undefined);

        if (directive.type === "CONTINUE") {
            continue;
        }

        assertNonnegativeSafeInteger(directive.recoveryTicks, "action release recovery");
        const recoveryUntilTick = tick + directive.recoveryTicks;
        assertNonnegativeSafeInteger(recoveryUntilTick, "action release recovery deadline");
        transitionUnit(state, unitId, (current) => {
            if (!hasAction(current) || current.action.recoveryUntilTick >= recoveryUntilTick) {
                return current;
            }

            return { ...current, action: { ...current.action, recoveryUntilTick } };
        });

        return true;
    }

    return false;
}
