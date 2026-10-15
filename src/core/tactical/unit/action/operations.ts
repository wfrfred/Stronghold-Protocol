import type { Ref } from "../../../common/ref.js";
import { updateUnit, type State as BattleState, type Result } from "../../battle/state.js";
import * as units from "../query.js";
import type { Unit } from "../unit.js";
import type { Action as ActionCapability } from "../capability/action/capability.js";
import { isSpatiallyPresent } from "../capability/presence/capability.js";
import { hasVitality } from "../capability/vitality/capability.js";
import { resolveInterval } from "../capability/action/timing.js";
import { ref, type Action } from "./action.js";
import type { Actions } from "./actions.js";
import type { Definition, Id as DefinitionId } from "./definition.js";
import * as cooldown from "./cooldown.js";
import { advance } from "./advance.js";
import { end } from "./internal/end.js";

type StoredAction = ReturnType<Actions["values"]>[number];

export type StartOutcome<S extends object> =
    | { readonly type: "STARTED"; readonly ref: Ref<Action<S>> }
    | {
          readonly type: "REJECTED";
          readonly reason: "SOURCE_UNAVAILABLE" | "RULE" | "COOLDOWN" | "CASTING" | "CONDITION";
      };

export function all(battle: BattleState): Ref<StoredAction>[] {
    return battle.actions.values().map(ref);
}

export function forUnit(battle: BattleState, source: Ref<Unit>): Ref<StoredAction>[] {
    return battle.actions
        .values()
        .filter((self) => self.source.id === source.id)
        .map(ref);
}

export function get<A extends StoredAction>(battle: BattleState, reference: Ref<A>): A | undefined {
    return battle.actions.get(reference.id) as A | undefined;
}

export function isCasting(
    battle: BattleState,
    source: Ref<Unit>,
    definitionId?: DefinitionId,
): boolean {
    return battle.actions
        .values()
        .some(
            (self) =>
                self.source.id === source.id &&
                (definitionId === undefined || self.definition.id === definitionId),
        );
}

export function start<S extends object>(
    battle: BattleState,
    source: Ref<Unit & ActionCapability>,
    definition: Definition<S>,
): Result<StartOutcome<S>> {
    const unit = units.get(battle, source);
    const reject = (
        reason: Extract<StartOutcome<S>, { type: "REJECTED" }>["reason"],
    ): Result<StartOutcome<S>> => ({ state: battle, value: { type: "REJECTED", reason } });

    if (
        unit?.lifecycle !== "PRESENT" ||
        !isSpatiallyPresent(unit) ||
        (hasVitality(unit) && unit.vitality.hp <= 0)
    ) {
        return reject("SOURCE_UNAVAILABLE");
    }
    if (unit.definition.action.definitions.get(definition.id) !== definition) {
        throw new TypeError("action definition is not configured for its source");
    }
    if (isCasting(battle, source, definition.id)) {
        return reject("CASTING");
    }
    if (!unit.action.rules.every((rule) => rule.allows(battle, unit, definition.id))) {
        return reject("RULE");
    }

    const period = resolveInterval(battle, source, definition)!;
    const current = unit.action.cooldowns.get(definition.id);
    const resized =
        current === undefined
            ? cooldown.initialize(period, battle.tick)
            : cooldown.resizeKeepingProgress(current, period, battle.tick);

    if (cooldown.remaining(resized, battle.tick) > 0) {
        return reject("COOLDOWN");
    }

    const initialized = definition.start(battle, source);
    battle = initialized.state;

    if (initialized.value === null) {
        return reject("CONDITION");
    }

    const latest = units.get(battle, source);

    if (latest?.lifecycle !== "PRESENT" || !isSpatiallyPresent(latest)) {
        return reject("SOURCE_UNAVAILABLE");
    }

    const self: Action<S> = {
        id: battle.actions.nextId,
        source,
        definition,
        startedAtTick: battle.tick,
        status: "RUNNING",
        state: initialized.value,
    };
    const cooldowns = new Map(latest.action.cooldowns);
    cooldowns.set(definition.id, cooldown.reset(resized, battle.tick));
    battle = updateUnit(battle, { ...latest, action: { ...latest.action, cooldowns } });
    battle = { ...battle, actions: battle.actions.add(self) };
    const reference = ref(self);

    return { state: advance(battle, reference), value: { type: "STARTED", ref: reference } };
}

export function replace<S extends object>(battle: BattleState, self: Action<S>): BattleState {
    const current = battle.actions.get(self.id);

    if (current === undefined || current.status === "ENDING" || current === self) {
        return battle;
    }
    if (self.status !== current.status) {
        throw new TypeError("action lifecycle is managed by execution");
    }

    return { ...battle, actions: battle.actions.replace(self) };
}

export function cancel(
    battle: BattleState,
    reference: Ref<StoredAction>,
    reason = "CANCELLED",
): BattleState {
    return end(battle, reference, { type: "CANCELLED", reason });
}

export function cancelForUnit(
    battle: BattleState,
    source: Ref<Unit>,
    reason: string,
    lifetimeReason = reason,
): BattleState {
    const candidates = forUnit(battle, source);

    for (const reference of candidates) {
        battle = end(battle, reference, { type: "CANCELLED", reason }, lifetimeReason);
    }

    return battle;
}

export function refreshCooldowns(
    battle: BattleState,
    source: Ref<Unit & ActionCapability>,
): BattleState {
    const unit = units.get(battle, source);

    if (unit === undefined) {
        return battle;
    }

    const cooldowns = new Map(unit.action.cooldowns);
    let changed = false;

    for (const definition of unit.definition.action.definitions.values()) {
        const period = resolveInterval(battle, source, definition)!;
        const previous = cooldowns.get(definition.id);
        const next =
            previous === undefined
                ? cooldown.initialize(period, battle.tick)
                : cooldown.resizeKeepingProgress(previous, period, battle.tick);

        if (next !== previous) {
            cooldowns.set(definition.id, next);
            changed = true;
        }
    }

    return changed
        ? updateUnit(battle, { ...unit, action: { ...unit.action, cooldowns } })
        : battle;
}

function changeCooldown(
    battle: BattleState,
    source: Ref<Unit & ActionCapability>,
    definitionId: DefinitionId,
    change: (state: cooldown.State, tick: number) => cooldown.State,
): BattleState {
    const unit = units.get(battle, source);

    if (unit === undefined) {
        return battle;
    }
    if (unit.definition.action.definitions.get(definitionId) === undefined) {
        throw new RangeError("unknown configured action definition");
    }

    battle = refreshCooldowns(battle, source);
    const current = units.get(battle, source)!;
    const previous = current.action.cooldowns.get(definitionId)!;
    const next = change(previous, battle.tick);

    if (previous === next) {
        return battle;
    }

    const cooldowns = new Map(current.action.cooldowns);
    cooldowns.set(definitionId, next);

    return updateUnit(battle, { ...current, action: { ...current.action, cooldowns } });
}

export function resetCooldown(
    battle: BattleState,
    source: Ref<Unit & ActionCapability>,
    definitionId: DefinitionId,
): BattleState {
    return changeCooldown(battle, source, definitionId, cooldown.reset);
}

export function clearCooldown(
    battle: BattleState,
    source: Ref<Unit & ActionCapability>,
    definitionId: DefinitionId,
): BattleState {
    return changeCooldown(battle, source, definitionId, cooldown.clear);
}
