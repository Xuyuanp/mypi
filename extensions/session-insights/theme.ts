/**
 * Shared visual constants: the chart palette and the timeline geometry.
 */

interface TimelineGeometry {
    width: number;
    height: number;
    mainTop: number;
    mainBottom: number;
    mainHeight: number;
    toolTop: number;
    toolHeight: number;
    axisY: number;
    padL: number;
    padR: number;
}

/** Shared layout for the timeline SVG. timeline.js mirrors these values. */
export const TIMELINE: TimelineGeometry = {
    width: 1000,
    height: 328,
    mainTop: 20,
    mainBottom: 240,
    mainHeight: 220,
    toolTop: 256,
    toolHeight: 20,
    axisY: 304,
    padL: 58,
    padR: 20,
};

/** Data colours, keyed to the marks that use them. */
export const PALETTE = {
    input: "#7b8ef7",
    output: "#2fb8c6",
    cacheRead: "#3fae7d",
    cacheWrite: "#d9a441",
    reasoning: "#a07ee0",
    cost: "#d9a441",
    time: "#a07ee0",
    speed: "#2fb8c6",
    tools: "#d1798f",
    generating: "#7b8ef7",
    cum: "#dce3f2",
    bad: "#e0616f",
};
