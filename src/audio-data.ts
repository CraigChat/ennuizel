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

import * as avthreads from "./avthreads";
import * as id36 from "./id36";
import * as select from "./select";
import * as store from "./store";
import * as track from "./track";
import { WSPReadableStream, EZStream } from "./stream";
import * as ui from "./ui";

// Generalization of typed arrays
type TypedArray =
    Int8Array |
    Uint8Array |
    Int16Array |
    Uint16Array |
    Int32Array |
    Uint32Array |
    Float32Array |
    Float64Array;

/**
 * libav's sample formats.
 */
export enum LibAVSampleFormat {
    U8 = 0, S16, S32, FLT, DBL, U8P, S16P, S32P, FLTP, DBLP, S64, S64P
}

/**
 * The frame format given by libav.js
 */
export interface LibAVFrame {
    /**
     * The actual data. Note that in real libav.js frames, this could be an
     * array of typed arrays, if it's planar, but Ennuizel only handles
     * non-planar data.
     */
    data: TypedArray;

    /**
     * The sample rate.
     */
    sample_rate: number;

    /**
     * The sample format.
     */
    format: number;

    /**
     * The number of channels. Either this or channel_layout should be set.
     */
    channels?: number;

    /**
     * The layout of the channels. Either this or channels should be set.
     */
    channel_layout?: number;

    /**
     * The number of samples. This does not have to be set, and can be divined
     * from the length of data.
     */
    nb_samples?: number;

    /**
     * Not part of original libav.js, but provided by streams for tracks.
     */
    node?: AudioData;
}

const log2 = Math.log(2);

/**
 * Convert a (libav) format to its planar equivalent.
 * @param format  The input format, which may or may not be planar.
 */
export function toPlanar(format: number): number {
    switch (format) {
        case LibAVSampleFormat.U8:
        case LibAVSampleFormat.U8P:
            return LibAVSampleFormat.U8P;

        case LibAVSampleFormat.S16:
        case LibAVSampleFormat.S16P:
            return LibAVSampleFormat.S16P;

        case LibAVSampleFormat.S32:
        case LibAVSampleFormat.S32P:
            return LibAVSampleFormat.S32P;

        case LibAVSampleFormat.FLT:
        case LibAVSampleFormat.FLTP:
            return LibAVSampleFormat.FLTP;

        case LibAVSampleFormat.DBL:
        case LibAVSampleFormat.DBLP:
            return LibAVSampleFormat.DBLP;

        default:
            throw new Error("Unsupported format (to planar) " + format);
    }
}

/**
 * Convert a (libav) format to its non-planar equivalent.
 * @param format  The input format, which may or may not be planar.
 */
export function fromPlanar(format: number): number {
    switch (format) {
        case LibAVSampleFormat.U8:
        case LibAVSampleFormat.U8P:
            return LibAVSampleFormat.U8;

        case LibAVSampleFormat.S16:
        case LibAVSampleFormat.S16P:
            return LibAVSampleFormat.S16;

        case LibAVSampleFormat.S32:
        case LibAVSampleFormat.S32P:
            return LibAVSampleFormat.S32;

        case LibAVSampleFormat.FLT:
        case LibAVSampleFormat.FLTP:
            return LibAVSampleFormat.FLT;

        case LibAVSampleFormat.DBL:
        case LibAVSampleFormat.DBLP:
            return LibAVSampleFormat.DBL;

        default:
            throw new Error("Unsupported format (to planar) " + format);
    }
}

/**
 * Convert a number of channels to a channel layout.
 */
export function toChannelLayout(channels: number) {
    if (channels === 1)
        return 4;
    else
        return (1<<channels) - 1;
}

/**
 * Sanitize this libav.js frame, by setting any missing fields.
 */
export function sanitizeLibAVFrame(frame: LibAVFrame) {
    if (typeof frame.channels !== "number") {
        if (typeof frame.channel_layout !== "number") {
            // BAD! One should be set!
            frame.channels = 1;
        } else {
            let l = frame.channel_layout;
            let c = 0;
            while (l) {
                if (l&1) c++;
                l >>>= 1;
            }
            frame.channels = c;
        }
    }

    if (typeof frame.channel_layout !== "number")
        frame.channel_layout = toChannelLayout(frame.channels);

    if (typeof frame.nb_samples !== "number")
        frame.nb_samples = ~~(frame.data.length / frame.channels);
}

/**
 * Convert this LibAVFrame stream to the desired sample rate, format, and
 * channel count.
 * @param stream  Input LibAVFrame stream.
 * @param sampleRate  Desired sample rate.
 * @param format  Desired sample format.
 * @param channels  Desired channel count.
 * @param opts  Other options.
 */
export async function resample(
    stream: EZStream<LibAVFrame>, sampleRate: number, format: number,
    channels: number, opts: {
        fs?: string,
        reframe?: boolean
    } = {}
): Promise<ReadableStream<LibAVFrame>> {
    const first: LibAVFrame = await stream.read();
    if (!first) {
        // No need to filter nothing!
        return new WSPReadableStream<LibAVFrame>({
            start(controller) {
                controller.close();
            }
        });
    }
    stream.push(first);

    // Do we need to filter?
    sanitizeLibAVFrame(first);
    if (first.sample_rate === sampleRate &&
        first.format === format &&
        first.channels === channels &&
        !opts.fs &&
        !opts.reframe) {
        // Nope, already good!
        return new WSPReadableStream<LibAVFrame>({
            async pull(controller) {
                const chunk = await stream.read();
                if (chunk)
                    controller.enqueue(chunk);
                else
                    controller.close();
            }
        });
    }

    // OK, make the filter
    const libav = await avthreads.get();
    const frame = await libav.av_frame_alloc();
    const [filter_graph, buffersrc_ctx, buffersink_ctx] =
        await libav.ff_init_filter_graph(opts.fs || "anull", {
            sample_rate: first.sample_rate,
            sample_fmt: first.format,
            channel_layout: first.channel_layout
        }, {
            sample_rate: sampleRate,
            sample_fmt: format,
            channel_layout: toChannelLayout(channels),
            frame_size: ~~(first.sample_rate * 0.2)
        });

    // And the stream
    return new WSPReadableStream<LibAVFrame>({
        async pull(controller) {
            while (true) {
                const chunk = await stream.read();
                if (chunk)
                    chunk.node = null;

                const fframes = await libav.ff_filter_multi(buffersrc_ctx,
                    buffersink_ctx, frame, chunk ? [chunk] : [], !chunk);

                for (const frame of fframes)
                    controller.enqueue(frame);

                if (!chunk) {
                    controller.close();

                    await libav.avfilter_graph_free_js(filter_graph);
                    await libav.av_frame_free_js(frame);
                }

                if (!chunk || fframes.length)
                    break;
            }
        },

        async cancel() {
            await libav.avfilter_graph_free_js(filter_graph);
            await libav.av_frame_free_js(frame);
        }
    });
}

/**
 * An audio track. Audio data is stored in a tree of AudioData nodes. The
 * AudioTrack itself holds information such as the format (in libav format
 * codes), sample rate, and number of channels. AudioTracks are stored as
 * audio-track-id.
 */
export class AudioTrack implements track.Track {
    /**
     * Make an AudioTrack.
     * @param id  ID for this track. Must be unique in the store.
     * @param project  Project for this track. Note that the track is not
     *                 automatically added to the project's track list; this
     *                 parameter is just to know the store.
     * @param opts  Other options.
     */
    constructor(public id: string, public project: {store: store.UndoableStore}, opts: {
        name?: string,
        format?: number,
        sampleRate?: number,
        channels?: number
    } = {}) {
        // Main properties
        this.root = null;
        this.name = opts.name || "";
        this.format = opts.format || 4; // DBL
        this.sampleRate = opts.sampleRate || 48000;
        this.channels = opts.channels || 1;

        // UI
        this.spacer = ui.mk("div", ui.ui.main, {className: "track-spacer"});
        this.info = ui.mk("div", ui.ui.main, {className: "track-info"});
        this.display = ui.mk("div", ui.ui.main, {className: "track-display"});
        this.waveform = ui.mk("div", this.display, {className: "track-waveform"});

        select.addSelectable({
            track: this,
            wrapper: this.display,
            duration: this.duration.bind(this)
        });
    }

    /**
     * AudioTracks are track type Audio.
     */
    type() { return track.TrackType.Audio; }

    /**
     * Save this track to the store.
     * @param opts  Other options, in particular whether to perform a deep save
     *              (save all AudioDatas too).
     */
    async save(opts: {
        deep?: boolean
    } = {}) {
        const t = {
            name: this.name,
            format: this.format,
            sampleRate: this.sampleRate,
            channels: this.channels,
            data: <string[]> []
        };
        const d: AudioData[] = [];
        if (this.root)
            this.root.fillArray(d);

        // Fill in the data
        for (const el of d)
            t.data.push(el.id);

        // Save the track itself
        await this.project.store.setItem("audio-track-" + this.id, t);

        // Save the data itself
        if (opts.deep) {
            for (const el of d)
                await el.save();
        }
    }

    /**
     * Load this track from the store.
     */
    async load() {
        // Load the main data
        const t: any = await this.project.store.getItem("audio-track-" + this.id);
        if (!t) return;
        this.name = t.name || "";
        this.format = t.format;
        this.sampleRate = t.sampleRate;
        this.channels = t.channels;

        // Load each AudioData chunk
        const d: AudioData[] = [];
        for (const dataId of t.data) {
            const part = new AudioData(dataId, this);
            await part.load();
            d.push(part);
        }

        // Then make them a tree
        this.root = AudioData.balanceArray(d);
    }

    /**
     * Delete this track.
     */
    async del() {
        // First delete all the audio data
        const d: AudioData[] = [];
        if (this.root)
            this.root.fillArray(d);
        for (const ad of d)
            await ad.del();

        // Then delete this
        await this.project.store.removeItem("audio-track-" + this.id);

        // Remove it from the DOM
        try {
            this.spacer.parentNode.removeChild(this.spacer);
            this.info.parentNode.removeChild(this.info);
            this.display.parentNode.removeChild(this.display);
        } catch (ex) {}

        // Remove it as a selectable
        select.removeSelectable(this);
    }

    /**
     * Append data from a stream of raw data. The chunks must be LibAVFrames.
     * If they don't have the correct format, sample rate, or channel count,
     * they will be filtered, but this is only applied after the first has
     * arrived, so the caller can change the track properties before then.
     * @param rstream  The stream to read from.
     */
    async append(rstream: EZStream<LibAVFrame>) {
        const store = this.project.store;

        // Get the first data just to give them a chance to set up this track
        {
            const first = await rstream.read();
            if (first)
                rstream.push(first);
        }

        // Perhaps resample
        const stream = new EZStream(
            await resample(rstream, this.sampleRate, this.format,
                this.channels)
        );

        // Current AudioData we're appending to
        let cur: AudioData = null, raw: TypedArray;

        let chunk: LibAVFrame;
        while ((chunk = await stream.read()) !== null) {
            if (!cur) {
                // Append a new audio chunk to the tree
                if (!this.root) {
                    // As the root
                    cur = this.root = new AudioData(
                        await id36.genFresh(store, "audio-data-"),
                        this
                    );
                } else {
                    // As the rightmost child
                    cur = this.root;
                    while (cur.right)
                        cur = cur.right;
                    cur.right = new AudioData(
                        await id36.genFresh(store, "audio-data-"),
                        this
                    );
                    cur.right.parent = cur;
                    cur = cur.right;
                }

                // Allocate space
                raw = await cur.initRaw(chunk.data);
                await cur.save();
            }

            const remaining = raw.length - cur.len;

            if (remaining >= chunk.data.length) {
                // There's enough space for this chunk in full
                raw.set(chunk.data, cur.len);
                cur.len += chunk.data.length;

            } else {
                // Need to take part of the chunk
                raw.set(chunk.data.subarray(0, remaining), cur.len);
                cur.len = raw.length;
                if (chunk.data.length !== remaining) {
                    chunk.data = chunk.data.subarray(remaining);
                    stream.push(chunk);
                }
                await cur.closeRaw(true);
                cur = null;
                raw = null;

            }
        }

        // Close the last part
        if (cur) {
            await cur.closeRaw(true);
        }

        // Rebalance the tree now that we're done
        if (this.root)
            this.root = this.root.rebalance();

        await this.save();
    }

    /**
     * Append a single chunk of raw data.
     * @param data  The single chunk of data.
     */
    async appendRaw(data: TypedArray) {
        const stream = new EZStream(new WSPReadableStream({
            start(controller) {
                controller.enqueue(data);
                controller.close();
            }
        }));
        await this.append(stream);
    }

    /**
     * Get the duration, in seconds, of this track.
     */
    duration() {
        if (!this.root)
            return 0;
        return this.sampleCount() / this.channels / this.sampleRate;
    }

    /**
     * Get the number of samples in this track. This is, in essence, the
     * duration in samples times the number of channels.
     */
    sampleCount() {
        if (!this.root)
            return 0;
        return this.root.subtreeDuration();
    }

    /**
     * Get this data as a ReadableStream. Packets are sent roughly in libav.js
     * format, but with the AudioData node specified in a `node` field.
     * @param opts  Options. In particular, you can set the start and end time
     *              here.
     */
    stream(opts: {
        start?: number,
        end?: number,
        keepOpen?: boolean
    } = {}): ReadableStream<LibAVFrame> {
        // Calculate times
        const startSec = (typeof opts.start === "number") ? opts.start : 0;
        const endSec = (typeof opts.end === "number") ? opts.end : this.duration() + 2;
        const start = Math.floor(startSec * this.sampleRate) * this.channels;
        const end = Math.ceil(endSec * this.sampleRate) * this.channels;
        let remaining = end - start;

        // Now find the AudioData for this time
        const sd = this.root ? this.root.find(start) : null;

        if (!sd) {
            // No data, just give an empty stream
            return new WSPReadableStream({
                start(controller) {
                    controller.close();
                }
            });
        }

        let cur = sd.node;

        // Buffer the metadata
        const meta = {
            format: this.format,
            sample_rate: this.sampleRate,
            channels: this.channels,
            channel_layout: toChannelLayout(this.channels)
        };

        // Create the stream
        return new WSPReadableStream({
            async start(controller) {
                // Read the first part
                let buf = await cur.openRaw();
                if (!opts.keepOpen)
                    await cur.closeRaw();

                // Chop it to the right offset
                buf = buf.subarray(sd.offset);

                // Possibly chop it off at the end
                if (remaining < buf.length)
                    buf = buf.subarray(0, remaining);

                // And send it
                controller.enqueue(Object.assign({
                    data: buf,
                    node: cur
                }, meta));

                remaining -= buf.length;
                if (remaining <= 0)
                    controller.close();
            },

            async pull(controller) {
                // Move to the next part
                if (cur.right) {
                    // Down the right subtree
                    cur = cur.right;
                    while (cur.left)
                        cur = cur.left;

                } else {
                    // Have to move up the tree
                    while (true) {
                        const next = cur.parent;
                        if (!next) {
                            controller.close();
                            return;
                        }
                        if (next.left === cur) {
                            // Continue with this node
                            cur = next;
                            break;
                        } else /* next.right === cur */ {
                            // Already did this node, so keep going up
                            cur = next;
                        }
                    }

                }

                // Now give some data from this part
                let buf = await cur.openRaw();
                if (!opts.keepOpen)
                    await cur.closeRaw();

                if (buf.length > remaining)
                    buf = buf.subarray(0, remaining);

                controller.enqueue(Object.assign({
                    data: buf,
                    node: cur
                }, meta));

                // And move on
                remaining -= buf.length;
                if (remaining <= 0)
                    controller.close();
            }
        });
    }

    /**
     * Overwrite a specific range of data from a ReadableStream. The stream
     * must give TypedArray chunks, and must be of the same length as is being
     * overwritten. A stream() with keepOpen and an overwrite() with closeTwice
     * creates an effective filter.
     * @param data  Input data.
     * @param opts  Options. In particular, you can set the start and end time
     *              here.
     */
    async overwrite(data: EZStream<LibAVFrame>, opts: {
        start?: number,
        end?: number,
        closeTwice?: boolean
    } = {}) {
        // We have two streams, so we need to coordinate both of them
        let curOutNode: AudioData = null;
        let curOutRaw: TypedArray = null;
        let curOutPos = 0;
        let curOutRem = 0;
        let curInRaw: TypedArray = null;
        let curInPos = 0;
        let curInRem = 0;

        // Resample the data if needed
        const stream = await resample(data, this.sampleRate, this.format,
            this.channels);
        const dataRd = stream.getReader();

        /* The stream we're overwriting is actually an *input* stream; it gives
         * us a raw view into the buffer */
        const outStream = this.stream({
            start: opts.start,
            end: opts.end,
            keepOpen: true
        });
        const outRd = outStream.getReader();

        while (true) {
            // Get our output
            if (!curOutNode) {
                const curOut = await outRd.read();
                if (curOut.done) {
                    // We read all we could
                    break;
                }
                curOutNode = curOut.value.node;
                curOutRaw = curOut.value.data;
                curOutPos = 0;
                curOutRem = curOutRaw.length;

            }

            // Get our input
            if (!curInRaw) {
                const curIn = await dataRd.read();
                if (curIn.done) {
                    // End of input
                    if (curOutNode) {
                        await curOutNode.closeRaw(true);
                        if (opts.closeTwice)
                            await curOutNode.closeRaw();
                        curOutNode = curOutRaw = null;
                    }
                    break;
                }
                curInRaw = curIn.value.data;
                curInPos = 0;
                curInRem = curInRaw.length;
            }

            // Now we can transfer some data
            if (curInRem >= curOutRem) {
                // Finish an out buffer
                curOutRaw.set(
                    curInRaw.subarray(curInPos, curInPos + curOutRem),
                    curOutPos
                );
                curInPos += curOutRem;
                curInRem -= curOutRem;
                curOutRem = 0;

            } else {
                // Finish an in buffer
                curOutRaw.set(
                    curInRaw.subarray(curInPos),
                    curOutPos
                );
                curOutPos += curInRem;
                curOutRem -= curInRem;
                curInRem = 0;

            }

            // Close our input
            if (curInRem === 0)
                curInRaw = null;

            // Close our output
            if (curOutRem === 0) {
                await curOutNode.closeRaw(true);
                if (opts.closeTwice)
                    await curOutNode.closeRaw();
                curOutNode = null;
            }
        }

        // Make sure we finish off both streams
        while (true) {
            const curOut = await outRd.read();
            if (curOut.done)
                break;
            curOutNode = curOut.value.node;
            await curOutNode.closeRaw();
            if (opts.closeTwice)
                await curOutNode.closeRaw();
        }

        while (true) {
            const curIn = await dataRd.read();
            if (curIn.done)
                break;
        }

        await this.save();
    }

    /**
     * Replace a segment of audio data with the audio data from another track.
     * The other track will be deleted. Can clip (by not giving a replacement)
     * or insert (by replacing no time) as well.
     * @param start  Start time, in seconds.
     * @param end  End time, in seconds.
     * @param replacement  Track containing replacement data, which must be in
     *                     the same format, sample rate, number of tracks.
     */
    async replace(start: number, end: number, replacement: AudioTrack) {
        // We need to have *some* node to work with, so if we don't, make something up
        if (!this.root) {
            this.root = new AudioData(
                await id36.genFresh(this.project.store, "audio-data-"),
                this
            );
            this.root.initRaw(new Uint8Array(0)); /* Type doesn't matter since
                                                   * this data is being
                                                   * discarded */
        }

        // Convert times into track units
        start = Math.floor(start * this.sampleRate) * this.channels;
        end = Math.ceil(end * this.sampleRate) * this.channels;

        // 1: Find the start point
        let startLoc = this.root.find(start);
        if (!startLoc) {
            // Just place it at the end
            let startNode = this.root;
            while (startNode.right)
                startNode = startNode.right;
            startLoc = {offset: startNode.len, node: startNode};
        }
        const startNode = startLoc.node;
        const startRaw = await startNode.openRaw();

        // 2: Split the node
        const splitNext = new AudioData(
            await id36.genFresh(this.project.store, "audio-data-"),
            this, {insertAfter: startNode}
        );
        const splitNextRaw = await splitNext.initRaw(startRaw);
        splitNextRaw.set(
            startRaw.subarray(
                startLoc.offset, startNode.len));
        splitNext.len = startNode.len - startLoc.offset;
        startNode.len = startLoc.offset;
        await splitNext.closeRaw(true);
        await startNode.closeRaw(true);
        splitNext.right = startNode.right;
        if (splitNext.right)
            splitNext.right.parent = splitNext;
        startNode.right = splitNext;
        splitNext.parent = startNode;

        // 3: Clip the appropriate amount out
        let remaining = end - start;
        let cur = startLoc.node;
        while (remaining) {
            // Move to the next node
            if (cur.right) {
                cur = cur.right;
                while (cur.left)
                    cur = cur.left;

            } else {
                while (true) {
                    const next = cur.parent;
                    if (!next) {
                        cur = null;
                        break;
                    }
                    if (next.left === cur) {
                        // Continue with this node
                        cur = next;
                        break;
                    } else {
                        // Keep going up
                        cur = next;
                    }
                }
                if (!cur)
                    break;

            }

            // Remove (some of?) this node
            const raw = await cur.openRaw();
            if (remaining >= cur.len) {
                // Cut out this node entirely
                remaining -= cur.len;
                cur.len = 0;
            } else {
                // Just cut out part of it
                raw.set(raw.slice(remaining));
                cur.len -= remaining;
                remaining = 0;
            }
            await cur.closeRaw(true);
        }

        // 4: Steal the data from the other track
        const newData: AudioData[] = [];
        if (replacement) {
            replacement.root.fillArray(newData);
            replacement.root = null;
        }

        // 5: Insert it into ours
        cur = startLoc.node;
        for (const next of newData) {
            const nnext = new AudioData(next.id, this, {insertAfter: cur});
            await nnext.load();
            nnext.right = cur.right;
            nnext.right.parent = nnext;
            cur.right = nnext;
            nnext.parent = cur;
            cur = nnext;
        }

        // 6: Delete the other track
        if (replacement) {
            // FIXME: What if it's in a project?
            await replacement.del();
        }

        // 7: Sanitize our data
        const d: AudioData[] = [];
        this.root.fillArray(d);
        for (let i = d.length - 1; i >= 0; i--) {
            const el = d[i];
            if (el.len === 0) {
                await el.del();
                d.splice(i, 1);
            }
        }

        // 8: Rebalance our data
        this.root = AudioData.balanceArray(d);

        await this.save();
    }

    /**
     * Root of the AudioData tree.
     */
    private root: AudioData;

    /**
     * Display name for this track.
     */
    name: string;

    /**
     * Format of samples in this track, in libav format code.
     */
    format: number;

    /**
     * Sample rate of this track.
     */
    sampleRate: number;

    /**
     * Number of channels in this track.
     */
    channels: number;

    /**
     * UI spacer.
     */
    spacer: HTMLElement;

    /**
     * UI info box.
     */
    info: HTMLElement;

    /**
     * UI display box.
     */
    display: HTMLElement;

    /**
     * UI waveform wrapper within the display box.
     */
    waveform: HTMLElement;
}

/**
 * A single piece of audio data. Stored in the store as audio-data-id,
 * audio-data-compressed-id, and audio-data-wave-id.
 */
export class AudioData {
    /**
     * Create an AudioData.
     * @param id  ID for this AudioData. Must be unique in the store.
     * @param track  Track this AudioData belongs to. Note that setting it here
     *               does not actually add it to the track.
     */
    constructor(
        public id: string, public track: AudioTrack,
        opts: {insertAfter?: AudioData} = {}
    ) {
        this.pos = this.len = 0;
        this.raw = this.rawPromise = this.waveform = null;
        this.rawModified = false;
        this.readers = 0;
        this.parent = this.left = this.right = null;

        this.img = ui.mk("img", track.waveform);
        if (opts.insertAfter) {
            const before = opts.insertAfter.img.nextSibling;
            if (before && before !== this.img)
                track.waveform.insertBefore(this.img, before);
        }
    }

    /**
     * Save this AudioData. *Never* recurses: only saves *this* AudioData.
     */
    async save() {
        await this.track.project.store.setItem("audio-data-" + this.id, {
            len: this.len
        });
    }

    /**
     * Load this AudioData. Does not load the raw data, which will be loaded on
     * demand.
     */
    async load() {
        const store = this.track.project.store;
        const d: any = await store.getItem("audio-data-" + this.id);
        if (!d) return;
        this.len = d.len;

        // Waveform gets displayed immediately if applicable
        this.waveform = await store.getItem("audio-data-wave-" + this.id);
        if (this.waveform) {
            // FIXME: Duplication
            const w = ~~(this.len / this.track.channels / this.track.sampleRate * ui.pixelsPerSecond);
            Object.assign(this.img.style, {
                width: "calc(" + w + "px * var(--zoom-wave))",
                height: ui.trackHeight + "px"
            });
            this.img.src = URL.createObjectURL(this.waveform);
        }
    }

    /**
     * Delete this AudioData.
     */
    async del() {
        // Make sure it doesn't get written later
        this.readers = Infinity;

        // Remove the image
        try {
            this.img.parentNode.removeChild(this.img);
        } catch (ex) {}

        // Delete it from the store
        const store = this.track.project.store;
        await store.removeItem("audio-data-" + this.id);
        await store.removeItem("audio-data-wave-" + this.id);
    }

    /**
     * Rebalance the tree rooted at this node.
     */
    rebalance(): AudioData {
        // Convert the whole tree to an array
        const tarr: AudioData[] = [];
        this.fillArray(tarr);

        // Then turn the array back into a tree
        return AudioData.balanceArray(tarr);
    }

    /**
     * Convert this tree into an array, by filling the parameter.
     * @param arr  Array to fill.
     */
    fillArray(arr: AudioData[]) {
        if (this.left)
            this.left.fillArray(arr);
        arr.push(this);
        if (this.right)
            this.right.fillArray(arr);
    }

    /**
     * Create a balanced tree from an array of AudioData.
     */
    static balanceArray(arr: AudioData[]): AudioData {
        if (arr.length === 0)
            return null;

        // Find the middle node
        const mid = ~~(arr.length / 2);
        const root = arr[mid];
        root.parent = null;

        // Sort out its left
        root.left = AudioData.balanceArray(arr.slice(0, mid));
        if (root.left)
            root.left.parent = root;

        // Figure out the left duration to get its position
        root.pos = root.left ? root.left.subtreeDuration() : 0;

        // Then sort out the right
        root.right = AudioData.balanceArray(arr.slice(mid + 1));
        if (root.right)
            root.right.parent = root;

        return root;
    }

    /**
     * Get the duration, in samples, of the subtree rooted at this node. Note
     * that since this is just in raw, non-planar samples, if there's more than
     * one track, this number will effectively be multiplied by the number of
     * tracks.
     */
    subtreeDuration(): number {
        let cur: AudioData = this;
        let res = 0;
        while (cur) {
            res += cur.pos + cur.len;
            cur = cur.right;
        }
        return res;
    }

    /**
     * Get the audio node and offset for the desired sample.
     * @param sample  The sample to find.
     */
    find(sample: number) {
        let cur: AudioData = this;
        let offset = 0;
        while (cur) {
            if (cur.pos + offset <= sample) {
                // In this node or to the right
                if (cur.pos + offset + cur.len > sample) {
                    // In this node
                    return {
                        offset: sample - offset - cur.pos,
                        node: cur
                    };

                } else {
                    // To the right
                    offset += cur.pos + cur.len;
                    cur = cur.right;

                }

            } else {
                // To the left
                cur = cur.left;

            }
        }

        // Not found!
        return null;
    }

    /**
     * Get the raw audio data for this chunk. If it's not in memory, this will
     * involve uncompressing it. Each openRaw must be balanced with a closeRaw.
     */
    async openRaw(): Promise<TypedArray> {
        this.readers++;

        if (this.raw) {
            // Already exists
            return this.raw;
        }

        // See if somebody else is already doing this
        if (this.rawPromise) {
            await this.rawPromise;
            return this.raw;
        }

        // OK, do it ourself
        let rawRes: (x:any)=>unknown = null;
        this.rawPromise = new Promise(res => rawRes = res);

        const self = this;
        let rframes: any[];

        const libav = await avthreads.get();

        // Decompress it. First, read it all in.
        const wavpack = await self.track.project.store.getItem("audio-data-compressed-" + self.id);
        if (!wavpack) {
            // Whoops, make it up!
            rframes = [{data: new Float32Array(0)}];
            return;
        }
        const fn = "tmp-" + self.id + ".wv";
        await libav.writeFile(fn, wavpack);
        const [fmt_ctx, [stream]] = await libav.ff_init_demuxer_file(fn);
        const [, c, pkt, frame] = await libav.ff_init_decoder(stream.codec_id, stream.codecpar);
        const [, packets] = await libav.ff_read_multi(fmt_ctx, pkt);
        const frames = await libav.ff_decode_multi(c, pkt, frame, packets[stream.index], true);

        // Then convert it to a non-planar format
        const toFormat = fromPlanar(frames[0].format);
        const [filter_graph, buffersrc_ctx, buffersink_ctx] =
            await libav.ff_init_filter_graph("anull", {
                sample_rate: frames[0].sample_rate,
                sample_fmt: frames[0].format,
                channel_layout: frames[0].channel_layout
            }, {
                sample_rate: frames[0].sample_rate,
                sample_fmt: toFormat,
                channel_layout: frames[0].channel_layout
            });
        rframes = await libav.ff_filter_multi(buffersrc_ctx, buffersink_ctx, frame, frames, true);

        // Clean up
        await libav.avfilter_graph_free_js(filter_graph);
        await libav.ff_free_decoder(c, pkt, frame);
        await libav.avformat_close_input_js(fmt_ctx);
        await libav.unlink(fn);

        // And merge it into a single buffer
        let len = 0;
        for (const frame of rframes)
            len += frame.data.length;
        const ret = new (<any> rframes[0].data.constructor)(len);
        let offset = 0;
        for (const frame of rframes) {
            ret.set(frame.data, offset);
            offset += frame.data.length;
        }

        this.raw = ret;
        rawRes(null);
        this.rawPromise = null;
        return ret;
    }

    /**
     * Initialize a new raw buffer for this AudioData, of the type of the
     * buffer given. Use when an AudioData is created completely fresh, or is
     * about to be wholly overwritten. Also opens the raw, so make sure you
     * closeRaw when you're done.
     * @param exa  Example of the correct TypedArray format.
     */
    async initRaw(exa?: TypedArray) {
        this.raw = new (<any> exa.constructor)(
            this.track.channels * this.track.sampleRate * 30
        );
        return await this.openRaw();
    }

    /**
     * Close the raw data associated with this AudioData. When the last reader
     * closes, the data is compressed and rendered.
     * @param modified  Set to true if you've modified the data.
     */
    async closeRaw(modified = false) {
        this.rawModified = this.rawModified || modified;

        if (--this.readers <= 0) {
            this.readers = 0;
            if (this.rawModified) {
                await this.compress();
                await this.save();
            }
            this.raw = null;
            this.rawModified = false;
        }
    }

    // Compress and render this data, and store it
    private async compress() {
        if (this.len) {
            await this.wavpack(this.raw);
            await this.render(this.raw);
        }
    }

    // wavpack-compress this data
    private async wavpack(raw: TypedArray) {
        const libav = await avthreads.get();
        const track = this.track;
        const toFormat = toPlanar(track.format);
        const channel_layout = toChannelLayout(track.channels);

        // Prepare the encoder
        const [, c, frame, pkt, frame_size] = await libav.ff_init_encoder("wavpack", {
            sample_fmt: toFormat,
            sample_rate: track.sampleRate,
            channel_layout
        });
        const [oc, , pb] =
            await libav.ff_init_muxer({filename: this.id + ".wv", open: true},
                [[c, 1, track.sampleRate]]);
        await libav.avformat_write_header(oc, 0);

        // We also need to convert to the right sample format
        const [filter_graph, buffersrc_ctx, buffersink_ctx] =
            await libav.ff_init_filter_graph("anull", {
                sample_rate: track.sampleRate,
                sample_fmt: track.format,
                channel_layout
            }, {
                sample_rate: track.sampleRate,
                sample_fmt: toFormat,
                channel_layout,
                frame_size: frame_size
            });

        const frames = await libav.ff_filter_multi(buffersrc_ctx, buffersink_ctx, frame, [{
            data: raw.subarray(0, this.len),
            channel_layout,
            format: track.format,
            pts: 0,
            sample_rate: track.sampleRate
        }], true);

        const packets = await libav.ff_encode_multi(c, frame, pkt, frames, true);
        await libav.ff_write_multi(oc, pkt, packets);
        await libav.av_write_trailer(oc);

        await libav.avfilter_graph_free_js(filter_graph);
        await libav.ff_free_muxer(oc, pb);
        await libav.ff_free_encoder(c, frame, pkt);

        // Now it's been converted, so read it
        const u8 = await libav.readFile(this.id + ".wv");
        await libav.unlink(this.id + ".wv");

        // And save it to the store
        await track.project.store.setItem("audio-data-compressed-" + this.id, u8);
    }

    // Render the waveform for this data
    private async render(raw: TypedArray) {
        const libav = await avthreads.get();
        const track = this.track;
        const channel_layout = toChannelLayout(track.channels);
        const frame = await libav.av_frame_alloc();

        // Convert it to floating-point
        const [filter_graph, buffersrc_ctx, buffersink_ctx] =
            await libav.ff_init_filter_graph("anull", {
                sample_rate: track.sampleRate,
                sample_fmt: track.format,
                channel_layout
            }, {
                sample_rate: track.sampleRate,
                sample_fmt: libav.AV_SAMPLE_FMT_FLT,
                channel_layout: 4,
                frame_size: this.len
            });

        const [frameD] = await libav.ff_filter_multi(buffersrc_ctx, buffersink_ctx, frame, [{
            data: raw.subarray(0, this.len),
            channel_layout,
            format: track.format,
            pts: 0,
            sample_rate: track.sampleRate
        }], true);

        await libav.avfilter_graph_free_js(filter_graph);
        await libav.av_frame_free_js(frame);

        const data = frameD.data;

        // Figure out the image size
        const spp = ~~(track.sampleRate / ui.pixelsPerSecond);
        const w = Math.max(~~(data.length / track.sampleRate * ui.pixelsPerSecond), 1);

        // Make the canvas
        const canvas = ui.mk("canvas", null, {width: w, height: ui.trackHeight});
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 63, w, 2);
        ctx.fillStyle = "#0f0";

        // And draw it
        let max = -Infinity, min = Infinity;
        let x = 0, step = 0;
        for (let i = 0; i < data.length; i++) {
            max = Math.max(max, data[i]);
            min = Math.min(min, data[i]);

            if (++step === spp) {
                // Time to draw a column
                const dbishMax = Math.sign(max) * Math.log(Math.abs(max) + 1) / log2;
                const dbishMin = Math.sign(min) * Math.log(Math.abs(min) + 1) / log2;
                ctx.fillRect(x, ~~(ui.trackMiddle - dbishMax * ui.trackMiddle),
                    1, Math.max(~~((dbishMax - dbishMin) * ui.trackMiddle), 2));

                // Reset
                max = -Infinity;
                min = Infinity;
                x++;
                step = 0;
            }
        }

        // Now make it a PNG and save it
        this.waveform = await new Promise(res => canvas.toBlob(res));
        await this.track.project.store.setItem("audio-data-wave-" + this.id, this.waveform);

        // And make it an image
        Object.assign(this.img.style, {
            width: "calc(" + w + "px * var(--zoom-wave))",
            height: ui.trackHeight + "px"
        });
        this.img.src = URL.createObjectURL(this.waveform);
    }

    /**
     * Position of this AudioData *within this subtree*. Should be the same as
     * left.subtreeDuration().
     */
    pos: number;

    /**
     * Length of this AudioData in samples. The raw data may be overallocated,
     * so this is the true length.
     */
    len: number;

    /**
     * Raw data. May be overallocated, often unallocated. Will be set when
     * needed.
     */
    private raw: TypedArray;

    /**
     * Set temporarily when the raw data is being uncompressed, so that
     * multiple readers don't try to uncompress simultaneously.
     */
    private rawPromise: Promise<unknown>;

    /**
     * Set if the raw data has been modified, to ensure that it's saved.
     */
    private rawModified: boolean;

    // Waveform segment image
    private img: HTMLImageElement;

    // Waveform, as a png (blob)
    private waveform: Blob;

    // Number of raw audio readers
    private readers: number;

    // The tree itself
    parent: AudioData;
    left: AudioData;
    right: AudioData;
}
