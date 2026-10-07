import type { Unit, UnitDefinition } from "../unit.js";

export const STATUS_FLAGS = Object.freeze([
    "TARGET_FREE",
    "ALLY_TARGET_FREE",
    "HEAL_FREE",
    "INVISIBLE",
    "CAMOUFLAGE",
    "INVINCIBLE",
    "UNDEADABLE",
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

const knownFlags = new Set<string>(STATUS_FLAGS);
const ownedFlags = new WeakSet<readonly StatusFlag[]>();
const ownedContributionValues = new WeakSet<StatusContribution>();
const ownedContributions = new WeakSet<readonly StatusContribution[]>();

function createFlags(flags: readonly StatusFlag[]): readonly StatusFlag[] {
    if (ownedFlags.has(flags)) {
        return flags;
    }

    const snapshot = new Set<StatusFlag>();

    for (const flag of flags) {
        if (!knownFlags.has(flag)) {
            throw new TypeError(`unknown status flag ${flag}`);
        }

        snapshot.add(flag);
    }

    const owned = Object.freeze([...snapshot]);

    ownedFlags.add(owned);

    return owned;
}

function createContribution(contribution: StatusContribution): StatusContribution {
    if (ownedContributionValues.has(contribution)) {
        return contribution;
    }
    if (typeof contribution.id !== "string" || contribution.id.length === 0) {
        throw new TypeError("status contribution id must be nonempty");
    }

    const owned = Object.freeze({ id: contribution.id, flags: createFlags(contribution.flags) });

    ownedContributionValues.add(owned);

    return owned;
}

function ownContributions(
    contributions: readonly StatusContribution[],
): readonly StatusContribution[] {
    if (ownedContributions.has(contributions)) {
        return contributions;
    }

    const ids = new Set<StatusContributionId>();
    const snapshot: StatusContribution[] = [];

    for (const contribution of contributions) {
        const owned = createContribution(contribution);

        if (ids.has(owned.id)) {
            throw new TypeError(`duplicate status contribution ${owned.id}`);
        }

        ids.add(owned.id);
        snapshot.push(owned);
    }

    const owned = Object.freeze(snapshot);

    ownedContributions.add(owned);

    return owned;
}

export function hasStatus<U extends Unit>(
    unit: U,
): unit is U & Status & Unit<U["definition"] & StatusUnitDefinition> {
    return "status" in unit && "status" in unit.definition;
}

export function hasStatusFlag(unit: Unit, flag: StatusFlag): boolean {
    return (
        hasStatus(unit) &&
        unit.status.contributions.some((contribution) => contribution.flags.includes(flag))
    );
}

export function createStatusDefinition(definition: StatusDefinition): StatusDefinition {
    return Object.freeze({ initialFlags: createFlags(definition.initialFlags) });
}

export function copyStatusState(state: StatusState): StatusState {
    return { contributions: ownContributions(state.contributions) };
}

export function initializeStatusState(definition: StatusDefinition): StatusState {
    return {
        contributions: ownContributions([
            { id: BASELINE_STATUS_CONTRIBUTION_ID, flags: definition.initialFlags },
        ]),
    };
}

export function addStatusContribution(
    state: StatusState,
    contribution: StatusContribution,
): StatusState {
    if (contribution.id === BASELINE_STATUS_CONTRIBUTION_ID) {
        throw new TypeError("baseline status contribution is reserved");
    }

    return { contributions: ownContributions([...state.contributions, contribution]) };
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

    return { contributions: ownContributions(contributions) };
}

export function deriveEffectiveStatusFlags(state: StatusState): EffectiveStatusFlags {
    return new Set(state.contributions.flatMap(({ flags }) => flags));
}
