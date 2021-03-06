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
import * as ui from "./ui";

let ac: AudioContext = null;

/**
 * Get the audio context.
 */
export async function getAudioContext() {
    if (!ac) {
        ac = new AudioContext();

        // Make sure it's running
        if (ac.state !== "running") {
            // First try to do it directly
            try {
                await ac.resume();
            } catch (ex) {}
        }

        if (ac.state !== "running") {
            // OK, ask nicely
            await ui.alert("This tool needs permission to play audio. Press OK to grant this permission.");
            try {
                await ac.resume();
            } catch (ex) {
                await ui.alert(ex + "");
            }
        }

        // Load in the AWP
        await ac.audioWorklet.addModule("ennuizel-player.js");
    }

    return ac;
}

/**
 * Create a source node for this stream of libav-like frames. Takes the reader,
 * so that the caller can cancel it.
 * @param stream  The input stream.
 */
export async function createSource(stream: ReadableStream, opts: {
    status?: (timestamp: number) => unknown,
    ready?: () => unknown,
    end?: () => unknown
} = {}) {
    const ac = await getAudioContext();
    const rdr = stream.getReader();

    // We need at least the first packet of data to create our filter
    let first = await rdr.read();
    if (first.done) {
        // Useless
        if (opts.ready)
            opts.ready();
        return {
            node: ac.createBufferSource(),
            // eslint-disable-next-line @typescript-eslint/no-empty-function
            start: ()=>{},
            // eslint-disable-next-line @typescript-eslint/no-empty-function
            stop: ()=>{}
        };
    }

    // Create the filter
    const libav = await avthreads.get();
    const frame = await libav.av_frame_alloc();
    const [filter_graph, buffersrc_ctx, buffersink_ctx] =
        await libav.ff_init_filter_graph("anull", {
            sample_rate: first.value.sample_rate,
            sample_fmt: first.value.format,
            channel_layout: first.value.channel_layout
        }, {
            sample_rate: ac.sampleRate,
            sample_fmt: audioData.LibAVSampleFormat.FLTP,
            channel_layout: 3
        });
    let finished = false;

    // Filter the first bit
    first.value.node = null;
    let firstFrames = await libav.ff_filter_multi(buffersrc_ctx, buffersink_ctx, frame, [first.value]);

    // Create the node
    const ret = new AudioWorkletNode(ac, "ennuizel-player", <any> {
        parameterData: {
            sampleRate: ac.sampleRate
        },
        outputChannelCount: [2]
    });

    // Send the first bit
    ret.port.postMessage({c: "data", d: firstFrames.map((x: any) => x.data)});
    first = firstFrames = null;

    // Associate its port with reading
    ret.port.onmessage = async function(ev) {
        if (ev.data.c === "time") {
            // Time update
            if (opts.status)
                opts.status(ev.data.d);
            return;

        } else if (ev.data.c === "ready") {
            // Ready to play
            if (opts.ready)
                opts.ready();
            return;

        } else if (ev.data.c === "done") {
            // Stream over
            if (opts.end)
                opts.end();
            return;

        } else if (ev.data.c !== "read") {
            // Unknown!
            return;

        }

        // Asking for more data
        const rawData = await rdr.read();
        if (rawData.done) {
            if (!finished) {
                finished = true;

                // Get any last input
                const frames = await libav.ff_filter_multi(buffersrc_ctx, buffersink_ctx, frame, [], true);
                ret.port.postMessage({
                    c: "data",
                    d: frames.length ? frames.map((x: any) => x.data) : null
                });

            } else {
                ret.port.postMessage({c: "data", d: null});

            }

        } else {
            rawData.value.node = null;
            const frames =
                await libav.ff_filter_multi(buffersrc_ctx, buffersink_ctx,
                    frame, [rawData.value]);
            ret.port.postMessage({c: "data", d: frames.map((x: any) => x.data)});

        }
    };

    return {
        node: ret,
        start() {
            ret.port.postMessage({c: "play"});
        },
        stop() {
            rdr.cancel();
            (async function() {
                await libav.av_frame_free_js(frame);
                await libav.avfilter_graph_free_js(filter_graph);
            })();
        }
    };
}
