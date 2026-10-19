import {
    hasRoute,
    type Definition as RouteDefinition,
    type Route,
} from "../../unit/capability/route/capability.js";
import * as route from "../../unit/capability/route/operations.js";
import { hasLocomotion, type Locomotion } from "../../unit/capability/locomotion/capability.js";
import * as locomotion from "../../unit/capability/locomotion/step.js";
import { canRecover, canTraverse } from "../../unit/capability/locomotion/segment.js";
import { effectiveMap } from "../../battlefield/navigation/cache.js";
import { World } from "../../geometry/coordinate.js";
import * as units from "../../unit/query.js";
import type { Id, Unit } from "../../unit/unit.js";
import type { Command } from "../contract.js";
import {
    appendEvents,
    battlefieldView,
    getUnit,
    updateUnit,
    type State as BattleState,
} from "../state.js";
import { leave } from "../execution/unit.js";

function advanceLocomotion(
    battle: BattleState,
    unit: Unit & Route & Locomotion,
    moveMultiplier: number,
): BattleState {
    const ref = units.ref(unit);
    const moved = locomotion.advance(battle, ref, route.nextPoint(battle, ref), moveMultiplier);
    const current = units.get(moved, ref)!;

    if (current.position === unit.position) {
        return moved;
    }

    const definition = (unit.route.alternative ?? unit.route.main).definition;
    const map = effectiveMap(battle.battlefield.navigation, definition.pathMotionMode);
    const locator = World.translate(unit.position, World.negate(definition.offset));
    const nextLocator = World.translate(current.position, World.negate(definition.offset));
    const recovering =
        !map.contains(World.toTile(unit.position)) || !map.contains(World.toTile(locator));
    const permitted = recovering ? canRecover : canTraverse;

    if (permitted(map, unit.position, current.position) && permitted(map, locator, nextLocator)) {
        return moved;
    }

    return updateUnit(battle, {
        ...unit,
        locomotion: { ...current.locomotion, moving: false },
    });
}

export type AlternativeRouteCommand =
    | {
          readonly type: "SET_ALTERNATIVE_ROUTE";
          readonly unitId: Id;
          readonly route: RouteDefinition;
      }
    | { readonly type: "CLEAR_ALTERNATIVE_ROUTE"; readonly unitId: Id };

export function advanceRouteCommands(
    battle: BattleState,
    commands: readonly Command[],
): BattleState {
    for (const command of commands) {
        if (
            command.type !== "SET_ALTERNATIVE_ROUTE" &&
            command.type !== "CLEAR_ALTERNATIVE_ROUTE"
        ) {
            continue;
        }

        const unit = getUnit(battle, command.unitId);

        if (unit === undefined) {
            throw new RangeError(`unknown alternative route unit: ${command.unitId}`);
        }
        if (!hasRoute(unit)) {
            throw new RangeError(`unit has no route: ${command.unitId}`);
        }

        battle =
            command.type === "SET_ALTERNATIVE_ROUTE"
                ? route.setAlternative(battle, units.ref(unit), command.route)
                : route.clearAlternative(battle, units.ref(unit));
    }

    return battle;
}

export function advanceMovement(
    battle: BattleState,
    { routeMoveMultiplier }: { readonly routeMoveMultiplier: number },
): BattleState {
    const candidates = units.filter(battle, hasRoute).sort((left, right) => left.id - right.id);

    for (const ref of candidates) {
        battle = route.advance(battle, ref);
        const unit = units.get(battle, ref);

        if (unit?.lifecycle !== "PRESENT") {
            continue;
        }
        if (route.isCompleted(unit.route)) {
            if (battlefieldView(battle).blockerOf(unit.id) === undefined) {
                battle = appendEvents(battle, [
                    {
                        type: "ROUTE_COMPLETED",
                        unitId: unit.id,
                        tick: battle.tick,
                    },
                ]);
                battle = leave(battle, unit.id, "SCRIPT");
            } else if (hasLocomotion(unit)) {
                battle = locomotion.advance(battle, units.ref(unit), null, routeMoveMultiplier);
            }
        } else if (hasLocomotion(unit)) {
            battle = advanceLocomotion(battle, unit, routeMoveMultiplier);
        }
    }

    return battle;
}
