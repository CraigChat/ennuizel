import { createWriteStream } from 'node:fs';
import { unlink, mkdir } from 'node:fs/promises';
import { pipeline } from 'node:stream';
import { promisify } from 'node:util';
import fetch from 'node-fetch';
import StreamZip from 'node-stream-zip';
import minimatch from 'minimatch';

const streamPipeline = promisify(pipeline);
const libavVersion = process.argv[2];
if (!libavVersion) throw new Error("No libav version was provided!");

try {
  await mkdir('./dist/libav');
} catch (e) {}

// Download ZIP
console.log('Downloading libav.js version', libavVersion);
const response = await fetch(`https://github.com/Yahweasel/libav.js/releases/download/v${libavVersion}/libav.js-${libavVersion}.zip`);
if (!response.ok) throw new Error(`unexpected response ${response.statusText}`);
await streamPipeline(response.body, createWriteStream('./libav.tmp.zip'));

// Extract
console.log('Reading ZIP')
const zip = new StreamZip.async({ file: './libav.tmp.zip' });
const entries = await zip.entries();
const allowedFiles = Object.keys(entries)
  .filter(minimatch.filter(`libav.js-${libavVersion}/libav-${libavVersion}-fat.*`, {matchBase: true}))
for (const file of allowedFiles) {
  console.log('Extracting', file)
  await zip.extract(file, `./dist/libav/${file.split('/')[1]}`);
}

await zip.close();
await unlink('./libav.tmp.zip');
console.log('OK');