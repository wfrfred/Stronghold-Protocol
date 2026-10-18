import { assertNonnegativeSafeInteger } from "../../../common/assert.js";
import type { BattlefieldRemovalReason } from "../../battlefield/contract.js";
import type { Deployable } from "../../unit/capability/deployable/capability.js";
import type { Occupancy } from "../../unit/capability/occupancy/capability.js";
import * as contribution from "../../unit/contribution/contribution.js";
import * as attribute from "../../unit/contribution/attribute.js";
import type { Definition as UnitDefinition } from "../../unit/unit.js";

export type Id = number;

export interface Supply {
    readonly stockLimit: number | null;
    readonly activeLimit: number | null;
    readonly recharge: "DEPLOYMENT" | "RETURN" | "QUEUED";
    readonly costPenalty: boolean;
}

export interface Input {
    readonly unit: UnitDefinition & Deployable["definition"] & Occupancy["definition"];
    readonly supply?: Supply;
}

export interface Definition extends Input {
    readonly supply: Supply;
}

export interface Cooldown {
    readonly readyAtTick: number;
    readonly durationTicks: number;
}

export interface Card {
    readonly id: Id;
    readonly definition: Definition;
    readonly stock: number | null;
    readonly cooldown: Cooldown | null;
    readonly pendingReturns: number;
    readonly costStage: number;
    readonly costContributions: readonly contribution.Contribution<readonly attribute.Modifier[]>[];
    readonly redeployContributions: readonly contribution.Contribution<
        readonly attribute.Modifier[]
    >[];
}

export const operatorSupply: Supply = {
    stockLimit: null,
    activeLimit: 1,
    recharge: "RETURN",
    costPenalty: true,
};

export function create(
    id: Id,
    definition: Input,
    stock: number | null = definition.supply?.stockLimit ?? null,
): Card {
    assertNonnegativeSafeInteger(id, "card identity");

    const supply = definition.supply ?? operatorSupply;

    if (supply.stockLimit !== null) {
        assertNonnegativeSafeInteger(supply.stockLimit, "card stock limit");
    }
    if (supply.activeLimit !== null) {
        assertNonnegativeSafeInteger(supply.activeLimit, "card active limit");
    }
    if (stock !== null) {
        assertNonnegativeSafeInteger(stock, "card stock");
    }
    if (
        (supply.stockLimit !== null && (stock === null || stock > supply.stockLimit)) ||
        (supply.recharge === "QUEUED" && stock === null)
    ) {
        throw new RangeError("card stock does not match its supply");
    }

    return {
        id,
        definition: {
            unit: definition.unit,
            supply,
        },
        stock,
        cooldown: null,
        pendingReturns: 0,
        costStage: 0,
        costContributions: [],
        redeployContributions: [],
    };
}

export function resolveBaseCost(card: Card): number {
    const addition = contribution
        .resolve(card.costContributions)
        .flat()
        .reduce((sum, value) => sum + value.addition, 0);

    return Math.max(0, Math.floor(card.definition.unit.deployable.cost + addition));
}

export function resolveCost(card: Card): number {
    const penalty: attribute.Modifier = {
        addition: 0,
        multiplier: 0.5 * card.costStage,
        finalAddition: 0,
        finalScaler: 1,
    };

    return Math.max(
        0,
        Math.floor(
            attribute.apply(card.definition.unit.deployable.cost, [
                ...contribution.resolve(card.costContributions).flat(),
                penalty,
            ]),
        ),
    );
}

export function resolveRedeployTicks(card: Card): number {
    return Math.max(
        0,
        Math.ceil(
            attribute.apply(
                card.definition.unit.deployable.redeployTicks,
                contribution.resolve(card.redeployContributions).flat(),
            ),
        ),
    );
}

function startCooldown(card: Card, tick: number): Cooldown {
    const durationTicks = resolveRedeployTicks(card);

    return { readyAtTick: tick + durationTicks, durationTicks };
}

export function consume(card: Card, tick: number): Card {
    if (card.stock === 0) {
        throw new RangeError("card has no available stock");
    }

    return {
        ...card,
        stock: card.stock === null ? null : card.stock - 1,
        cooldown:
            card.definition.supply.recharge === "DEPLOYMENT"
                ? startCooldown(card, tick)
                : card.cooldown,
    };
}

export function recycle(card: Card, tick: number, reason: BattlefieldRemovalReason | "MOVE"): Card {
    const costStage =
        card.definition.supply.costPenalty && (reason === "RETREAT" || reason === "DEATH")
            ? Math.min(2, card.costStage + 1)
            : card.costStage;

    switch (card.definition.supply.recharge) {
        case "DEPLOYMENT":
            return costStage === card.costStage ? card : { ...card, costStage };

        case "RETURN":
            return { ...card, costStage, cooldown: startCooldown(card, tick) };

        case "QUEUED":
            return {
                ...card,
                costStage,
                pendingReturns: card.pendingReturns + 1,
                cooldown: card.cooldown ?? startCooldown(card, tick),
            };
    }
}

export function advance(card: Card, tick: number): Card {
    if (card.cooldown === null || tick < card.cooldown.readyAtTick) {
        return card;
    }

    switch (card.definition.supply.recharge) {
        case "DEPLOYMENT":
            return { ...card, cooldown: null };

        case "RETURN":
            return recharge({ ...card, cooldown: null }, 1);

        case "QUEUED": {
            while (card.cooldown !== null && tick >= card.cooldown.readyAtTick) {
                const pendingReturns = card.pendingReturns - 1;
                const finishedAtTick = card.cooldown.readyAtTick;

                card = recharge({ ...card, pendingReturns, cooldown: null }, 1);

                if (pendingReturns > 0) {
                    card = { ...card, cooldown: startCooldown(card, finishedAtTick) };
                }
            }

            return card;
        }
    }
}

export function recharge(card: Card, count: number): Card {
    assertNonnegativeSafeInteger(count, "card recharge count");

    if (card.stock === null || count === 0) {
        return card;
    }

    const stock = Math.min(card.definition.supply.stockLimit ?? Infinity, card.stock + count);

    return stock === card.stock ? card : { ...card, stock };
}

export function reduceCooldown(card: Card, ticks: number, tick: number): Card {
    assertNonnegativeSafeInteger(ticks, "cooldown reduction ticks");

    if (card.cooldown === null || ticks === 0 || card.cooldown.readyAtTick <= tick) {
        return card;
    }

    return {
        ...card,
        cooldown: {
            ...card.cooldown,
            readyAtTick: Math.max(tick, card.cooldown.readyAtTick - ticks),
        },
    };
}

export function setCostContribution(
    card: Card,
    entry: contribution.Contribution<readonly attribute.Modifier[]>,
): Card {
    const costContributions = contribution.set(card.costContributions, entry);

    return costContributions === card.costContributions ? card : { ...card, costContributions };
}

export function removeCostContribution(card: Card, id: string): Card {
    const costContributions = contribution.remove(card.costContributions, id);

    return costContributions === card.costContributions ? card : { ...card, costContributions };
}

export function setRedeployContribution(
    card: Card,
    entry: contribution.Contribution<readonly attribute.Modifier[]>,
): Card {
    const redeployContributions = contribution.set(card.redeployContributions, entry);

    return redeployContributions === card.redeployContributions
        ? card
        : { ...card, redeployContributions };
}

export function removeRedeployContribution(card: Card, id: string): Card {
    const redeployContributions = contribution.remove(card.redeployContributions, id);

    return redeployContributions === card.redeployContributions
        ? card
        : { ...card, redeployContributions };
}
