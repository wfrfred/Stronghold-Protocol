import type { Unit, UnitDefinition } from "../../unit.js";

export const STATUS_FLAGS = Object.freeze([
    "TARGET_FREE",
    "ALLY_TARGET_FREE",
    "HEAL_FREE",
    "INVISIBLE",
    "CAMOUFLAGE",
    "INVINCIBLE",
    "UNDEADABLE",
    "STUNNED",
    "SILENCED",
    "SP_RECOVERY_BLOCKED",
] as const);

export type StatusFlag = (typeof STATUS_FLAGS)[number];

export type StatusContributionId = string;

export const BASELINE_STATUS_CONTRIBUTION_ID = "@baseline";

export interface StatusDefinition {
    readonly initialFlags: readonly StatusFlag[];
}

export interface StatusContribution {
    readonly id: StatusContributionId;
    readonly flags: readonly StatusFlag[];
    readonly participating: boolean;
}

export interface StatusContributionInput {
    readonly id: StatusContributionId;
    readonly flags: readonly StatusFlag[];
    readonly participating?: boolean;
}

export interface StatusState {
    readonly contributions: readonly StatusContribution[];
}

export interface Status {
    readonly status: StatusState;
}

export interface StatusUnitDefinition extends UnitDefinition {
    readonly status: StatusDefinition;
}

export type EffectiveStatusFlags = ReadonlySet<StatusFlag>;

export function hasStatus<U extends Unit>(
    unit: U,
): unit is U & Status & Unit<U["definition"] & StatusUnitDefinition> {
    return "status" in unit && "status" in unit.definition;
}

export function hasStatusFlag(unit: Unit, flag: StatusFlag): boolean {
    return (
        hasStatus(unit) &&
        unit.status.contributions.some(
            (contribution) => contribution.participating && contribution.flags.includes(flag),
        )
    );
}

export function createStatusDefinition(definition: StatusDefinition): StatusDefinition {
    return definition;
}

export function initializeStatusState(definition: StatusDefinition): StatusState {
    return {
        contributions: [
            {
                id: BASELINE_STATUS_CONTRIBUTION_ID,
                flags: definition.initialFlags,
                participating: true,
            },
        ],
    };
}

export function addStatusContribution(
    state: StatusState,
    contribution: StatusContributionInput,
): StatusState {
    if (contribution.id.length === 0) {
        throw new TypeError("status contribution id must be nonempty");
    }
    if (contribution.id === BASELINE_STATUS_CONTRIBUTION_ID) {
        throw new TypeError("baseline status contribution is reserved");
    }
    if (state.contributions.some(({ id }) => id === contribution.id)) {
        throw new TypeError(`duplicate status contribution ${contribution.id}`);
    }

    return {
        contributions: [
            ...state.contributions,
            {
                id: contribution.id,
                flags: contribution.flags,
                participating: contribution.participating ?? true,
            },
        ],
    };
}

export function setStatusContributionParticipation(
    state: StatusState,
    contributionId: StatusContributionId,
    participating: boolean,
): StatusState {
    if (contributionId === BASELINE_STATUS_CONTRIBUTION_ID) {
        throw new TypeError("baseline status contribution participation cannot be changed");
    }

    const current = state.contributions.find(({ id }) => id === contributionId);

    if (current === undefined || current.participating === participating) {
        return state;
    }

    return {
        contributions: state.contributions.map((contribution) =>
            contribution === current ? { ...contribution, participating } : contribution,
        ),
    };
}

export function removeStatusContribution(
    state: StatusState,
    contributionId: StatusContributionId,
): StatusState {
    if (contributionId === BASELINE_STATUS_CONTRIBUTION_ID) {
        throw new TypeError("baseline status contribution cannot be removed");
    }

    const contributions = state.contributions.filter(({ id }) => id !== contributionId);

    if (contributions.length === state.contributions.length) {
        return state;
    }

    return { contributions };
}

export function deriveEffectiveStatusFlags(state: StatusState): EffectiveStatusFlags {
    return new Set(
        state.contributions.flatMap(({ flags, participating }) => (participating ? flags : [])),
    );
}
