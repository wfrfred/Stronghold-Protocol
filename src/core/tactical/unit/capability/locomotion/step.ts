import { assertNonnegativeNumber } from "../../../../common/assert.js";
import type { Ref } from "../../../../common/ref.js";
import { battlefieldView, updateUnit, type State as BattleState } from "../../../battle/state.js";
import { createWorldOffset, World, type WorldPosition } from "../../../geometry/coordinate.js";
import * as units from "../../query.js";
import type { Unit } from "../../unit.js";
import { isSpatiallyPresent } from "../presence/capability.js";
import { canMove, resolveMoveSpeed, type Locomotion } from "./capability.js";
import { integrateSteeringDirection } from "./steering.js";

export function advance(
    battle: BattleState,
    ref: Ref<Unit & Locomotion>,
    target: WorldPosition | null,
    moveMultiplier = 1,
): BattleState {
    const unit = units.get(battle, ref);

    if (unit?.lifecycle !== "PRESENT") {
        return battle;
    }

    const battlefield = battlefieldView(battle);
    let position = unit.position;
    let steering = unit.locomotion.steering;

    if (target === null) {
        if (steering.lastVelocity[0] !== 0 || steering.lastVelocity[1] !== 0) {
            steering = { lastVelocity: createWorldOffset(0, 0) };
        }
    } else if (
        isSpatiallyPresent(unit) &&
        canMove(battle, unit) &&
        battlefield.blockerOf(unit.id) === undefined
    ) {
        const speed =
            resolveMoveSpeed(unit.definition.locomotion, unit.locomotion, {
                unit,
                battlefield,
            }) * moveMultiplier;

        assertNonnegativeNumber(speed, "movement budget");

        if (speed > 0) {
            const direction = World.difference(target, position);
            const distance = Math.hypot(direction[0], direction[1]);

            if (distance <= speed) {
                position = target;
                steering = { lastVelocity: direction };
            } else {
                const movement = integrateSteeringDirection(
                    steering,
                    position,
                    direction,
                    speed,
                    unit.definition.locomotion.steeringParameters,
                );
                position = movement.position;
                steering = movement.state;
            }
        }
    }

    const moving = position[0] !== unit.position[0] || position[1] !== unit.position[1];

    if (!moving) {
        position = unit.position;
    }
    if (
        steering.lastVelocity[0] === unit.locomotion.steering.lastVelocity[0] &&
        steering.lastVelocity[1] === unit.locomotion.steering.lastVelocity[1]
    ) {
        steering = unit.locomotion.steering;
    }
    if (
        position === unit.position &&
        moving === unit.locomotion.moving &&
        steering === unit.locomotion.steering
    ) {
        return battle;
    }

    return updateUnit(battle, {
        ...unit,
        position,
        locomotion: { ...unit.locomotion, moving, steering },
    });
}
