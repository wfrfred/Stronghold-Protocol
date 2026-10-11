import type { UnitId } from "../../../unit.js";
import type { Hook as RegisteredHook } from "../../../hook/hook.js";
import { hasVitality } from "../capability.js";
import { getUnit, type BattleState } from "../../../../battle/execution/context.js";
import { context, type Dispatch, type Result } from "../hook.js";
import type { DamageOperands, DamageReport, DamageRequest, PendingDamage } from "./contract.js";
import type { AmountStage, Context, FormulaStage, Hook, Services } from "./hook.js";

interface StageHook<V> extends RegisteredHook<Context, V, Result<V>> {
    readonly priority: number;
}

function dispatchStage<V>(
    battle: BattleState,
    request: DamageRequest,
    ownerUnitId: UnitId | null,
    value: V,
    services: Services,
    dispatch: Dispatch,
    select: (entry: Hook) => StageHook<V> | undefined,
): V {
    const unit = ownerUnitId === null ? undefined : getUnit(battle, ownerUnitId);

    if (unit === undefined || !hasVitality(unit)) {
        return value;
    }

    return dispatch.withCandidates(unit, (snapshot) => {
        const candidates = snapshot.damage
            .flatMap((entry) => {
                const hook = select(entry);

                return hook === undefined ? [] : [{ entry, hook }];
            })
            .sort((left, right) => right.hook.priority - left.hook.priority);

        for (const { entry, hook } of candidates) {
            const current = getUnit(battle, unit.id);

            if (
                current === undefined ||
                !hasVitality(current) ||
                !current.vitality.damageHooks.includes(entry)
            ) {
                continue;
            }

            const invocation = context(battle, unit.id, request, services, dispatch);

            if (!hook.enabled(invocation)) {
                continue;
            }

            const result = hook.invoke(invocation, value);
            value = result.value;

            if (result.stopDispatch === true) {
                break;
            }
        }

        return value;
    });
}

export function dispatchDamageFormula(
    battle: BattleState,
    request: DamageRequest,
    owner: UnitId | null,
    stage: FormulaStage,
    operands: DamageOperands,
    services: Services,
    dispatch: Dispatch,
): DamageOperands {
    return dispatchStage(battle, request, owner, operands, services, dispatch, (entry) =>
        (entry.stage === "sourceFormula" || entry.stage === "targetFormula") &&
        entry.stage === stage
            ? entry
            : undefined,
    );
}

export function dispatchDamageAmount(
    battle: BattleState,
    request: DamageRequest,
    owner: UnitId | null,
    stage: AmountStage,
    pending: PendingDamage,
    services: Services,
    dispatch: Dispatch,
): PendingDamage {
    return dispatchStage(battle, request, owner, pending, services, dispatch, (entry) =>
        (entry.stage === "output" ||
            entry.stage === "reception" ||
            entry.stage === "skippedReception") &&
        entry.stage === stage
            ? entry
            : undefined,
    );
}

export function dispatchDamageReactions(
    battle: BattleState,
    report: DamageReport,
    services: Services,
    dispatch: Dispatch,
): void {
    const owners = new Set([report.request.sourceUnitId, report.request.targetUnitId]);

    for (const owner of owners) {
        dispatchStage(battle, report.request, owner, report, services, dispatch, (entry) => {
            if (entry.stage !== "reaction") {
                return undefined;
            }

            return {
                id: entry.id,
                priority: entry.priority,
                enabled: entry.enabled,
                invoke: (invocation, value) => {
                    const outcome = entry.invoke(invocation, value);

                    return outcome?.stopDispatch === true
                        ? { value, stopDispatch: true }
                        : { value };
                },
            };
        });
    }
}
