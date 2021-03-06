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

// extern
declare let LibAV: any;

import * as audioData from "./audio-data";
import * as avthreads from "./avthreads";
import * as hotkeys from "./hotkeys";
import * as id36 from "./id36";
import * as select from "./select";
import { EZStream, WSPReadableStream } from "./stream";
import * as track from "./track";
import * as ui from "./ui";

export type FilterFunction =
    (x:EZStream<audioData.LibAVFrame>) =>
    Promise<ReadableStream<audioData.LibAVFrame>>;

/**
 * A custom (presumably non-FFmpeg) filter, provided by a plugin.
 */
export interface CustomFilter {
    /**
     * User-visible name for the filter. May include underscores for
     * hotkeyability, but beware overlaps.
     */
    name: string;

    /**
     * Function to run to perform the filter *from the UI*. If you want an
     * automated filter, expose it as part of your plugin API.
     */
    filter: (d: ui.Dialog) => Promise<void>;
}

/**
 * Simple name-value pair.
 */
interface NameValuePair {
    name: string;
    value: string;
}

/**
 * FFmpeg filter options.
 */
interface FFmpegFilterOptions {
    /**
     * Filter name (in FFmpeg).
     */
    name: string;

    /**
     * Set if the filter produces a different amount of output data than input data.
     */
    changesDuration?: boolean;

    /**
     * Arguments.
     */
    args: NameValuePair[];
}

/**
 * An FFmpeg filter's description, for display.
 */
interface FFmpegFilter {
    /**
     * Human-readable display name.
     */
    name: string;

    /**
     * FFmpeg filter name.
     */
    ffName: string;

    /**
     * Does this filter change duration? Either a simple boolean or a function
     * to determine based on arguments. Default false.
     */
    changesDuration?: boolean | ((args: NameValuePair[]) => boolean);

    /**
     * Parameters.
     */
    params: FFmpegParameter[];
}

/**
 * A single parameter for an ffmpeg filter.
 */
interface FFmpegParameter {
    /**
     * Human-readable display name.
     */
    name: string;

    /**
     * FFmpeg name.
     */
    ffName: string;

    /**
     * Type, in terms of <input/> types, or "number".
     */
    type: string;

    /**
     * Default value for text.
     */
    defaultText?: string;

    /**
     * Default value for number.
     */
    defaultNumber?: number;

    /**
     * Default value for checkbox.
     */
    defaultChecked?: boolean;

    /**
     * Suffix (e.g. dB) to add to the given value.
     */
    suffix?: string;

    /**
     * Minimum value for numeric ranges.
     */
    min?: number;

    /**
     * Maximum value for numeric ranges.
     */
    max?: string;
}

/**
 * Load filtering options.
 */
export async function load() {
    ui.ui.menu.filters.onclick = filterMenu;
    hotkeys.registerHotkey(ui.ui.menu.filters, null, "f");
}

// This really belongs here, but is in audioData because it needs it
export const resample = audioData.resample;

/**
 * Standard FFmpeg filters.
 */
const standardFilters: FFmpegFilter[] = (function() {
    function num(name: string, ffName: string, defaultNumber: number, opts: any = {}) {
        return Object.assign({name, ffName, type: "number", defaultNumber}, opts);
    }
    function chk(name: string, ffName: string, defaultChecked: boolean, opts: any = {}) {
        return Object.assign({name, ffName, type: "checkbox", defaultChecked}, opts);
    }

    return [
    {
        name: "_Volume",
        ffName: "volume",
        params: [
            num("_Volume (dB)", "volume", 0, {suffix: "dB"})
        ]
    },

    {
        name: "_Compressor",
        ffName: "acompressor",
        params: [
            num("_Input gain (dB)", "level_in", 0, {suffix: "dB", min: -36, max: 36}),
            // FIXME: Mode
            num("_Threshold to apply compression (dB)", "threshold", -18, {suffix: "dB", min: -60, max: 0}),
            num("_Ratio to compress signal", "ratio", 2, {min: 1, max: 20}),
            num("_Attack time (ms)", "attack", 20, {min: 0.01, max: 2000}),
            num("Re_lease time (ms)", "release", 250, {min: 0.01, max: 9000}),
            num("_Output gain (dB)", "makeup", 0, {suffix: "dB", min: 0, max: 36}),
            num("Curve of compressor _knee", "knee", 2.82843, {min: 1, max: 8})
            // FIXME: Link
            // FIXME: Detection
        ]
    },

    {
        name: "Dynamic audio _normalizer (leveler)",
        ffName: "dynaudnorm",
        params: [
            num("Frame _length (ms)", "framelen", 500, {min: 10, max: 8000}),
            // FIXME: Must be odd:
            num("_Gaussian filter window size", "gausssize", 31, {min: 3, max: 301}),
            num("Target _peak value (dB)", "peak", -0.5, {suffix: "dB", min: -36, max: 0}),
            num("Maximum _gain (dB)", "maxgain", 20, {suffix: "dB", min: 0, max: 40}),
            // FIXME: This being linear is stupid:
            num("Target _RMS (linear)", "targetrms", 0, {min: 0, max: 1}),
            // FIXME: Coupling
            // FIXME: Correct DC
            num("Traditional _compression factor", "compress", 0, {min: 0, max: 30}),
            num("_Threshold (linear)", "threshold", 0, {min: 0, max: 1})
        ]
    },

    {
        name: "_Echo",
        ffName: "aecho",
        changesDuration: true,
        params: [
            num("_Input gain (dB)", "in_gain", -4.5, {suffix: "dB", min: -60, max: 0}),
            num("_Output gain (dB)", "out_gain", -10.5, {suffix: "dB", min: -60, max: 0}),
            // FIXME: Multiple delays, decays
            num("_Delay (ms)", "delays", 1000, {min: 0, max: 90000}),
            num("De_cay (linear)", "decays", 0.5, {min: 0, max: 1})
        ]
    },

    {
        name: "_Limiter",
        ffName: "alimiter",
        params: [
            num("_Limit (dB)", "limit", 0, {suffix: "dB", min: -24, max: 0}),
            num("_Input gain (dB)", "level_in", 0, {suffix: "dB", min: -36, max: 0}),
            num("_Output gain (dB)", "level_out", 0, {suffix: "dB", min: -36, max: 0}),
            num("_Attack time (ms)", "attack", 5, {min: 1, max: 1000}),
            num("_Release time (ms)", "release", 50, {min: 1, max: 1000}),
            // FIXME: ASC is what now???
            chk("Auto-le_vel", "level", true)
        ]
    },

    {
        name: "_Tempo",
        ffName: "atempo",
        changesDuration: true,
        params: [
            num("_Tempo multiplier", "tempo", 1, {min: 0.5, max: 100})
        ]
    },

    {
        name: "_FFmpeg filter (advanced)",
        ffName: null,
        changesDuration: true,
        params: [
            {
                name: "Filter _graph",
                ffName: null,
                type: "text"
            }
        ]
    }
    ];
})();

/**
 * Custom filters registered by plugins.
 */
const customFilters: CustomFilter[] = [];

/**
 * Create a stream to apply the given libav filter, described by a filter
 * string.
 * @param stream  The input stream.
 * @param fs  The filter string.
 */
export async function ffmpegStream(
    stream: EZStream<audioData.LibAVFrame>, fs: string
) {
    // Get the first piece of data to know the input type
    const first = await stream.read();
    if (!first) {
        // No data!
        return new WSPReadableStream({
            start(controller) {
                controller.close();
            }
        });
    }
    stream.push(first);

    let time = 0;

    // Make the filter
    audioData.sanitizeLibAVFrame(first);
    const libav = await avthreads.get();
    const frame = await libav.av_frame_alloc();
    const [filter_graph, buffersrc_ctx, buffersink_ctx] =
        await libav.ff_init_filter_graph(fs, {
            sample_rate: first.sample_rate,
            sample_fmt: first.format,
            channel_layout: first.channel_layout
        }, {
            sample_rate: first.sample_rate,
            sample_fmt: first.format,
            channel_layout: first.channel_layout
        });

    // And the stream
    return new WSPReadableStream({
        async pull(controller) {
            while (true) {
                // Get some data
                const chunk = await stream.read();
                if (chunk)
                    chunk.node = null;

                // Filter it
                const fframes = await libav.ff_filter_multi(buffersrc_ctx,
                    buffersink_ctx, frame, chunk ? [chunk] : [], !chunk);

                // Send it thru
                for (const frame of fframes) {
                    controller.enqueue(frame);
                }

                if (!chunk) {
                    controller.close();
                    await libav.av_frame_free_js(frame);
                    await libav.avfilter_graph_free_js(filter_graph);
                }

                if (!chunk || fframes.length)
                    break;
            }
        },

        async cancel() {
            await libav.av_frame_free_js(frame);
            await libav.avfilter_graph_free_js(filter_graph);
        }
    });
}

/**
 * Apply an FFmpeg filter with the given options.
 * @param filter  The filter and options.
 * @param sel  The selection to filter.
 * @param d  (Optional) The dialog in which to show the status, if applicable.
 *           This dialog will *not* be closed.
 */
export async function ffmpegFilter(
    filter: FFmpegFilterOptions, sel: select.Selection, d: ui.Dialog
) {
    // Make the filter string
    let fs = ""
    if (filter.name) {
        fs = filter.name;
        if (filter.args.length)
            fs += "=";
    }
    fs += filter.args.map(x => (x.name ? x.name + "=" : "") + x.value).join(":");

    await selectionFilter(x => ffmpegStream(x, fs),
        !!filter.changesDuration, sel, d);
}

/**
 * Apply a filter function to a selection.
 * @param ff  The filter function.
 * @param changesDuration  Set if this filter changes duration, so the process
 *                         must use a temporary track.
 * @param sel  The selection to filter.
 * @param d  (Optional) The dialog in which to show the status, if applicable.
 *           This dialog will *not* be closed.
 */
export async function selectionFilter(
    ff: FilterFunction, changesDuration: boolean, sel: select.Selection,
    d: ui.Dialog
) {
    // Get the audio tracks
    const tracks = <audioData.AudioTrack[]>
        sel.tracks.filter(x => x.type() === track.TrackType.Audio);

    if (tracks.length === 0) {
        // Well that was easy
        return;
    }

    if (d)
        d.box.innerHTML = "Filtering...";

    // Make the stream options
    const streamOpts = {
        start: sel.range ? sel.start : void 0,
        end: sel.range ? sel.end : void 0
    };

    // Make the status
    const status = tracks.map(x => ({
        name: x.name,
        filtered: 0,
        duration: x.duration()
    }));

    // Function to show the current status
    function showStatus() {
        if (d) {
            const statusStr = status.map(x =>
                x.name + ": " + Math.round(x.filtered / x.duration * 100) + "%")
            .join("<br/>");
            d.box.innerHTML = "Filtering...<br/>" + statusStr;
        }
    }

    // The filtering function for each track
    async function filterThread(track: audioData.AudioTrack, idx: number) {
        // Input stream
        const inStream = track.stream(
            Object.assign({keepOpen: !changesDuration}, streamOpts))
            .getReader();

        // Status stream
        const statusStream = new WSPReadableStream({
            async pull(controller) {
                const chunk = await inStream.read();
                if (chunk.done) {
                    controller.close();
                } else {
                    audioData.sanitizeLibAVFrame(chunk.value);
                    status[idx].filtered += chunk.value.nb_samples / chunk.value.sample_rate;
                    showStatus();
                    controller.enqueue(chunk.value);
                }
            }
        });

        // Filter stream
        const filterStream = await ff(new EZStream(statusStream));

        if (changesDuration) {
            // We have to write it to a new track, then copy it over
            const newTrack = new audioData.AudioTrack(
                await id36.genFresh(track.project.store, "audio-track-"),
                track.project, {
                    format: track.format,
                    sampleRate: track.sampleRate,
                    channels: track.channels
                }
            );

            await newTrack.append(new EZStream(filterStream));

            await track.replace(
                sel.range ? sel.start : 0,
                sel.range ? sel.end : Infinity,
                newTrack);

        } else {
            // Just overwrite it
            await track.overwrite(new EZStream(filterStream),
                Object.assign({closeTwice: true}, streamOpts));

        }
    }

    // Number of threads to run at once
    const threads = navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 2;

    // Current state
    const running: Promise<unknown>[] = [];
    const toRun = tracks.map((x, idx) => <[audioData.AudioTrack, number]> [x, idx]);

    // Run
    while (toRun.length) {
        // Get the right number of threads running
        while (running.length < threads && toRun.length) {
            const [sel, idx] = toRun.shift();
            running.push(filterThread(sel, idx));
        }

        // Wait for one to finish to make room for more
        const fin = await Promise.race(running.map((x, idx) => x.then(() => idx)));
        running.splice(fin, 1);
    }

    // Wait for them all to finish
    await Promise.all(running);
}

/**
 * Mix the selected tracks into a new track.
 * @param sel  The selection to mix.
 * @param d  (Optional) The dialog in which to show the status, if applicable.
 *           This dialog will *not* be closed.
 * @param opts  Other options.
 */
export async function mixTracks(
    sel: select.Selection, d: ui.Dialog, opts: {
        preFilter?: FilterFunction,
        postFilter?: FilterFunction
    } = {}
): Promise<track.Track> {
    // Get the audio tracks
    const tracks = <audioData.AudioTrack[]>
        sel.tracks.filter(x => x.type() === track.TrackType.Audio);

    if (tracks.length === 0) {
        // Well that was easy
        return null;
    }

    if (d)
        d.box.innerHTML = "Mixing...";

    // The filter string is complex. First, give each track a name.
    let fs = tracks.map((x, idx) => "[in" + idx + "]anull[aud" + idx + "]").join(";");

    // Then start mixing them together
    let mtracks = tracks.map((x, idx) => "aud" + idx);
    while (mtracks.length > 16) {
        // Mix them in groups of 16
        const otracks: string[] = [];
        for (let i = 0; i < mtracks.length; i += 16) {
            const gtracks = mtracks.slice(i, i + 16);
            fs += ";" + gtracks.map(x => "[" + x + "]").join("") +
                  "amix=" + gtracks.length + "[aud" + otracks.length + "]";
            otracks.push("aud" + otracks.length);
        }
        mtracks = otracks;
    }

    // Then mix whatever remains as one
    fs += ";" + mtracks.map(x => "[" + x + "]").join("") +
        "amix=" + mtracks.length + "[out]";

    // Make the stream options
    const streamOpts = {
        start: sel.range ? sel.start : void 0,
        end: sel.range ? sel.end : void 0
    };

    // Make our output track
    const outTrack = new audioData.AudioTrack(
        await id36.genFresh(tracks[0].project.store, "audio-track-"),
        tracks[0].project, {
            name: "Mix",
            sampleRate: Math.max.apply(Math, tracks.map(x => x.sampleRate)),
            format: audioData.LibAVSampleFormat.FLT,
            channels: Math.max.apply(Math, tracks.map(x => x.channels))
        }
    );
    const channelLayout = audioData.toChannelLayout(outTrack.channels);

    // Figure out the maximum duration
    const duration = Math.max.apply(Math, tracks.map(x => x.duration()));
    let mixed = 0;

    // Function to show the current status
    function showStatus() {
        if (d)
            d.box.innerHTML = "Mixing... " + Math.round(mixed / duration * 100) + "%";
    }

    // Make a libav instance
    const libav = await avthreads.get();

    // Make the mix filter
    const frame = await libav.av_frame_alloc();
    const [filter_graph, buffersrc_ctx, buffersink_ctx] =
        await libav.ff_init_filter_graph(fs, tracks.map(x => ({
            sample_rate: x.sampleRate,
            sample_fmt: x.format,
            channel_layout: audioData.toChannelLayout(x.channels)
        })), {
            sample_rate: outTrack.sampleRate,
            sample_fmt: outTrack.format,
            channel_layout: channelLayout
        });

    // Make all the input streams
    let inRStreams = await Promise.all(
        tracks.map(
            x => audioData.resample(new EZStream(x.stream(streamOpts)),
                x.sampleRate, x.format, x.channels, {reframe: true})
        )
    );
    if (opts.preFilter) {
        inRStreams = await Promise.all(
            inRStreams.map(
                x => opts.preFilter(new EZStream(x))
            )
        );
    }
    const inStreams = inRStreams.map(x => x.getReader());

    // Remember which tracks are done
    const trackDone = tracks.map(() => false);
    let trackDoneCt = 0;

    // The mix stream
    const mixStream = new WSPReadableStream({
        async pull(controller) {
            while (true) {
                // Get some data
                const inps = await Promise.all(inStreams.map(async function(x, idx) {
                    if (trackDone[idx])
                        return [];

                    const inp = await x.read();
                    if (inp.done) {
                        trackDone[idx] = true;
                        trackDoneCt++;
                        return [];
                    }

                    inp.value.node = null;
                    return [inp.value];
                }));

                // Filter it
                const outp = await libav.ff_filter_multi(
                    buffersrc_ctx, buffersink_ctx, frame,
                    inps, trackDone);

                // Write it out
                if (outp.length) {
                    for (const part of outp) {
                        controller.enqueue(part);
                        mixed += part.nb_samples / outTrack.sampleRate;
                    }
                    showStatus();
                }

                // Maybe end it
                if (trackDoneCt === tracks.length)
                    controller.close();

                if (outp.length || trackDoneCt === tracks.length)
                    break;
            }
        }
    });

    // Possibly a filtered output stream
    let outStream: ReadableStream<audioData.LibAVFrame> = null;
    if (opts.postFilter)
        outStream = await opts.postFilter(new EZStream(mixStream));

    // Append that to the new track
    await outTrack.append(new EZStream(outStream || mixStream));

    // And get rid of the libav instance
    await libav.av_frame_free_js(frame);
    await libav.avfilter_graph_free_js(filter_graph);

    return outTrack;
}

/**
 * Show the main filter menu.
 */
async function filterMenu() {
    await ui.dialog(async function(d, show) {
        let first: HTMLElement = null;

        // Make a button for each filter in the standard list
        for (const filter of standardFilters) {
            const b = hotkeys.btn(d, filter.name, {className: "row small"});
            if (!first)
                first = b;
            b.onclick = () => uiFilter(d, filter);
        }

        // And for each filter in the custom list
        for (const filter of customFilters) {
            const b = hotkeys.btn(d, filter.name, {className: "row small"});
            b.onclick = () => filter.filter(d);
        }

        show(first);
    }, {
        closeable: true
    });
}

/**
 * Show the user interface for a particular filter.
 * @param d  The dialog to reuse for the filter display.
 * @param filter  The filter itself.
 */
async function uiFilter(d: ui.Dialog, filter: FFmpegFilter) {
    await ui.dialog(async function(d, show) {
        let first: HTMLElement = null;
        const pels: Record<string, HTMLInputElement> = Object.create(null);

        // Show each of the filter parameters
        for (const param of filter.params) {
            const id = "ez-filter-param-" + filter.ffName + "-" + param.ffName;
            const div = ui.mk("div", d.box, {className: "row"});
            hotkeys.mk(d, param.name + ":&nbsp;",
                lbl => ui.lbl(div, id, lbl, {className: "ez"}));
            const inp = pels[param.ffName] = ui.mk("input", div, {
                id,
                type: param.type === "number" ? "text" : param.type
            });

            if (!first)
                first = inp;

            // Set any type-specific properties
            if (param.type === "number") {
                // Default
                if (typeof param.defaultNumber === "number")
                    inp.value = param.defaultNumber + "";

                // Range
                if (typeof param.min === "number" ||
                    typeof param.max === "number") {
                    inp.addEventListener("change", () => {
                        const val = +inp.value;
                        if (typeof param.min === "number" && val < param.min)
                            inp.value = param.min + "";
                        else if (typeof param.max === "number" && val > param.max)
                            inp.value = param.max + "";
                    });
                }

            } else if (param.type === "text") {
                // Default
                if (param.defaultText)
                    inp.value = param.defaultText;

            } else if (param.type === "checkbox") {
                // Default
                inp.checked = !!param.defaultChecked;

            }

            if (param.type === "number" || param.type === "text") {
                // Support enter to submit
                inp.addEventListener("keydown", (ev: KeyboardEvent) => {
                    if (ev.key === "Enter") {
                        ev.preventDefault();
                        doIt();
                    }
                });
            }

        }

        // And an actual "filter" button
        const btn = hotkeys.btn(d, "_Filter", {className: "row"});
        btn.onclick = doIt;

        // Perform the actual filter
        function doIt() {
            uiFilterGo(d, filter, pels);
        }

        show(first);
    }, {
        closeable: true,
        reuse: d
    });
}

/**
 * Perform an actual filter (from the UI).
 * @param d  The dialog to reuse for the filter display.
 * @param filter  The filter itself.
 * @param pels  Elements corresponding to the parameters.
 */
async function uiFilterGo(
    d: ui.Dialog, filter: FFmpegFilter, pels: Record<string, HTMLInputElement>
) {
    await ui.loading(async function(d) {
        // Convert the parameter elements into arguments
        const args: NameValuePair[] = [];
        for (const param of filter.params) {
            let val = "";

            // Get out the value
            switch (param.type) {
                case "number": {
                    // Check the range
                    let v = +pels[param.ffName].value;
                    if (typeof param.min === "number" && v < param.min)
                        v = param.min;
                    else if (typeof param.max === "number" && v > param.max)
                        v = param.max;
                    val = v + "";
                    break;
                }

                case "checkbox":
                    val = pels[param.ffName].checked ? "1" : "0";
                    break;

                default:
                    val = pels[param.ffName].value;
            }

            // Add any suffix
            if (param.suffix)
                val += param.suffix;

            // Add it to the list
            args.push({name: param.ffName, value: val});
        }

        // Join that into options
        // FIXME: changesDuration()
        const opts: FFmpegFilterOptions = {
            name: filter.ffName,
            args,
            changesDuration: !!filter.changesDuration
        };

        // Get the selection
        const sel = select.getSelection();
        if (sel.tracks.length === 0) {
            // Nothing to do!
            return;
        }

        // Prepare for undo
        sel.tracks[0].project.store.undoPoint();

        // And perform the filter
        await ffmpegFilter(opts, sel, d);

    }, {
        reuse: d
    });
}

/**
 * Register a custom filter.
 * @param filter  The filter.
 */
export function registerCustomFilter(filter: CustomFilter) {
    customFilters.push(filter);
}
