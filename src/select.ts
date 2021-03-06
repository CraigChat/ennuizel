/*
 * Copyright (c) 2021 Yahweasel
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY
 * SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION
 * OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN
 * CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 */

// Components related to selecting parts of a track

import * as track from "./track";
import * as ui from "./ui";
import * as util from "./util";

/**
 * A selectable entity. Should be a track.
 */
export interface Selectable {
    /**
     * The underlying track.
     */
    track: track.Track;

    /**
     * The <div> over which a selection box can be overlain.
     */
    wrapper: HTMLElement;

    /**
     * The actual selection box. Use addSelectable to fill this in.
     */
    display?: HTMLCanvasElement;

    /**
     * Get the duration of this track, in seconds.
     */
    duration: () => number;
}

/**
 * All of the selectable entities currently known.
 */
let selectables: Selectable[] = [];

/**
 * When durations change and such, it's not necessary for the client to wait
 * for the async function, but it *is* necessary for us to synchronize
 * everything, so we have a single global Promise to do so.
 */
let selPromise: Promise<unknown> = Promise.all([]);

/**
 * The current selection range, in time, plus the anchor, used during selection
 * to decide whether to switch to range-selection mode.
 */
let selectStart = 0, selectEnd = 0,
    selectAnchor: number = null, selectAnchorTime = 0;

/**
 * Set if we're currently selecting a range.
 */
let activeSelectingRange = false;

/**
 * The current selected selectable(s).
 */
const selectedEls: Set<Selectable> = new Set();

/**
 * The play head, only visible while playing audio.
 */
export let playHead: number = null;

/**
 * Add a selectable.
 * @param sel  Selectable to add.
 */
export async function addSelectable(sel: Selectable) {
    // Make the selection canvas
    const c = sel.display = ui.mk("canvas", sel.wrapper, {
        className: "selection-canvas",
        width: 1280, // Will be updated automatically
        height: ui.trackHeight
    });
    selectables.push(sel);
    selectedEls.add(sel);

    // Make sure it actually is selectable
    c.addEventListener("mousedown", (ev: MouseEvent) => {
        ev.preventDefault();
        if (document.activeElement)
            (<HTMLElement> document.activeElement).blur();

        const x = ev.offsetX + ui.ui.main.scrollLeft;

        /* Behavior of clicking on selection:
         * With ctrl: Add or remove this track from the selection list.
         * With shift: Add this track if it's not selected; extend the time
         * otherwise.
         * With neither: Click to select just this track, drag to extend
         * selection.
         */

        if (ev.ctrlKey) {
            // Add or remove this track
            if (selectedEls.has(sel))
                selectedEls.delete(sel);
            else
                selectedEls.add(sel);

        } else if (ev.shiftKey) {
            // Extending an existing selection
            if (selectedEls.has(sel)) {
                // In time
                const selectTime = x / (ui.pixelsPerSecond * ui.ui.zoom);
                const startDist = Math.abs(selectTime - selectStart);
                const endDist = Math.abs(selectTime - selectEnd);
                if (selectTime < selectStart ||
                    (selectTime <= selectEnd && startDist < endDist)) {
                    selectAnchorTime = selectEnd;
                    selectStart = selectTime;
                } else {
                    selectAnchorTime = selectStart;
                    selectEnd = selectTime;
                }

                selectAnchor = x;
                activeSelectingRange = true;

            } else {
                // In space
                selectedEls.add(sel);

            }

        } else {
            // Starting a fresh selection
            selectStart = selectEnd = selectAnchorTime =
                x / (ui.pixelsPerSecond * ui.ui.zoom);
            selectAnchor = x;
            selectedEls.clear();
            selectedEls.add(sel);
            activeSelectingRange = false;

        }

        updateDisplay();
    });

    c.addEventListener("mousemove", (ev: MouseEvent) => {
        if (selectAnchor === null)
            return;

        ev.preventDefault();

        const x = ev.offsetX + ui.ui.main.scrollLeft;

        // Make sure we're in the selection
        if (!selectedEls.has(sel))
            selectedEls.add(sel);

        // Decide whether to do range selection
        if (!activeSelectingRange && Math.abs(x - selectAnchor) >= 16)
            activeSelectingRange = true;

        // Update the range selection
        const time = x / (ui.pixelsPerSecond * ui.ui.zoom);
        if (activeSelectingRange) {
            if (time < selectAnchorTime) {
                selectStart = time;
                selectEnd = selectAnchorTime;
            } else {
                selectStart = selectAnchorTime;
                selectEnd = time;
            }

        } else {
            selectStart = selectEnd = time;

        }

        updateDisplay();
    });

    await updateDisplay();
}

// When we lift the mouse *anywhere*, unanchor
document.body.addEventListener("mouseup", () => {
    if (selectAnchor !== null)
        selectAnchor = null;
});

/**
 * Remove a selectable, based on the underlying track.
 * @param track  Track to remove.
 */
export async function removeSelectable(track: any) {
    const [sel] = selectables.filter(x => x.track === track);
    if (sel) {
        const idx = selectables.indexOf(sel);
        selectables.splice(idx, 1);
        await updateDisplay();
    }
}

/**
 * Clear all selectables.
 */
export async function clearSelectables() {
    selectables = [];
    selectStart = selectEnd = 0;
    selectedEls.clear();
}

/**
 * Interface for the current selection.
 */
export interface Selection {
    range: boolean;
    start: number;
    end: number;
    tracks: track.Track[];
}

/**
 * Get the current selection.
 */
export function getSelection(): Selection {
    return {
        range: (selectStart !== selectEnd),
        start: selectStart,
        end: selectEnd,
        tracks: selectables.filter(x => selectedEls.has(x)).map(x => x.track)
    };
}

/**
 * Set the *time* of the selection. Don't set the end time to select all time.
 * @param start  Start time. Default 0.
 * @param end  Optional end time.
 */
export async function selectTime(start = 0, end?: number) {
    selectStart = start;
    selectEnd = (typeof end === "number") ? end : start;
    await updateDisplay();
}

/**
 * Set the *tracks* currently selected. Does not update the time.
 * @param tracks  Array of tracks to select. May be empty.
 */
export async function selectTracks(tracks: track.Track[]) {
    // Make a set
    const trackSet = new Set(tracks);

    // Then add the right ones
    selectedEls.clear();
    for (const sel of selectables) {
        if (trackSet.has(sel.track))
            selectedEls.add(sel);
    }

    await updateDisplay();
}

/**
 * Select all selectables, and clear the range so that everything is selected.
 * @param opts  Selection options.
 */
export async function selectAll(opts: {tracksOnly?: boolean} = {}) {
    if (!opts.tracksOnly)
        selectEnd = selectStart;
    for (const sel of selectables)
        selectedEls.add(sel);
    await updateDisplay();
}

/**
 * Get the maximum duration of any selectable.
 */
function maxDuration() {
    let duration = 0;
    for (const sel of selectables)
        duration = Math.max(duration, sel.duration());
    return duration;
}

/**
 * Set the play head.
 * @param to  Value to set the play head to.
 */
export async function setPlayHead(to: number) {
    playHead = to;
    await updateDisplay();
}

// The animation frame currently being awaited
let animationFrame: number = null;

/**
 * Update the selection display.
 */
async function updateDisplay() {
    if (animationFrame !== null) {
        // Somebody else is handling this already
        return;
    }

    await selPromise;

    // Wait for an animation frame
    await new Promise(res => {
        animationFrame = window.requestAnimationFrame(() => {
            animationFrame = null;
            res(null);
        });
    });

    selPromise = (async function() {
        const scrollLeft = ui.ui.main.scrollLeft;
        const width = window.innerWidth - 128 /* FIXME: magic number */;

        // Relocate each canvas
        for (const sel of selectables) {
            sel.display.style.left = scrollLeft + "px";
            sel.display.width = width;
        }

        // Figure out where we're drawing
        const selectingRange = (selectStart !== selectEnd);
        const startPx = Math.max(
            Math.floor(selectStart * ui.pixelsPerSecond * ui.ui.zoom - scrollLeft),
            -2
        );
        const endPx = Math.min(
            Math.max(
                Math.ceil(selectEnd * ui.pixelsPerSecond * ui.ui.zoom - scrollLeft),
                startPx + 1
            ),
            width + 2
        );
        const playHeadPx = (playHead === null) ? null : Math.round(
            playHead * ui.pixelsPerSecond * ui.ui.zoom - scrollLeft
        );

        // Draw the timeline
        {
            const timeline = ui.ui.timeline;
            const tw = timeline.width = window.innerWidth;
            const th = 32 /* FIXME: magic number */;
            const ctx = timeline.getContext("2d");
            ctx.clearRect(0, 0, tw, th);
            ctx.textBaseline = "top";

            // Figure out the scale to draw
            const pps = ui.pixelsPerSecond * ui.ui.zoom;
            let labelScale = 1;
            if (pps >= 32) {
                // 32 pixels per second, enough to label every second
                labelScale = 1;
            } else if (pps >= 32/5) {
                labelScale = 5;
            } else if (pps >= 32/10) {
                labelScale = 10;
            } else if (pps >= 32/30) {
                labelScale = 30;
            } else {
                labelScale = 60;
            }

            // And draw it
            const firstSec = ~~(scrollLeft / pps);
            let sec: number, x: number;
            for (sec = firstSec, x = firstSec * pps - scrollLeft + 128; x < tw; sec++, x += pps) {
                if (sec % labelScale === 0) {
                    ctx.fillStyle = "#fff";
                    ctx.fillRect(~~x, 0, 1, th/2);
                    const ts = util.timestamp(sec, true);
                    const m = ctx.measureText(ts);
                    ctx.fillText(ts, ~~x - m.width/2, th/2+2);
                } else {
                    ctx.fillStyle = "#999";
                    ctx.fillRect(~~x, 0, 1, th/4);
                }
            }
        }

        // And draw it
        for (const sel of selectables) {
            const ctx = sel.display.getContext("2d");
            const w = sel.display.width;
            ctx.clearRect(0, 0, w, ui.trackHeight);

            // Don't show the selection if we're not selected
            if (selectedEls.has(sel)) {
                if (selectingRange) {
                    // Blur what isn't selected
                    ctx.fillStyle = "rgba(0,0,0,0.5)";
                    ctx.fillRect(0, 0, startPx, ui.trackHeight);
                    ctx.fillRect(endPx, 0, w - endPx, ui.trackHeight);

                } else {
                    // Just draw a line for the point selected
                    ctx.fillStyle = "#fff";
                    ctx.fillRect(startPx, 0, 1, ui.trackHeight);

                }

            } else {
                // Black it out
                ctx.fillStyle = "rgba(0,0,0,0.5)";
                ctx.fillRect(0, 0, width, ui.trackHeight);

            }

            // Also draw the play head
            if (playHeadPx !== null) {
                ctx.fillStyle = "#fff";
                ctx.fillRect(playHeadPx, 0, 1, ui.trackHeight);
            }
        }
    })();

    await selPromise;
}

// Selection hotkeys
document.body.addEventListener("keydown", async function(ev) {
    if (selectAnchor !== null)
        return;

    if (ev.key === "Home") {
        ev.preventDefault();
        selectStart = selectEnd = 0;
        updateDisplay();

    } else if (ev.key === "End") {
        ev.preventDefault();
        selectStart = selectEnd = maxDuration();
        updateDisplay();

    } else if (ev.key === "a" && ev.ctrlKey) {
        ev.preventDefault();
        selectAll({tracksOnly: ev.altKey});

    }
});

/**
 * Loader for selection. Just makes sure the graphics are updated when we scroll.
 */
export async function load() {
    ui.ui.main.addEventListener("scroll", updateDisplay);
    ui.ui.onzoom.push(updateDisplay);
}
