import {
    assertNonnegativeNumber,
    assertNonnegativeSafeInteger,
} from "../../../../common/assert.js";
import type { Ref } from "../../../../common/ref.js";
import { TICKS_PER_SECOND } from "../../../tick.js";
import { appendEvents, type State as BattleState, type Result } from "../../../battle/state.js";
import { closeLifetime } from "../../../battle/execution/lifetime.js";
import * as units from "../../query.js";
import type { Unit } from "../../unit.js";
import {
    ELEMENT_TYPES,
    elementValues,
    hasElemental,
    type Elemental,
    type Type,
    type Values,
} from "./capability.js";
import { ref as burstRef, type Burst, type End } from "./burst.js";
import { dispatch, receive, type Damaged, type Healed } from "./hook.js";
import * as query from "./query.js";

export interface DamageRequest {
    readonly source: Ref<Unit> | null;
    readonly type: Type;
    readonly power: number;
}

export interface HealRequest {
    readonly source: Ref<Unit> | null;
    readonly power: number;
}

export type DamageOutcome =
    | { readonly type: "APPLIED"; readonly amount: number; readonly burst: Ref<Burst> | null }
    | { readonly type: "REJECTED"; readonly reason: string };

export type HealOutcome =
    | { readonly type: "APPLIED"; readonly amounts: Values }
    | { readonly type: "REJECTED"; readonly reason: string };

export type Signal =
    | {
          readonly type: "ELEMENT_DAMAGE";
          readonly sourceUnitId: number | null;
          readonly targetUnitId: number;
          readonly elementType: Type;
          readonly amount: number;
          readonly ep: number;
          readonly tick: number;
      }
    | {
          readonly type: "ELEMENT_HEAL";
          readonly sourceUnitId: number | null;
          readonly targetUnitId: number;
          readonly amounts: Values;
          readonly tick: number;
      }
    | { readonly type: "ELEMENT_BURST"; readonly burst: Burst; readonly tick: number }
    | {
          readonly type: "ELEMENT_RECOVERED";
          readonly unitId: number;
          readonly elementType: Type;
          readonly tick: number;
      }
    | {
          readonly type: "ELEMENT_BURST_ENDED";
          readonly burst: Burst;
          readonly end: End;
          readonly tick: number;
      };

export function damage(
    battle: BattleState,
    target: Ref<Unit>,
    request: DamageRequest,
): Result<DamageOutcome> {
    assertNonnegativeNumber(request.power, "element damage power");

    if (!ELEMENT_TYPES.includes(request.type)) {
        throw new TypeError("unknown element damage type");
    }

    let self = units.get(battle, target);

    if (self === undefined || !hasElemental(self) || !query.available(self)) {
        return {
            state: battle,
            value: { type: "REJECTED", reason: query.damageRejection(battle, target, request)! },
        };
    }

    battle = dispatch(battle, units.ref(self), "received", { request });

    const reason = query.damageRejection(battle, target, request);

    if (reason !== undefined) {
        return { state: battle, value: { type: "REJECTED", reason } };
    }

    self = units.get(battle, target);

    if (self === undefined || !hasElemental(self)) {
        return { state: battle, value: { type: "REJECTED", reason: "TARGET_ABSENT" } };
    }

    const identity: Ref<Unit & Elemental> = units.ref(self);
    const resistance = query.resolveElementResistance(battle, identity)!;
    const reception = receive(battle, identity, request, request.power * (1 - resistance / 100));
    battle = reception.state;

    const rejection = query.damageRejection(battle, target, request);

    if (rejection !== undefined) {
        return { state: battle, value: { type: "REJECTED", reason: rejection } };
    }

    const currentSelf = units.get(battle, identity)!;
    const maximum = query.resolveMaxEp(battle, identity)!;
    const previous = Math.min(maximum, Math.max(0, currentSelf.elemental.ep[request.type]));
    const amount = Math.min(previous, reception.value);

    if (amount === 0) {
        return { state: battle, value: { type: "APPLIED", amount: 0, burst: null } };
    }

    const current = previous - amount;
    const definition = currentSelf.definition.elemental.bursts[request.type];
    const burst: Burst | null =
        current > 0
            ? null
            : {
                  host: identity,
                  id: currentSelf.elemental.nextBurstId,
                  type: request.type,
                  source: request.source,
                  startedAtTick: battle.tick,
                  status: "ACTIVE",
                  remainingTicks: definition.durationTicks,
              };
    const nextBurstId = currentSelf.elemental.nextBurstId + (burst === null ? 0 : 1);
    assertNonnegativeSafeInteger(nextBurstId, "element burst allocation progress");

    const ep =
        burst === null
            ? Object.freeze({ ...normalizedEp(currentSelf, maximum), [request.type]: current })
            : elementValues(0);
    battle = query.replace(battle, {
        ...currentSelf,
        elemental: {
            ...currentSelf.elemental,
            ep,
            burst,
            nextBurstId,
            lastAdvancedTick: burst === null ? currentSelf.elemental.lastAdvancedTick : battle.tick,
        },
    });
    battle = appendEvents(battle, [
        {
            type: "ELEMENT_DAMAGE",
            sourceUnitId: request.source?.id ?? null,
            targetUnitId: currentSelf.id,
            elementType: request.type,
            amount,
            ep: current,
            tick: battle.tick,
        },
    ]);

    if (burst !== null) {
        battle = appendEvents(battle, [{ type: "ELEMENT_BURST", burst, tick: battle.tick }]);
        battle = dispatch(battle, identity, "burstStarted", burst);
    }

    const reference = burst === null ? null : burstRef(burst);
    const event: Damaged = { request, previous, current, amount, burst: reference };
    battle = dispatch(battle, identity, "damaged", event);

    if (reference !== null) {
        const host = units.get(battle, identity);
        const active = query.get(battle, reference);

        if (host !== undefined && query.available(host) && active?.status === "ACTIVE") {
            battle = definition.onStart(battle, active);
        }

        const after = query.get(battle, reference);

        if (after?.status === "ACTIVE" && after.remainingTicks <= 0) {
            battle = finish(battle, reference);
        }
    }

    return { state: battle, value: { type: "APPLIED", amount, burst: reference } };
}

export function heal(
    battle: BattleState,
    target: Ref<Unit>,
    request: HealRequest,
): Result<HealOutcome> {
    assertNonnegativeNumber(request.power, "element heal power");

    const reason = query.healRejection(battle, target, request);

    if (reason !== undefined) {
        return { state: battle, value: { type: "REJECTED", reason } };
    }

    const self = units.get(battle, target);

    if (self === undefined || !hasElemental(self)) {
        return { state: battle, value: { type: "REJECTED", reason: "TARGET_ABSENT" } };
    }

    const identity = units.ref(self);
    const maximum = query.resolveMaxEp(battle, identity)!;
    const previous = normalizedEp(self, maximum);
    const amounts = { ...elementValues(0) };
    const current = { ...previous };

    for (const type of ELEMENT_TYPES) {
        amounts[type] = Math.min(request.power, Math.max(0, maximum - previous[type]));
        current[type] += amounts[type];
    }

    if (!ELEMENT_TYPES.some((type) => amounts[type] > 0)) {
        return { state: battle, value: { type: "APPLIED", amounts } };
    }

    const event: Healed = {
        request,
        previous,
        current: Object.freeze(current),
        amounts: Object.freeze(amounts),
    };
    battle = query.replace(battle, {
        ...self,
        elemental: { ...self.elemental, ep: event.current },
    });
    battle = appendEvents(battle, [
        {
            type: "ELEMENT_HEAL",
            sourceUnitId: request.source?.id ?? null,
            targetUnitId: self.id,
            amounts: event.amounts,
            tick: battle.tick,
        },
    ]);
    battle = dispatch(battle, identity, "healed", event);

    return { state: battle, value: { type: "APPLIED", amounts: event.amounts } };
}

export function finish(battle: BattleState, reference: Ref<Burst>): BattleState {
    return end(battle, reference, { type: "FINISHED" });
}

export function cancel(
    battle: BattleState,
    reference: Ref<Burst>,
    reason = "CANCELLED",
): BattleState {
    return end(battle, reference, { type: "CANCELLED", reason });
}

function end(battle: BattleState, reference: Ref<Burst>, ending: End): BattleState {
    const self = units.get(battle, reference.host);
    const active = self?.elemental.burst;

    if (self === undefined || active?.id !== reference.id || active.status !== "ACTIVE") {
        return battle;
    }

    const definition = self.definition.elemental.bursts[active.type];
    const closing: Burst = { ...active, status: "ENDING" };
    battle = query.replace(battle, { ...self, elemental: { ...self.elemental, burst: closing } });
    battle = closeLifetime(
        battle,
        { type: "ELEMENTAL_BURST", ref: reference },
        ending.type === "CANCELLED" ? ending.reason : "ELEMENTAL_BURST_FINISHED",
    );

    const current = query.get(battle, reference);
    const finished = current ?? closing;

    if (definition.onEnd !== undefined) {
        battle = definition.onEnd(battle, finished, ending);
    }

    const host = units.get(battle, reference.host);

    if (host?.elemental.burst?.id === reference.id) {
        const maximum = query.resolveMaxEp(battle, reference.host)!;
        battle = query.replace(battle, {
            ...host,
            elemental: {
                ...host.elemental,
                ep: elementValues(maximum),
                burst: null,
                lastAdvancedTick: battle.tick,
            },
        });
    }

    battle = appendEvents(battle, [
        { type: "ELEMENT_BURST_ENDED", burst: finished, end: ending, tick: battle.tick },
    ]);

    if (ending.type === "FINISHED") {
        battle = appendEvents(battle, [
            {
                type: "ELEMENT_RECOVERED",
                unitId: reference.host.id,
                elementType: active.type,
                tick: battle.tick,
            },
        ]);
    }

    return dispatch(battle, reference.host, "burstEnded", { burst: finished, end: ending });
}

export function advance(battle: BattleState, host: Ref<Unit & Elemental>): BattleState {
    const self = units.get(battle, host);

    if (self?.lifecycle !== "PRESENT") {
        return battle;
    }
    if (battle.tick < self.elemental.lastAdvancedTick) {
        throw new RangeError("elemental cannot advance to an earlier tick");
    }

    const elapsed = battle.tick - self.elemental.lastAdvancedTick;
    const state = self.elemental;
    const next = { ...state, lastAdvancedTick: battle.tick };

    if (query.available(self) && state.burst?.status === "ACTIVE") {
        const rate = query.resolveBurstRecoverySpeed(battle, host)!;
        next.burst = {
            ...state.burst,
            remainingTicks: Math.max(0, state.burst.remainingTicks - rate * elapsed),
        };
    } else if (query.available(self) && state.burst === null) {
        const power = (query.resolveRecoverySpeed(battle, host)! * elapsed) / TICKS_PER_SECOND;
        const maximum = query.resolveMaxEp(battle, host)!;
        const ep = { ...normalizedEp(self, maximum) };
        const request: HealRequest = { source: null, power };

        if (query.canReceiveHeal(battle, host, request)) {
            for (const type of ELEMENT_TYPES) {
                ep[type] = Math.min(maximum, ep[type] + power);
            }
        }

        next.ep = Object.freeze(ep);
    }

    battle = query.replace(battle, { ...self, elemental: next });

    return next.burst?.status === "ACTIVE" && next.burst.remainingTicks <= 0
        ? finish(battle, burstRef(next.burst))
        : battle;
}

function normalizedEp(self: Unit & Elemental, maximum: number): Values {
    return Object.freeze({
        NEURAL: Math.min(maximum, Math.max(0, self.elemental.ep.NEURAL)),
        EROSION: Math.min(maximum, Math.max(0, self.elemental.ep.EROSION)),
        BURN: Math.min(maximum, Math.max(0, self.elemental.ep.BURN)),
        NECROSIS: Math.min(maximum, Math.max(0, self.elemental.ep.NECROSIS)),
    });
}
