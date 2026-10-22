import type { Ref } from "../../../../common/ref.js";
import { closeLifetime } from "../../../battle/execution/lifetime.js";
import { appendEvents, updateUnit, type State as BattleState } from "../../../battle/state.js";
import * as units from "../../query.js";
import { ref, type View } from "../action.js";
import type { End } from "../definition.js";

export function end(
    battle: BattleState,
    reference: Ref<View>,
    result: End,
    lifetimeReason = result.type === "FINISHED" ? "ACTION_FINISHED" : result.reason,
): BattleState {
    return (
        units.get(battle, reference.host)?.action.instances.read(reference.id, (self) => {
            if (self.status === "ENDING") {
                return battle;
            }

            const ending = { ...self, status: "ENDING" as const };
            const host = units.get(battle, self.host)!;
            battle = updateUnit(battle, {
                ...host,
                action: {
                    ...host.action,
                    instances: host.action.instances.replace(ref(self), ending),
                },
            });
            battle = closeLifetime(battle, { type: "ACTION", ref: ref(ending) }, lifetimeReason);

            if (self.definition.onEnd !== undefined) {
                battle = self.definition.onEnd(
                    battle,
                    units.get(battle, self.host)?.action.instances.get(self.id, self.definition) ??
                        ending,
                    result,
                );
            }

            const latest = units.get(battle, self.host);

            if (latest !== undefined) {
                battle = updateUnit(battle, {
                    ...latest,
                    action: {
                        ...latest.action,
                        instances: latest.action.instances.remove(self.id),
                    },
                });
            }

            return appendEvents(battle, [
                {
                    executionId: self.id,
                    sourceUnitId: self.host.id,
                    tick: battle.tick,
                    ...(result.type === "FINISHED"
                        ? { type: "ACTION_FINISHED" as const }
                        : { type: "ACTION_CANCELLED" as const, reason: result.reason }),
                },
            ]);
        }) ?? battle
    );
}
