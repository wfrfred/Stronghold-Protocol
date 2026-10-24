import type { BuildableType, HeightType } from "../../../battlefield/map/tile.js";
import type { Unit, Definition as UnitDefinition } from "../../unit.js";
import type { State as BattleState, Result } from "../../../battle/state.js";
import type { Ref } from "../../../../common/ref.js";
import type { TilePosition } from "../../../geometry/coordinate.js";
import type { Occupancy } from "../occupancy/capability.js";

export interface SupportLost {
    readonly tile: TilePosition;
    readonly occupant: Ref<Unit & Occupancy>;
}

export interface Definition {
    readonly heightType: HeightType | null;
    readonly buildableType: BuildableType;
    readonly advancedBuildableMask: number | null;
    readonly onSupportLost?: (
        battle: BattleState,
        self: Unit & Occupancy & TileBinding,
        loss: SupportLost,
    ) => BattleState;
}

export type State = Readonly<Record<string, never>>;

export interface TileBinding {
    readonly definition: { readonly tileBinding: Definition };
    readonly tileBinding: State;
}

export function hasTileBinding<U extends Unit>(unit: U): unit is U & TileBinding {
    return "tileBinding" in unit && hasDefinition(unit.definition);
}

export const initialize: (battle: BattleState, definition: Definition) => Result<State> = (
    battle,
) => {
    return { state: battle, value: {} };
};

export function hasDefinition(
    definition: UnitDefinition,
): definition is UnitDefinition & TileBinding["definition"] {
    return "tileBinding" in definition;
}

export function createDefinition(
    definition: Omit<Definition, "advancedBuildableMask"> & {
        readonly advancedBuildableMask?: number | null;
    },
): Definition {
    const advancedBuildableMask = definition.advancedBuildableMask ?? null;

    if (
        advancedBuildableMask !== null &&
        (!Number.isInteger(advancedBuildableMask) ||
            advancedBuildableMask < 0 ||
            advancedBuildableMask > 0xffff_ffff)
    ) {
        throw new RangeError("advanced buildable mask must be a uint32");
    }

    return Object.freeze({
        ...definition,
        advancedBuildableMask,
    });
}
