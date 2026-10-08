import { stabilizeUnit, type StableUnit, type Unit } from "../../unit.js";
import type { CompiledEffectContribution } from "../effects/contribution-bindings.js";
import type { EffectInstanceValue } from "../effects/instance.js";
import {
    addStatusContribution,
    createStatusDefinition,
    hasStatus,
    removeStatusContribution,
    setStatusContributionParticipation,
    type StatusFlag,
    type StatusState,
} from "./capability.js";

function contributionId(instance: EffectInstanceValue): string {
    return `@effect/${instance.id}/status`;
}

function updateStatus<U extends Unit>(
    input: U | StableUnit<U>,
    transition: (state: StatusState) => StatusState,
): StableUnit<U> {
    const unit = stabilizeUnit<U>(input);

    if (!hasStatus(unit)) {
        throw new TypeError("status bindings require existing Status capability");
    }

    const status = transition(unit.status);

    return status === unit.status ? unit : { ...unit, status };
}

export function compileStatusBinding(flags: readonly StatusFlag[]): CompiledEffectContribution {
    const owned = createStatusDefinition({ initialFlags: flags }).initialFlags;

    return {
        install: (unit, instance) =>
            updateStatus(unit, (state) =>
                addStatusContribution(state, {
                    id: contributionId(instance),
                    flags: owned,
                    participating: instance.participating,
                }),
            ),
        update: stabilizeUnit,
        setParticipation: (unit, instance, participating) =>
            updateStatus(unit, (state) =>
                setStatusContributionParticipation(state, contributionId(instance), participating),
            ),
        remove: (unit, instance) =>
            updateStatus(unit, (state) =>
                removeStatusContribution(state, contributionId(instance)),
            ),
    };
}
