import { assertFiniteNumber } from "../../../../common/assert.js";
import type { EffectValue } from "./effect.js";
import type { EffectLifecycleResources } from "./lifecycle-resources.js";

export function selectParticipatingEffects(
    instances: readonly EffectValue[],
    resources: Pick<EffectLifecycleResources, "get">,
): ReadonlySet<number> {
    const selected = new Set<number>();
    const groups = new Map<string, { priority: number; instance: EffectValue }>();

    for (const instance of instances) {
        if (!instance.started || instance.finished) {
            continue;
        }

        const competition = resources.get(instance).competition?.(instance);

        if (competition === undefined) {
            if (instance.enabled) {
                selected.add(instance.id);
            }

            continue;
        }

        if (competition.group.length === 0) {
            throw new TypeError("effect competition group must be nonempty");
        }

        assertFiniteNumber(competition.priority, "effect competition priority");
        const previous = groups.get(competition.group);

        if (
            previous === undefined ||
            competition.priority > previous.priority ||
            (competition.priority === previous.priority &&
                (instance.acquiredSequence < previous.instance.acquiredSequence ||
                    (instance.acquiredSequence === previous.instance.acquiredSequence &&
                        instance.id < previous.instance.id)))
        ) {
            groups.set(competition.group, { priority: competition.priority, instance });
        }
    }

    for (const { instance } of groups.values()) {
        if (instance.enabled) {
            selected.add(instance.id);
        }
    }

    return selected;
}
