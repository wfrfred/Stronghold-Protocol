import {
    assertNonnegativeNumber,
    assertNonnegativeSafeInteger,
    assertPositiveSafeInteger,
} from "../../../common/assert.js";
import type { BattlefieldRemovalReason } from "../../battlefield/contract.js";
import { hasDeployable, resolveRefund } from "../../unit/capability/deployable/capability.js";
import type { Deployed } from "../../unit/capability/deployable/hook.js";
import type { Unit } from "../../unit/unit.js";
import { battlefieldView, getUnit, type BattleState, type Result } from "../state.js";
import * as card from "./card.js";

export interface Definition {
    readonly initialDp: number;
    readonly maxDp: number;
    readonly dpRecoveryTicks: number | null;
    readonly slotLimit: number | null;
}

export interface Input {
    readonly definition: Definition;
    readonly cards: readonly card.Input[];
}

export interface State {
    readonly definition: Definition;
    readonly cards: readonly card.Card[];
    readonly dp: number;
    readonly nextDpRecoveryAtTick: number | null;
}

const emptyDefinition: Definition = {
    initialDp: 0,
    maxDp: 99,
    dpRecoveryTicks: null,
    slotLimit: null,
};

export function initialize(definition: Definition = emptyDefinition, tick = 0): State {
    assertNonnegativeNumber(definition.initialDp, "initial deployment points");
    assertNonnegativeNumber(definition.maxDp, "deployment point limit");

    if (definition.initialDp > definition.maxDp) {
        throw new RangeError("initial deployment points exceed the limit");
    }
    if (definition.dpRecoveryTicks !== null) {
        assertPositiveSafeInteger(definition.dpRecoveryTicks, "deployment point recovery interval");
    }
    if (definition.slotLimit !== null) {
        assertNonnegativeSafeInteger(definition.slotLimit, "deployment slot limit");
    }

    return {
        definition,
        cards: [],
        dp: definition.initialDp,
        nextDpRecoveryAtTick:
            definition.dpRecoveryTicks !== null && definition.initialDp < definition.maxDp
                ? tick + definition.dpRecoveryTicks
                : null,
    };
}

export function getCard(state: BattleState, id: card.Id): card.Card | undefined {
    return state.deployment.cards.find((current) => current.id === id);
}

export function updateCard(state: BattleState, value: card.Card): BattleState {
    const index = state.deployment.cards.findIndex((current) => current.id === value.id);

    if (index < 0) {
        throw new RangeError(`unknown deployment card ${value.id}`);
    }
    if (state.deployment.cards[index] === value) {
        return state;
    }

    const cards = [...state.deployment.cards];
    cards[index] = value;

    return { ...state, deployment: { ...state.deployment, cards } };
}

export function addCard(state: BattleState, definition: card.Input): Result<card.Id> {
    const id = state.execution.nextCardId;
    assertNonnegativeSafeInteger(id + 1, "deployment card allocation progress");
    const value = card.create(id, definition);

    return {
        state: {
            ...state,
            execution: { ...state.execution, nextCardId: id + 1 },
            deployment: { ...state.deployment, cards: [...state.deployment.cards, value] },
        },
        value: id,
    };
}

export function changeDp(state: State, amount: number, tick: number): State {
    const dp = Math.max(0, Math.min(state.definition.maxDp, state.dp + amount));
    const interval = state.definition.dpRecoveryTicks;
    const nextDpRecoveryAtTick =
        dp >= state.definition.maxDp || interval === null
            ? null
            : (state.nextDpRecoveryAtTick ?? tick + interval);

    return dp === state.dp && nextDpRecoveryAtTick === state.nextDpRecoveryAtTick
        ? state
        : { ...state, dp, nextDpRecoveryAtTick };
}

export function advance(state: BattleState, tick: number): BattleState {
    for (const value of state.deployment.cards) {
        state = updateCard(state, card.advance(value, tick));
    }

    let deployment = state.deployment;
    const next = deployment.nextDpRecoveryAtTick;
    const interval = deployment.definition.dpRecoveryTicks;

    if (next !== null && interval !== null && tick >= next) {
        const count = Math.floor((tick - next) / interval) + 1;
        deployment = changeDp(deployment, count, tick);

        if (deployment.nextDpRecoveryAtTick !== null) {
            deployment = { ...deployment, nextDpRecoveryAtTick: next + count * interval };
        }
    }

    return deployment === state.deployment ? state : { ...state, deployment };
}

export function usedSlots(state: BattleState): number {
    let slots = 0;

    for (const unit of state.battlefield.units.values()) {
        if (hasDeployable(unit)) {
            slots += unit.definition.deployable.slots;
        }
    }

    return slots;
}

export function refundUnit(
    state: BattleState,
    unit: Unit,
    reason: BattlefieldRemovalReason,
    tick: number,
): BattleState {
    if (reason !== "RETREAT" || !hasDeployable(unit)) {
        return state;
    }

    const deployment = changeDp(
        state.deployment,
        resolveRefund(unit.definition.deployable, unit.deployable),
        tick,
    );

    return deployment === state.deployment ? state : { ...state, deployment };
}

export function recycleUnitCard(
    state: BattleState,
    unit: Unit,
    reason: BattlefieldRemovalReason,
    tick: number,
): BattleState {
    if (!hasDeployable(unit) || unit.deployable.cardId === null) {
        return state;
    }

    const value = getCard(state, unit.deployable.cardId);

    if (value === undefined) {
        throw new RangeError(`unknown deployment card ${unit.deployable.cardId}`);
    }

    return updateCard(state, card.advance(card.recycle(value, tick, reason), tick));
}

export function notifyDeployed(state: BattleState, deployed: Deployed): BattleState {
    const candidates = [...state.battlefield.units.values()].flatMap((unit) =>
        hasDeployable(unit)
            ? unit.deployable.deployedHooks.map(({ id }) => ({ unitId: unit.id, id }))
            : [],
    );

    for (const { unitId, id } of candidates) {
        const unit = getUnit(state, unitId);

        if (unit?.lifecycle !== "PRESENT" || !hasDeployable(unit)) {
            continue;
        }

        const entry = unit.deployable.deployedHooks.find((current) => current.id === id);
        const view = battlefieldView(state);

        if (entry?.enabled(view)) {
            state = entry.invoke(state, view, deployed).state;
        }
    }

    return state;
}
