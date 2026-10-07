import type { BattlefieldChangeResult } from "../battlefield/contract.js";
import type { BattleEvent } from "./contract.js";
import { copyUnitSnapshot } from "../unit/snapshot.js";

export function battlefieldCommitEvents(
    committed: BattlefieldChangeResult,
    tick: number,
): BattleEvent[] {
    return committed.lostSupports.map((relation) => ({
        type: "SUPPORT_LOST",
        ...relation,
        tick,
    }));
}

export function finishBattleEvents(
    phaseEvents: readonly BattleEvent[],
    removedUnits: BattlefieldChangeResult["removedUnits"],
    tick: number,
) {
    const events: BattleEvent[] = [
        ...phaseEvents,
        ...removedUnits.map((removed): BattleEvent => ({
            type: "UNIT_REMOVED",
            ...removed,
            unit: copyUnitSnapshot(removed.unit),
            tick,
        })),
    ];

    return {
        events,
        completedRouteCount: events.filter((event) => event.type === "ROUTE_COMPLETED").length,
    };
}
