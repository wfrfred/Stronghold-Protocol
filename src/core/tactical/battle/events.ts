import type { BattlefieldChangeResult } from "../battlefield/contract.js";
import type { Event } from "./contract.js";
import { copyUnitSnapshot } from "../unit/snapshot.js";

export function battlefieldCommitEvents(committed: BattlefieldChangeResult, tick: number): Event[] {
    return committed.lostSupports.map((relation) => ({
        type: "SUPPORT_LOST",
        ...relation,
        tick,
    }));
}

export function finishBattleEvents(
    phaseEvents: readonly Event[],
    removedUnits: BattlefieldChangeResult["removedUnits"],
    tick: number,
) {
    const events: Event[] = [
        ...phaseEvents,
        ...removedUnits.map((removed): Event => ({
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
