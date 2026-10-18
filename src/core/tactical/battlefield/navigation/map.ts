import { assertPositiveSafeInteger } from "../../../common/assert.js";
import type { TilePosition } from "../../geometry/coordinate.js";
import { DIRECTIONS, type Direction } from "../../geometry/direction.js";

export interface Cell {
    readonly passable: boolean;
    readonly cost: number;
    readonly departures: Readonly<Record<Direction, boolean>>;
}

export class Map {
    readonly rows: number;
    readonly columns: number;
    readonly cells: readonly Cell[];

    constructor(rows: number, columns: number, cells: readonly Cell[]) {
        assertPositiveSafeInteger(rows, "navigation row count");
        assertPositiveSafeInteger(columns, "navigation column count");
        assertPositiveSafeInteger(rows * columns, "navigation cell count");

        if (cells.length !== rows * columns) {
            throw new RangeError("navigation cells must match map dimensions");
        }

        const copied: Cell[] = [];

        for (let index = 0; index < cells.length; index++) {
            if (!Object.hasOwn(cells, index)) {
                throw new RangeError(`missing navigation cell at index ${index}`);
            }

            const cell = cells[index]!;

            assertPositiveSafeInteger(cell.cost, `navigation cost at index ${index}`);
            copied.push(
                Object.freeze({
                    passable: cell.passable,
                    cost: cell.cost,
                    departures: Object.freeze({
                        UP: cell.departures.UP,
                        RIGHT: cell.departures.RIGHT,
                        DOWN: cell.departures.DOWN,
                        LEFT: cell.departures.LEFT,
                    }),
                }),
            );
        }

        this.rows = rows;
        this.columns = columns;
        this.cells = Object.freeze(copied);
        Object.freeze(this);
    }

    contains(position: TilePosition): boolean {
        const [row, col] = position;

        return row >= 0 && row < this.rows && col >= 0 && col < this.columns;
    }

    get(position: TilePosition): Cell | undefined {
        return this.contains(position)
            ? this.cells[position[0] * this.columns + position[1]]
            : undefined;
    }

    equals(other: Map): boolean {
        return (
            this === other ||
            (this.rows === other.rows &&
                this.columns === other.columns &&
                this.cells.every((cell, index) => {
                    const compared = other.cells[index]!;

                    return (
                        cell.passable === compared.passable &&
                        cell.cost === compared.cost &&
                        DIRECTIONS.every(
                            (direction) =>
                                cell.departures[direction] === compared.departures[direction],
                        )
                    );
                }))
        );
    }
}
