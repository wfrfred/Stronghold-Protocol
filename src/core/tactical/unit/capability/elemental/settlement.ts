import {
    assertFiniteNumber,
    assertNonnegativeNumber,
    assertNonnegativeSafeInteger,
} from "../../../../common/assert.js";
import { widenUnit, type StableUnit, type Unit, type UnitId } from "../../unit.js";
import {
    ELEMENT_TYPES,
    elementValues,
    hasElemental,
    type ElementalRecovery,
    type ElementalReceiver,
    type ElementalUnit,
    type ElementType,
    type ElementValues,
} from "./capability.js";
import { elementalRejection, type ElementalRejection } from "./query.js";

export interface ElementalBurst extends ElementalRecovery {
    readonly receiver: ElementalReceiver;
    readonly targetUnitId: UnitId;
}

export interface ElementDamageRequest {
    readonly type: ElementType;
    readonly power: number;
    readonly sourceUnitId: UnitId | null;
    readonly tick: number;
}

export interface ElementHealRequest {
    readonly power: number;
    readonly tick: number;
}

export type ElementDamageResult<U extends Unit = Unit> = {
    readonly unit: StableUnit<U>;
} & (
    | {
          readonly outcome: "REJECTED";
          readonly reason: ElementalRejection;
          readonly amount: 0;
          readonly burst: null;
      }
    | { readonly outcome: "APPLIED"; readonly amount: number; readonly burst: null }
    | { readonly outcome: "BURST"; readonly amount: number; readonly burst: ElementalBurst }
);

export type ElementHealResult<U extends Unit = Unit> = {
    readonly unit: StableUnit<U>;
    readonly amount: number;
    readonly amounts: ElementValues;
} & (
    | { readonly outcome: "REJECTED"; readonly reason: ElementalRejection }
    | { readonly outcome: "APPLIED" }
);

export interface ElementalAdvanceResult<U extends Unit = Unit> {
    readonly unit: StableUnit<U>;
    readonly recovered: boolean;
    readonly burst: ElementalBurst | null;
}

function assertTick(unit: Unit, tick: number): void {
    assertNonnegativeSafeInteger(tick, "element operation tick");

    if (hasElemental(unit) && tick < unit.elemental.lastRecoveryTick) {
        throw new RangeError("element operation cannot precede its recovery progress");
    }
}

function burstOf(unit: ElementalUnit, recovery: ElementalRecovery): ElementalBurst {
    return Object.freeze({
        ...recovery,
        receiver: unit.definition.elemental.receiver,
        targetUnitId: unit.id,
    });
}

export function receiveElementDamage<U extends Unit>(
    input: U | StableUnit<U>,
    request: ElementDamageRequest,
): ElementDamageResult<U> {
    const unit = widenUnit<U>(input);

    assertTick(unit, request.tick);
    assertNonnegativeNumber(request.power, "element damage power");

    if (request.sourceUnitId !== null) {
        assertNonnegativeSafeInteger(request.sourceUnitId, "element damage source identity");
    }

    const reason = elementalRejection(unit);

    if (reason !== undefined) {
        return { unit, outcome: "REJECTED", reason, amount: 0, burst: null };
    }
    if (!hasElemental(unit)) {
        throw new TypeError("accepted element damage requires Elemental capability");
    }

    const power =
        request.power *
        Math.max(0.05, 1 - Math.max(0, unit.definition.elemental.elementResistance) / 100);

    assertFiniteNumber(power, "resolved element damage");

    const previous = unit.elemental.ep[request.type];
    const amount = Math.min(previous, power);

    if (amount === 0) {
        return { unit, outcome: "APPLIED", amount: 0, burst: null };
    }

    const remaining = previous - amount;

    if (remaining > 0) {
        return {
            unit: {
                ...unit,
                elemental: {
                    ...unit.elemental,
                    ep: Object.freeze({ ...unit.elemental.ep, [request.type]: remaining }),
                    lastRecoveryTick: request.tick,
                },
            },
            outcome: "APPLIED",
            amount,
            burst: null,
        };
    }

    const endsAtTick = request.tick + unit.definition.elemental.burstDurationsTicks[request.type];

    assertNonnegativeSafeInteger(endsAtTick, "element burst recovery deadline");

    const recovery = Object.freeze({
        type: request.type,
        sourceUnitId: request.sourceUnitId,
        startedAtTick: request.tick,
        endsAtTick,
    });

    return {
        unit: {
            ...unit,
            elemental: {
                ...unit.elemental,
                ep: elementValues(0),
                recovery,
                lastRecoveryTick: request.tick,
            },
        },
        outcome: "BURST",
        amount,
        burst: burstOf(unit, recovery),
    };
}

export function receiveElementHeal<U extends Unit>(
    input: U | StableUnit<U>,
    request: ElementHealRequest,
): ElementHealResult<U> {
    const unit = widenUnit<U>(input);

    assertTick(unit, request.tick);
    assertNonnegativeNumber(request.power, "element heal power");

    const reason = elementalRejection(unit);

    if (reason !== undefined) {
        return { unit, outcome: "REJECTED", reason, amount: 0, amounts: elementValues(0) };
    }
    if (!hasElemental(unit)) {
        throw new TypeError("accepted element healing requires Elemental capability");
    }

    const ep = { ...unit.elemental.ep };
    const amounts = { ...elementValues(0) };
    let amount = 0;

    for (const type of ELEMENT_TYPES) {
        const restored = Math.min(request.power, unit.definition.elemental.maxEp - ep[type]);

        ep[type] += restored;
        amounts[type] = restored;
        amount += restored;
    }

    assertFiniteNumber(amount, "total restored EP");

    return {
        unit:
            amount === 0
                ? unit
                : {
                      ...unit,
                      elemental: {
                          ...unit.elemental,
                          ep: Object.freeze(ep),
                          lastRecoveryTick: request.tick,
                      },
                  },
        outcome: "APPLIED",
        amount,
        amounts: Object.freeze(amounts),
    };
}

export function advanceElemental<U extends Unit>(
    input: U | StableUnit<U>,
    tick: number,
): ElementalAdvanceResult<U> {
    const unit = widenUnit<U>(input);

    assertTick(unit, tick);

    if (!hasElemental(unit) || tick === unit.elemental.lastRecoveryTick) {
        return { unit, recovered: false, burst: null };
    }

    const { recovery } = unit.elemental;

    if (recovery !== null) {
        const recovered = tick >= recovery.endsAtTick;
        const ratio = Math.min(
            1,
            (tick - recovery.startedAtTick) / (recovery.endsAtTick - recovery.startedAtTick),
        );

        return {
            unit: {
                ...unit,
                elemental: {
                    ...unit.elemental,
                    ep: elementValues(unit.definition.elemental.maxEp * ratio),
                    recovery: recovered ? null : recovery,
                    lastRecoveryTick: tick,
                },
            },
            recovered,
            burst: burstOf(unit, recovery),
        };
    }

    if (unit.definition.elemental.recoveryPerTick === 0) {
        return { unit, recovered: false, burst: null };
    }

    const recoveryAmount =
        unit.definition.elemental.recoveryPerTick * (tick - unit.elemental.lastRecoveryTick);

    assertFiniteNumber(recoveryAmount, "natural element recovery");

    const ep = { ...unit.elemental.ep };

    for (const type of ELEMENT_TYPES) {
        ep[type] += Math.min(recoveryAmount, unit.definition.elemental.maxEp - ep[type]);
    }

    return {
        unit: {
            ...unit,
            elemental: { ...unit.elemental, ep: Object.freeze(ep), lastRecoveryTick: tick },
        },
        recovered: false,
        burst: null,
    };
}
