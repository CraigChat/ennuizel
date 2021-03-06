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

/**
 * Convert a time in seconds to a string timestamp.
 * @param s  The time.
 * @param min  Show only the fields needed.
 */
export function timestamp(s: number, min?: boolean) {
    const h = ~~(s / 3600);
    s -= h * 3600;
    const m = ~~(s / 60);
    s -= m * 60;

    let hs = h + "";
    if (hs.length < 2) hs = "0" + hs;
    let ms = m + "";
    if (ms.length < 2) ms = "0" + ms;
    let ss = s.toFixed(3);
    if (s < 10) ss = "0" + ss;

    if (min) {
        // Minimize seconds by removing the decimal
        if (s === ~~s) {
            ss = s + "";
            if (s < 10) ss = "0" + ss;
        }

        // Give as little as needed
        if (h === 0) {
            if (m === 0) {
                return s.toString();
            } else {
                return `${m}:${ss}`;
            }
        } else {
            return `${h}:${ms}:${ss}`;
        }
    }

    return `${hs}:${ms}:${ss}`;
}
