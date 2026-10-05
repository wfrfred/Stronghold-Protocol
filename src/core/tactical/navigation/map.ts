import type { Direction } from "../geometry/direction.js";

export type PathMotionMode =
    | "WALK"
    | "FLY";

export type NavigationRevision = number;

export interface NavigationCell {
    readonly passable: boolean;
    readonly searchAllowed: boolean;
    readonly moveCost: number;
    readonly departures: Readonly<Record<Direction, boolean>>;
}

export interface NavigationMap {
    readonly rows: number;
    readonly columns: number;
    readonly pathMotionMode: PathMotionMode;
    readonly revision: NavigationRevision;
    readonly cells: readonly NavigationCell[];
}
