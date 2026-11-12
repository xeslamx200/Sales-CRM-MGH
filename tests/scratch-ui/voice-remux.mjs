// SCRATCH-ONLY: records a real voice note in Chromium (fake microphone), repacks it with webmOpusToOgg and checks that the browser can decode the OGG
// and that its length matches the recording. No app, no network, nothing leaves this machine.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import http from "node:http";

const src = stripTypeScriptTypes(readFileSync(new URL("../../src/lib/audio/ogg-opus.ts", import.meta.url), "utf8"), { mode: "strip" })
  .replace(/export /g, "");
const browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
const ctx = await browser.newContext({ permissions: ["microphone"] });
const page = await ctx.newPage();
// getUserMedia needs a secure context: http://localhost counts
const server = http.createServer((_, res) => { res.setHeader("content-type", "text/html"); res.end("<!doctype html><title>t</title>"); }).listen(3398, "127.0.0.1");
await page.goto("http://localhost:3398/");
await page.addScriptTag({ content: `${src}\nwindow.webmOpusToOgg = webmOpusToOgg; window.isOggOpus = isOggOpus;` });
const r = await page.evaluate(async () => {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "";
  const rec = new MediaRecorder(stream, { mimeType: mime });
  const chunks = [];
  rec.ondataavailable = (e) => chunks.push(e.data);
  const stopped = new Promise((res) => (rec.onstop = res));
  rec.start();
  await new Promise((res) => setTimeout(res, 3000));
  rec.stop(); await stopped;
  const webm = new Uint8Array(await new Blob(chunks).arrayBuffer());
  const ogg = webmOpusToOgg(webm);
  const ac = new AudioContext();
  const decoded = await ac.decodeAudioData(ogg.buffer.slice(0));
  return { mime, webmBytes: webm.length, oggBytes: ogg.length, isOpus: isOggOpus(ogg), duration: decoded.duration, rate: decoded.sampleRate };
});
console.log(JSON.stringify(r));
const ok = r.isOpus && r.duration > 2.5 && r.duration < 3.6;
console.log(ok ? "PASS  Chromium decodes the repacked OGG/Opus with the right length" : "FAIL");
await browser.close(); server.close();
process.exit(ok ? 0 : 1);
