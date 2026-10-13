import type { BuildableType } from "../../../battlefield/map/tile.js";
import type { Unit, Definition as UnitDefinition } from "../../unit.js";
import type { DeployedHook } from "./hook.js";
import {
    assertNonnegativeNumber,
    assertNonnegativeSafeInteger,
} from "../../../../common/assert.js";

export type CardId = number;

export interface Definition {
    readonly cost: number;
    readonly redeployTicks: number;
    readonly slots: number;
    readonly buildableType: Exclude<BuildableType, "NONE">;
    readonly advancedBuildableMask: number;
    readonly refund: {
        readonly rate: number;
        readonly limit: "BASE_COST" | "DEPLOYMENT_COST";
    };
}

export interface State {
    readonly cardId: CardId | null;
    readonly cost: number;
    readonly refundLimit: number;
    readonly refundAllowed: boolean;
    readonly deployedHooks: readonly DeployedHook[];
}

export interface Deployable {
    readonly definition: { readonly deployable: Definition };
    readonly deployable: State;
}

export function initialize(definition: Definition): State {
    return {
        cardId: null,
        cost: definition.cost,
        refundLimit: definition.cost,
        refundAllowed: false,
        deployedHooks: [],
    };
}

export function resolveRefund(definition: Definition, state: State): number {
    return state.refundAllowed
        ? Math.max(0, Math.floor(Math.min(state.cost * definition.refund.rate, state.refundLimit)))
        : 0;
}

export function hasDeployable<U extends Unit>(unit: U): unit is U & Deployable {
    return "deployable" in unit && "deployable" in unit.definition;
}

export function hasDefinition(
    definition: UnitDefinition,
): definition is UnitDefinition & Deployable["definition"] {
    return "deployable" in definition;
}

export function createDefinition(
    definition: Omit<Definition, "advancedBuildableMask" | "refund"> & {
        readonly advancedBuildableMask?: number;
        readonly refund?: Definition["refund"];
    },
): Definition {
    const advancedBuildableMask = definition.advancedBuildableMask ?? 1;
    const refund = definition.refund ?? { rate: 0.5, limit: "BASE_COST" };
    assertNonnegativeNumber(definition.cost, "deployment cost");
    assertNonnegativeSafeInteger(definition.redeployTicks, "redeployment duration");
    assertNonnegativeSafeInteger(definition.slots, "deployment slot usage");
    assertNonnegativeNumber(refund.rate, "retreat refund rate");

    if (
        !Number.isInteger(advancedBuildableMask) ||
        advancedBuildableMask < 0 ||
        advancedBuildableMask > 0xffff_ffff
    ) {
        throw new RangeError("advanced buildable mask must be a uint32");
    }

    return {
        cost: definition.cost,
        redeployTicks: definition.redeployTicks,
        slots: definition.slots,
        buildableType: definition.buildableType,
        advancedBuildableMask,
        refund,
    };
}
