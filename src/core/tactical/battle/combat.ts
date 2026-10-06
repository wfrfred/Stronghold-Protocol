import type { BattlefieldChange } from "../battlefield/runtime.js";
import { damageUnit } from "../combat/damage.js";
import { selectAttackTarget, type CombatTargetingView } from "../combat/targeting.js";
import { hasAction, type Action } from "../unit/capability/action.js";
import { isSpatiallyPresent } from "../unit/capability/presence.js";
import { hasVitality } from "../unit/capability/vitality.js";
import type { Unit, UnitId } from "../unit/unit.js";
import type { BattleEvent } from "./contract.js";
import type { BattlePhase } from "./system.js";

export function createCombatSystem(): { readonly step: BattlePhase } {
    const step: BattlePhase = (input) => {
        const { battlefield, tick } = input;
        const ids = [...battlefield.unitIds].sort((left, right) => left - right);
        const units = new Map(ids.map((id) => [id, battlefield.getUnit(id)!]));
        const changed = new Set<UnitId>();
        const events: BattleEvent[] = [];
        const view: CombatTargetingView = {
            get unitIds() {
                return [...units.keys()];
            },
            getUnit: (id) => units.get(id),
            blockerOf: (id) => battlefield.blockerOf(id),
            blockedBy: (id) => battlefield.blockedBy(id),
        };

        for (const [id, unit] of units) {
            if (hasVitality(unit) && unit.vitality.hp <= 0) {
                units.delete(id);
                changed.add(id);
            }
        }

        for (const id of ids) {
            const unit = units.get(id);

            if (unit === undefined || !hasAction(unit) || !isSpatiallyPresent(unit)) {
                continue;
            }

            const attack = unit.definition.action.attack;
            const target = selectAttackTarget(unit, attack.targeting, view);
            const targetUnitId = target?.id ?? null;
            let acting: Unit & Action = unit;

            if (targetUnitId !== unit.action.targetUnitId) {
                acting = { ...unit, action: { ...unit.action, targetUnitId } };
                units.set(id, acting);
                changed.add(id);
            }
            if (
                target === null ||
                tick < acting.action.readyAtTick ||
                tick < acting.action.recoveryUntilTick
            ) {
                continue;
            }

            const attacking: Unit & Action = {
                ...acting,
                action: {
                    ...acting.action,
                    readyAtTick: tick + attack.intervalTicks,
                    recoveryUntilTick: tick + attack.recoveryTicks,
                },
            };
            units.set(id, attacking);
            changed.add(id);
            events.push({
                type: "ATTACK",
                sourceUnitId: id,
                targetUnitId: target.id,
                damageType: attack.damageType,
                tick,
            });

            const damaged = damageUnit(target, attack.power, attack.damageType);

            if (damaged.killed) {
                units.delete(target.id);
                changed.add(target.id);
            } else if (damaged.unit !== target) {
                units.set(target.id, damaged.unit);
                changed.add(target.id);
            }

            events.push({
                type: "DAMAGE",
                sourceUnitId: id,
                targetUnitId: target.id,
                damageType: attack.damageType,
                amount: damaged.amount,
                hp: damaged.unit.vitality.hp,
                tick,
            });
        }

        const changes: BattlefieldChange[] = [...changed]
            .sort((left, right) => left - right)
            .map((unitId): BattlefieldChange => {
                const unit = units.get(unitId);

                return unit === undefined
                    ? { type: "REMOVE_UNIT", unitId, reason: "DEATH" }
                    : { type: "UPDATE_UNIT", unit };
            });

        return { state: undefined, changes, events, execution: input.execution };
    };

    return { step };
}
