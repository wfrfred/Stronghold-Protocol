import type { BuildableType } from "../../../battlefield/map/tile.js";
import type { Unit, Definition as UnitDefinition } from "../../unit.js";

export type CardId = number;

export interface Definition {
    readonly buildableType: Exclude<BuildableType, "NONE">;
    readonly advancedBuildableMask: number;
}

export interface State {
    readonly cardId: CardId | null;
}

export interface Deployable {
    readonly definition: { readonly deployable: Definition };
    readonly deployable: State;
}

const initialState: State = { cardId: null };

export function initialize(): State {
    return initialState;
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
    definition: Omit<Definition, "advancedBuildableMask"> & {
        readonly advancedBuildableMask?: number;
    },
): Definition {
    const advancedBuildableMask = definition.advancedBuildableMask ?? 1;

    if (
        !Number.isInteger(advancedBuildableMask) ||
        advancedBuildableMask < 0 ||
        advancedBuildableMask > 0xffff_ffff
    ) {
        throw new RangeError("advanced buildable mask must be a uint32");
    }

    return Object.freeze({
        buildableType: definition.buildableType,
        advancedBuildableMask,
    });
}
