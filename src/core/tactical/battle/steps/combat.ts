import * as actions from "../../unit/action/operations.js";
import { advance as advanceAction } from "../../unit/action/advance.js";
import * as units from "../../unit/query.js";
import { hasAction } from "../../unit/capability/action/capability.js";
import { isSpatiallyPresent } from "../../unit/capability/presence/capability.js";
import { hasVitality } from "../../unit/capability/vitality/capability.js";
import { leave } from "../execution/unit.js";
import type { State as BattleState } from "../state.js";
import type { Command } from "../contract.js";

export function prepare(battle: BattleState, commands: readonly Command[]): BattleState {
    for (const command of commands) {
        if (command.type === "CANCEL_ACTION_EXECUTION") {
            battle = actions.cancel(battle, command.ref, "CANCELLED");
        }
    }

    return battle;
}

export function advance(battle: BattleState): BattleState {
    const candidates = units
        .all(battle)
        .sort((left, right) => left.id - right.id)
        .map((source) => ({ source, instances: actions.forUnit(battle, source) }));

    for (const { source } of candidates) {
        const unit = units.get(battle, source);

        if (unit !== undefined && hasVitality(unit) && unit.vitality.hp <= 0) {
            battle = leave(battle, source.id, "DEATH");
        }
    }

    for (const { source, instances } of candidates) {
        for (const reference of instances) {
            const self = actions.get(battle, reference);

            if (self !== undefined && self.startedAtTick < battle.tick) {
                battle = advanceAction(battle, reference);
            }
        }

        const unit = units.get(battle, source);

        if (
            unit === undefined ||
            !hasAction(unit) ||
            unit.lifecycle !== "PRESENT" ||
            !isSpatiallyPresent(unit)
        ) {
            continue;
        }

        const reference = units.ref(unit);
        battle = actions.refreshCooldowns(battle, reference);
        const current = units.get(battle, reference)!;
        const selected = current.definition.action.select?.(battle, current) ?? {
            state: battle,
            value: current.definition.action.definitions.values().map(({ id }) => id),
        };
        battle = selected.state;

        for (const id of new Set(selected.value)) {
            const latest = units.get(battle, reference);

            if (latest?.lifecycle !== "PRESENT") {
                break;
            }

            const started = latest.definition.action.definitions.read(
                id,
                (definition) => actions.start(battle, reference, definition).state,
            );

            if (started === undefined) {
                throw new RangeError(`unknown selected action definition ${id}`);
            }

            battle = started;
        }
    }

    return battle;
}
