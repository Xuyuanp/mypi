/**
 * Shared visual constants: the chart palette and the timeline geometry.
 */

interface TimelineGeometry {
    width: number;
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
    mainTop: 16,
    mainBottom: 206,
    mainHeight: 190,
    toolTop: 222,
    toolHeight: 22,
    axisY: 276,
    padL: 54,
    padR: 18,
};

export const PALETTE = {
    input: "#7c8cff",
    output: "#39d0d8",
    cacheRead: "#3ddc97",
    cacheWrite: "#ffb84d",
    reasoning: "#b07cff",
    cost: "#ffb84d",
    time: "#b07cff",
    speed: "#39d0d8",
    tools: "#ff8fb1",
    cum: "#ffd166",
    bad: "#ff5c7a",
};
