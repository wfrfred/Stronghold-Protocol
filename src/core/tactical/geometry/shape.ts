import { assertFiniteNumber, assertNonnegativeNumber } from "../../common/assert.js";
import type { WorldPosition } from "./coordinate.js";

export type Shape =
    | {
          readonly type: "CIRCLE";
          readonly offset: WorldPosition;
          readonly radius: number;
      }
    | {
          readonly type: "BOX";
          readonly offset: WorldPosition;
          readonly halfExtents: WorldPosition;
      };

export function validateShape(shape: Shape): void {
    assertFiniteNumber(shape.offset[0], "shape offset x");
    assertFiniteNumber(shape.offset[1], "shape offset y");

    switch (shape.type) {
        case "CIRCLE":
            assertNonnegativeNumber(shape.radius, "circle radius");
            break;

        case "BOX":
            assertNonnegativeNumber(shape.halfExtents[0], "box half width");
            assertNonnegativeNumber(shape.halfExtents[1], "box half height");
            break;
    }
}
