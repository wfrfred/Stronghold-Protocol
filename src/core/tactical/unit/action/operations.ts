import type { Ref } from "../../../common/ref.js";
import { updateUnit, type State as BattleState, type Result } from "../../battle/state.js";
import * as units from "../query.js";
import type { Unit } from "../unit.js";
import { hasAction, type Action as ActionCapability } from "../capability/action/capability.js";
import { isSpatiallyPresent } from "../capability/presence/capability.js";
import { hasVitality } from "../capability/vitality/capability.js";
import { resolveInterval } from "../capability/action/timing.js";
import { ref, type Action, type View } from "./action.js";
import type { Definition, Id as DefinitionId } from "./definition.js";
import type { State } from "./state.js";
import * as cooldown from "./cooldown.js";
import { advance } from "./advance.js";
import { end } from "./internal/end.js";
import { read } from "./internal/read.js";

export type StartOutcome<P extends object, E extends object> =
    | { readonly type: "STARTED"; readonly ref: Ref<Action<P, E>> }
    | {
          readonly type: "REJECTED";
          readonly reason: "SOURCE_UNAVAILABLE" | "RULE" | "COOLDOWN" | "CASTING" | "CONDITION";
      };

export function all(battle: BattleState): readonly Ref<View>[] {
    return [
        ...units
            .all(battle)
            .filter(hasAction)
            .flatMap((host) => host.action.instances.values().map(ref)),
    ];
}

export function forUnit(battle: BattleState, source: Ref<Unit>): readonly Ref<View>[] {
    const unit = units.get(battle, source);

    return unit !== undefined && hasAction(unit)
        ? unit.action.instances.values().map(ref).toArray()
        : [];
}

export function get<A extends View>(battle: BattleState, reference: Ref<A>): A | undefined {
    return units.get(battle, reference.host)?.action.instances.get(reference);
}

export function isCasting(
    battle: BattleState,
    source: Ref<Unit>,
    definitionId?: DefinitionId,
): boolean {
    const unit = units.get(battle, source);

    return (
        unit !== undefined &&
        hasAction(unit) &&
        unit.action.instances
            .values()
            .some((self) => definitionId === undefined || self.definition.id === definitionId)
    );
}

export function getState<P extends object, E extends object>(
    battle: BattleState,
    source: Ref<Unit & ActionCapability>,
    definition: Definition<P, E>,
): State<P, E> | undefined {
    return units.get(battle, source)?.action.states.get(definition.id, definition);
}

export function replaceState<P extends object, E extends object>(
    battle: BattleState,
    source: Ref<Unit & ActionCapability>,
    self: State<P, E>,
): BattleState {
    const unit = units.get(battle, source);
    const current = unit?.action.states.get(self.definition.id);

    if (unit === undefined || current?.definition !== self.definition || current === self) {
        return battle;
    }

    const states = unit.action.states.replace(self.definition, self);

    return updateUnit(battle, { ...unit, action: { ...unit.action, states } });
}

export function start<P extends object, E extends object>(
    battle: BattleState,
    source: Ref<Unit & ActionCapability>,
    definition: Definition<P, E>,
): Result<StartOutcome<P, E>> {
    const unit = units.get(battle, source);
    const reject = (
        reason: Extract<StartOutcome<P, E>, { type: "REJECTED" }>["reason"],
    ): Result<StartOutcome<P, E>> => ({ state: battle, value: { type: "REJECTED", reason } });

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
    const current = getState(battle, source, definition)!;
    const resized = cooldown.resizeKeepingProgress(current.cooldown, period, battle.tick);

    if (cooldown.remaining(resized, battle.tick) > 0) {
        return reject("COOLDOWN");
    }

    const initialized = definition.start(battle, source, current);
    battle = initialized.state;

    if (initialized.value === null) {
        return reject("CONDITION");
    }

    const latest = units.get(battle, source);

    if (
        latest?.lifecycle !== "PRESENT" ||
        !isSpatiallyPresent(latest) ||
        (hasVitality(latest) && latest.vitality.hp <= 0)
    ) {
        return reject("SOURCE_UNAVAILABLE");
    }
    if (isCasting(battle, source, definition.id)) {
        return reject("CASTING");
    }
    if (!latest.action.rules.every((rule) => rule.allows(battle, latest, definition.id))) {
        return reject("RULE");
    }

    const latestPeriod = resolveInterval(battle, source, definition)!;
    const latestState = getState(battle, source, definition)!;
    const acceptedCooldown = cooldown.resizeKeepingProgress(
        latestState.cooldown,
        latestPeriod,
        battle.tick,
    );

    if (cooldown.remaining(acceptedCooldown, battle.tick) > 0) {
        return reject("COOLDOWN");
    }

    const self: Action<P, E> = {
        id: latest.action.instances.nextId,
        host: source,
        definition,
        startedAtTick: battle.tick,
        status: "RUNNING",
        state: initialized.value,
    };
    const states = latest.action.states.replace(definition, {
        ...latestState,
        cooldown: cooldown.reset(acceptedCooldown, battle.tick),
    });
    battle = updateUnit(battle, {
        ...latest,
        action: { ...latest.action, states, instances: latest.action.instances.add(self) },
    });
    const reference = ref(self);

    return { state: advance(battle, reference), value: { type: "STARTED", ref: reference } };
}

export function update<P extends object, E extends object>(
    battle: BattleState,
    reference: Ref<Action<P, E>>,
    transform: (current: NoInfer<E>) => NoInfer<E>,
): BattleState {
    const unit = units.get(battle, reference.host);
    const current = unit?.action.instances.get(reference);

    if (unit === undefined || current === undefined || current.status === "ENDING") {
        return battle;
    }

    const state = transform(current.state);

    if (state === current.state) {
        return battle;
    }

    return updateUnit(battle, {
        ...unit,
        action: {
            ...unit.action,
            instances: unit.action.instances.replace(reference, { ...current, state }),
        },
    });
}

export function cancel(
    battle: BattleState,
    reference: Ref<View>,
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

    let states = unit.action.states;

    for (const definition of unit.definition.action.definitions.values()) {
        const period = resolveInterval(battle, source, definition)!;
        states =
            states.read(definition.id, (previous) => {
                const next = cooldown.resizeKeepingProgress(previous.cooldown, period, battle.tick);

                return next === previous.cooldown
                    ? states
                    : states.replace(previous.definition, { ...previous, cooldown: next });
            }) ?? states;
    }

    return states === unit.action.states
        ? battle
        : updateUnit(battle, { ...unit, action: { ...unit.action, states } });
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

    return (
        read(battle, source, definitionId, (current) => {
            const next = change(current.cooldown, battle.tick);

            return current.cooldown === next
                ? battle
                : replaceState(battle, source, { ...current, cooldown: next });
        }) ?? battle
    );
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
