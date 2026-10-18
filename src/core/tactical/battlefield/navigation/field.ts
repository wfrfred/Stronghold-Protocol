import type { TilePosition } from "../../geometry/coordinate.js";

export interface Node {
    readonly distance: number;
    readonly next: TilePosition | null;
}

export interface Field {
    readonly rows: number;
    readonly columns: number;
    readonly target: TilePosition;
    readonly nodes: readonly (Node | null)[];
}
