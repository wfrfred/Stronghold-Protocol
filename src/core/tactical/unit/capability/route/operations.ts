import { assertNonnegativeSafeInteger } from "../../../../common/assert.js";
import type { Ref } from "../../../../common/ref.js";
import { appendEvents, updateUnit, type State as BattleState } from "../../../battle/state.js";
import * as navigation from "../../../battlefield/navigation/state.js";
import { Tile, World, type WorldPosition } from "../../../geometry/coordinate.js";
import * as units from "../../query.js";
import type { Unit } from "../../unit.js";
import * as presence from "../presence/operations.js";
import { hasSpatialPresence } from "../presence/capability.js";
import type { MovementTarget } from "../locomotion/capability.js";
import {
    initialize,
    type Definition,
    type Phase,
    type Progress,
    type Route,
    type State,
} from "./capability.js";

const RADIUS = 0.05;
const TRANSITION_BUDGET = 128;

export type Signal =
    | { readonly type: "DISAPPEAR" }
    | { readonly type: "APPEAR_AT_POS"; readonly position: WorldPosition }
    | { readonly type: "ALERT" };

export function isCompleted(state: State): boolean {
    return state.main.phase.type === "COMPLETED";
}

export function pathMotionMode(state: State): navigation.MotionMode {
    return (state.alternative ?? state.main).pathMotionMode;
}

export function setPathMotionMode(
    battle: BattleState,
    ref: Ref<Unit & Route>,
    mode: navigation.MotionMode,
): BattleState {
    const self = units.get(battle, ref);

    if (self?.lifecycle !== "PRESENT") {
        return battle;
    }

    const slot = self.route.alternative === null ? "main" : "alternative";
    const progress = self.route[slot]!;

    return progress.pathMotionMode === mode
        ? battle
        : updateUnit(battle, {
              ...self,
              route: { ...self.route, [slot]: { ...progress, pathMotionMode: mode } },
          });
}

export function setAlternative(
    battle: BattleState,
    ref: Ref<Unit & Route>,
    definition: Definition,
): BattleState {
    const self = units.get(battle, ref);

    if (self?.lifecycle !== "PRESENT") {
        return battle;
    }

    const initialized = initialize(battle, definition);

    return updateUnit(initialized.state, {
        ...self,
        route: { ...self.route, alternative: initialized.value.main },
    });
}

export function clearAlternative(battle: BattleState, ref: Ref<Unit & Route>): BattleState {
    const self = units.get(battle, ref);

    return self?.lifecycle !== "PRESENT" || self.route.alternative === null
        ? battle
        : updateUnit(battle, { ...self, route: { ...self.route, alternative: null } });
}

function target(progress: Progress): WorldPosition | null {
    const phase = progress.phase;

    if (phase.type === "END") {
        return Tile.center(progress.definition.endPosition);
    }
    if (phase.type !== "CHECKPOINT" || phase.checkpointState.type !== "MOVING") {
        return null;
    }

    const checkpoint = progress.definition.checkpoints[phase.index]!;

    return checkpoint.type === "MOVE"
        ? World.translate(Tile.center(checkpoint.position), checkpoint.offset)
        : null;
}

function recoveryPoint(battle: BattleState, self: Unit, progress: Progress): WorldPosition | null {
    const definition = progress.definition;
    const map = battle.battlefield.navigation.baseline[progress.pathMotionMode];
    const locator = World.translate(self.position, World.negate(definition.offset));

    if (map.contains(World.toTile(self.position)) && map.contains(World.toTile(locator))) {
        return null;
    }

    const margin = Number.EPSILON * Math.max(map.rows, map.columns);
    const minimum = [-0.5 + margin, -0.5 + margin] as const;
    const maximum = [map.columns - 0.5 - margin, map.rows - 0.5 - margin] as const;
    const minX = Math.max(minimum[0], minimum[0] + definition.offset[0]);
    const maxX = Math.min(maximum[0], maximum[0] + definition.offset[0]);
    const minY = Math.max(minimum[1], minimum[1] + definition.offset[1]);
    const maxY = Math.min(maximum[1], maximum[1] + definition.offset[1]);

    return minX > maxX || minY > maxY
        ? null
        : [
              Math.max(minX, Math.min(maxX, self.position[0])),
              Math.max(minY, Math.min(maxY, self.position[1])),
          ];
}

export function movementTarget(battle: BattleState, ref: Ref<Unit & Route>): MovementTarget | null {
    const self = units.get(battle, ref);

    if (self?.lifecycle !== "PRESENT") {
        return null;
    }

    const progress = self.route.alternative ?? self.route.main;
    const goal = target(progress);

    if (goal === null) {
        return null;
    }

    const definition = progress.definition;
    const map = battle.battlefield.navigation.baseline[progress.pathMotionMode];
    const locator = World.translate(self.position, World.negate(definition.offset));

    if (!map.contains(World.toTile(self.position)) || !map.contains(World.toTile(locator))) {
        const recovery = recoveryPoint(battle, self, progress);

        return recovery === null ? null : { nextPoint: recovery, goal: recovery };
    }

    const point = navigation.nextPoint(
        battle.battlefield.navigation,
        progress.pathMotionMode,
        locator,
        goal,
    );

    return point === null
        ? null
        : {
              nextPoint: World.translate(point, definition.offset),
              goal: World.translate(goal, definition.offset),
          };
}

function atEnd(self: Unit, progress: Progress): boolean {
    const phase = progress.phase;

    if (
        phase.type === "COMPLETED" ||
        (phase.type === "CHECKPOINT" && progress.definition.requireAllCheckpoints)
    ) {
        return false;
    }

    return World.withinDistance(
        World.translate(self.position, World.negate(progress.definition.offset)),
        Tile.center(progress.definition.endPosition),
        RADIUS,
    );
}

function replace(
    battle: BattleState,
    self: Unit & Route,
    progress: Progress,
    phase: Phase,
): BattleState {
    const slot = self.route.alternative === progress ? "alternative" : "main";

    return updateUnit(battle, {
        ...self,
        route: { ...self.route, [slot]: { ...progress, phase } },
    });
}

function following(progress: Progress, index: number): Phase {
    return index >= progress.definition.checkpoints.length
        ? { type: "END" }
        : { type: "CHECKPOINT", index, checkpointState: { type: "PENDING" } };
}

export function advance(battle: BattleState, ref: Ref<Unit & Route>): BattleState {
    for (let remaining = TRANSITION_BUDGET; remaining > 0; remaining--) {
        let self = units.get(battle, ref);

        if (self?.lifecycle !== "PRESENT") {
            return battle;
        }
        if (atEnd(self, self.route.main)) {
            battle = replace(battle, self, self.route.main, { type: "COMPLETED" });
            self = units.get(battle, ref);

            if (self?.lifecycle !== "PRESENT") {
                return battle;
            }
        }

        const progress = self.route.alternative ?? self.route.main;
        const phase = progress.phase;

        if (phase.type === "COMPLETED") {
            return battle;
        }
        if (atEnd(self, progress)) {
            return replace(battle, self, progress, { type: "COMPLETED" });
        }
        if (phase.type === "END") {
            return battle;
        }

        const checkpoint = progress.definition.checkpoints[phase.index]!;
        const state = phase.checkpointState;

        if (state.type === "WAITING") {
            if (battle.tick < state.deadlineTick) {
                return battle;
            }

            battle = replace(battle, self, progress, following(progress, phase.index + 1));
        } else if (state.type === "MOVING") {
            const goal = target(progress)!;
            const locator = World.translate(
                self.position,
                World.negate(progress.definition.offset),
            );
            const map = battle.battlefield.navigation.baseline[progress.pathMotionMode];
            const inside =
                map.contains(World.toTile(self.position)) && map.contains(World.toTile(locator));
            const skipped =
                !progress.definition.alwaysCheckCurrentPoint &&
                inside &&
                navigation.nextPoint(
                    battle.battlefield.navigation,
                    progress.pathMotionMode,
                    locator,
                    goal,
                ) === null;

            if (!World.withinDistance(locator, goal, RADIUS) && !skipped) {
                return battle;
            }

            battle = replace(battle, self, progress, following(progress, phase.index + 1));
        } else if (state.type === "CONSUMED") {
            battle = replace(battle, self, progress, following(progress, phase.index + 1));
        } else if (checkpoint.type === "GOTO") {
            battle = replace(battle, self, progress, following(progress, checkpoint.index));
        } else if (checkpoint.type === "MOVE") {
            battle = replace(battle, self, progress, {
                ...phase,
                checkpointState: { type: "MOVING" },
            });
        } else if (checkpoint.type === "WAIT" || checkpoint.type === "WAIT_UNTIL") {
            const deadlineTick = checkpoint.tick + (checkpoint.type === "WAIT" ? battle.tick : 0);
            assertNonnegativeSafeInteger(deadlineTick, "route wait deadline");
            battle = replace(battle, self, progress, {
                ...phase,
                checkpointState: { type: "WAITING", deadlineTick },
            });
        } else {
            battle = replace(battle, self, progress, {
                ...phase,
                checkpointState: { type: "CONSUMED" },
            });
            let signal: Signal;

            if (checkpoint.type === "DISAPPEAR") {
                signal = checkpoint;

                if (hasSpatialPresence(self)) {
                    battle = presence.disappear(battle, units.ref(self));
                }
            } else if (checkpoint.type === "APPEAR_AT_POS") {
                const position = World.translate(
                    Tile.center(checkpoint.position),
                    checkpoint.offset,
                );
                signal = { type: "APPEAR_AT_POS", position };
                battle = hasSpatialPresence(self)
                    ? presence.appear(battle, units.ref(self), position)
                    : updateUnit(battle, { ...units.get(battle, ref)!, position });
            } else {
                signal = checkpoint;
            }

            const current = units.get(battle, ref);
            battle = appendEvents(battle, [
                {
                    type: "ROUTE",
                    unitId: ref.id,
                    signal,
                    position: current?.position ?? self.position,
                    tick: battle.tick,
                },
            ]);
        }
    }

    return battle;
}
