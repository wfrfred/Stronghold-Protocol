import { assertNonnegativeSafeInteger } from "../../core/common/assert.js";

const overrideTypes = { DEFAULT: 0, STACK: 1, UNIQUE: 2, EXTEND: 3, EXTEND_TIME: 4 } as const;

export type BuffOverrideType = keyof typeof overrideTypes;

export interface BuffStacking {
    readonly overrideType: BuffOverrideType;
    readonly maxStackCnt: number;
    readonly maxValidStackCnt: number;
    readonly refreshRemainingTimeWhenStackMax: boolean;
    readonly clearAllStackCntWhenTimeUp: boolean;
    readonly takeSnapshotWhenExtend: boolean;
}

export interface BuffApplication {
    readonly stackCount: number;
    readonly expiresAtTick: number | null;
    readonly maxStackCount?: number | null;
}

export type BuffStackingPlan =
    | { readonly type: "INSTALL" }
    | { readonly type: "REJECT" }
    | {
          readonly type: "REFRESH";
          readonly stackCount: number;
          readonly expiresAtTick: number | null;
          readonly takeSnapshot: boolean;
          readonly reloadModifiers: boolean;
      };

export type BuffExpiryPlan =
    | { readonly type: "FINISH" }
    | {
          readonly type: "REFRESH";
          readonly stackCount: number;
          readonly expiresAtTick: number | null;
          readonly reloadModifiers: boolean;
      };

export interface CompiledBuffStacking {
    readonly validStackCount: (count: number) => number;
    readonly plan: (
        current: BuffApplication | undefined,
        incoming: BuffApplication,
        tick: number,
    ) => BuffStackingPlan;
    readonly expire: (
        current: BuffApplication,
        lifetimeTicks: number | null,
        tick: number,
    ) => BuffExpiryPlan;
}

const install = Object.freeze({ type: "INSTALL" } as const);
const reject = Object.freeze({ type: "REJECT" } as const);
const finish = Object.freeze({ type: "FINISH" } as const);

function overrideType(value: unknown): BuffOverrideType {
    for (const key in overrideTypes) {
        const type = key as BuffOverrideType;

        if (value === type || value === overrideTypes[type]) {
            return type;
        }
    }

    throw new TypeError(`unsupported buff overrideType: ${String(value)}`);
}

function stackLimit(value: unknown, name: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        throw new RangeError(`${name} must be a safe integer`);
    }

    return value;
}

export function parseBuffStacking(value: unknown): BuffStacking {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError("buff stacking must be an object");
    }

    const source = value as Record<string, unknown>;
    const refreshRemainingTimeWhenStackMax = source.refreshRemainingTimeWhenStackMax;
    const clearAllStackCntWhenTimeUp = source.clearAllStackCntWhenTimeUp;
    const takeSnapshotWhenExtend = source.takeSnapshotWhenExtend;

    if (
        typeof refreshRemainingTimeWhenStackMax !== "boolean" ||
        typeof clearAllStackCntWhenTimeUp !== "boolean" ||
        typeof takeSnapshotWhenExtend !== "boolean"
    ) {
        throw new TypeError("buff stacking refresh and snapshot flags must be boolean");
    }

    return Object.freeze({
        overrideType: overrideType(source.overrideType),
        maxStackCnt: stackLimit(source.maxStackCnt, "maxStackCnt"),
        maxValidStackCnt: stackLimit(source.maxValidStackCnt, "maxValidStackCnt"),
        refreshRemainingTimeWhenStackMax,
        clearAllStackCntWhenTimeUp,
        takeSnapshotWhenExtend,
    });
}

function validateApplication(application: BuffApplication, name: string): void {
    assertNonnegativeSafeInteger(application.stackCount, `${name} stack count`);

    if (application.maxStackCount !== undefined && application.maxStackCount !== null) {
        assertNonnegativeSafeInteger(application.maxStackCount, `${name} stack limit`);
    }

    if (application.expiresAtTick !== null) {
        assertNonnegativeSafeInteger(application.expiresAtTick, `${name} expiration tick`);
    }
}

function latestExpiration(current: BuffApplication, incoming: BuffApplication): number | null {
    if (current.expiresAtTick === null || incoming.expiresAtTick === null) {
        return null;
    }

    return Math.max(current.expiresAtTick, incoming.expiresAtTick);
}

function extendedExpiration(
    current: BuffApplication,
    incoming: BuffApplication,
    tick: number,
): number | null {
    if (current.expiresAtTick === null || incoming.expiresAtTick === null) {
        return null;
    }

    const remaining =
        Math.max(0, current.expiresAtTick - tick) + Math.max(0, incoming.expiresAtTick - tick);
    assertNonnegativeSafeInteger(remaining, "extended buff remaining ticks");

    const expiresAtTick = tick + remaining;
    assertNonnegativeSafeInteger(expiresAtTick, "extended buff expiration tick");

    return expiresAtTick;
}

function refresh(
    stackCount: number,
    expiresAtTick: number | null,
    takeSnapshot: boolean,
    reloadModifiers: boolean,
): BuffStackingPlan {
    return Object.freeze({
        type: "REFRESH",
        stackCount,
        expiresAtTick,
        takeSnapshot,
        reloadModifiers,
    });
}

export function compileBuffStacking(definition: BuffStacking): CompiledBuffStacking {
    const rule = parseBuffStacking(definition);
    const configuredMaxStackCount = rule.maxStackCnt < 0 ? null : rule.maxStackCnt;
    const reloadModifiers = (count: number) =>
        rule.maxValidStackCnt < 0 || count <= rule.maxValidStackCnt;

    return Object.freeze({
        validStackCount: (count: number) => {
            assertNonnegativeSafeInteger(count, "buff stack count");

            return rule.maxValidStackCnt < 0 ? count : Math.min(count, rule.maxValidStackCnt);
        },
        plan: (current: BuffApplication | undefined, incoming: BuffApplication, tick: number) => {
            assertNonnegativeSafeInteger(tick, "buff application tick");
            validateApplication(incoming, "incoming buff");

            if (current !== undefined) {
                validateApplication(current, "current buff");
            }
            if (current === undefined || rule.overrideType === "DEFAULT") {
                return install;
            }

            switch (rule.overrideType) {
                case "UNIQUE":
                    return reject;

                case "STACK": {
                    const maxStackCount =
                        current.maxStackCount === undefined
                            ? configuredMaxStackCount
                            : current.maxStackCount;

                    if (maxStackCount !== null && current.stackCount >= maxStackCount) {
                        return current.stackCount === maxStackCount &&
                            rule.refreshRemainingTimeWhenStackMax
                            ? refresh(
                                  current.stackCount,
                                  latestExpiration(current, incoming),
                                  false,
                                  false,
                              )
                            : reject;
                    }

                    const stackCount = current.stackCount + 1;
                    assertNonnegativeSafeInteger(stackCount, "stacked buff count");

                    return refresh(
                        stackCount,
                        latestExpiration(current, incoming),
                        false,
                        reloadModifiers(stackCount),
                    );
                }

                case "EXTEND":
                    return refresh(
                        current.stackCount,
                        latestExpiration(current, incoming),
                        rule.takeSnapshotWhenExtend,
                        rule.takeSnapshotWhenExtend,
                    );

                case "EXTEND_TIME":
                    return refresh(
                        current.stackCount,
                        extendedExpiration(current, incoming, tick),
                        false,
                        false,
                    );
            }
        },
        expire: (current: BuffApplication, lifetimeTicks: number | null, tick: number) => {
            validateApplication(current, "expiring buff");
            assertNonnegativeSafeInteger(tick, "buff expiration tick");

            if (lifetimeTicks !== null) {
                assertNonnegativeSafeInteger(lifetimeTicks, "buff lifetime ticks");
            }
            if (
                rule.overrideType !== "STACK" ||
                rule.clearAllStackCntWhenTimeUp ||
                current.stackCount <= 1
            ) {
                return finish;
            }

            const stackCount = current.stackCount - 1;
            const expiresAtTick = lifetimeTicks === null ? null : tick + Math.max(1, lifetimeTicks);

            if (expiresAtTick !== null) {
                assertNonnegativeSafeInteger(expiresAtTick, "renewed buff expiration tick");
            }

            return Object.freeze({
                type: "REFRESH",
                stackCount,
                expiresAtTick,
                reloadModifiers: reloadModifiers(stackCount),
            });
        },
    });
}
