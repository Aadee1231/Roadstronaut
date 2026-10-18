import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const sampleRate = 22050;
const workspace = mkdtempSync(join(tmpdir(), 'thrustshift-audio-'));
const outputDirectory = resolve('public/audio');
const tau = Math.PI * 2;

function writeWav(path, samples, channels = 1) {
  const dataSize = samples.length * 2;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  const pcm = Buffer.alloc(dataSize);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    pcm.writeInt16LE(Math.round(sample * 32767), index * 2);
  }
  writeFileSync(path, Buffer.concat([header, pcm]));
}

function encode(name, samples) {
  const wav = join(workspace, `${name}.wav`);
  const mp3 = join(outputDirectory, `${name}.mp3`);
  writeWav(wav, samples);
  const result = spawnSync('/usr/bin/ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', wav, '-codec:a', 'libmp3lame', '-b:a', '128k', mp3], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`ffmpeg failed for ${name}`);
}

function noiseAt(index) {
  let value = Math.imul(index ^ 0x6d2b79f5, 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value ^= value >>> 16;
  return (value >>> 0) / 2147483648 - 1;
}

function renderMusic({ bars, calm = false }) {
  const beatLength = 0.5;
  const duration = bars * 4 * beatLength;
  const samples = new Float32Array(Math.floor(duration * sampleRate));
  const chords = [
    { root: 55, notes: [110, 130.81, 164.81] },
    { root: 43.65, notes: [87.31, 110, 130.81] },
    { root: 65.41, notes: [130.81, 164.81, 196] },
    { root: 49, notes: [98, 123.47, 146.83] },
  ];
  const lead = [440, 523.25, 659.25, 587.33, 523.25, 392, 440, 523.25, 659.25, 783.99, 659.25, 587.33, 523.25, 440, 392, 349.23];
  const arpPattern = [0, 2, 1, 2, 0, 2, 1, 2];

  for (let index = 0; index < samples.length; index += 1) {
    const time = index / sampleRate;
    const beat = Math.floor(time / beatLength);
    const beatTime = time - beat * beatLength;
    const bar = Math.floor(beat / 4);
    const chord = chords[bar % chords.length];
    const halfBeat = Math.floor(beatTime / (beatLength / 2));
    let mixed = 0;

    if (beat % 4 === 0 || beat % 4 === 2) {
      const kickTime = beatTime;
      if (kickTime < 0.28) {
        const pitch = 105 - 55 * Math.min(1, kickTime / 0.11);
        mixed += Math.sin(tau * pitch * kickTime) * Math.exp(-kickTime * 17) * (calm ? 0.27 : 0.47);
      }
    }
    if (beat % 4 === 1 || beat % 4 === 3) {
      if (beatTime < 0.21) {
        const snareNoise = noiseAt(index) * Math.exp(-beatTime * 26);
        const snap = Math.sin(tau * 190 * beatTime) * Math.exp(-beatTime * 19);
        mixed += (snareNoise * 0.23 + snap * 0.15) * (calm ? 0.65 : 1);
      }
    }
    if (beatTime % (beatLength / 2) < 0.11) {
      mixed += noiseAt(index + 701) * Math.exp(-beatTime * 40) * (calm ? 0.055 : 0.09);
    }

    const arpIndex = (beat * 2 + halfBeat) % arpPattern.length;
    const bassHz = chord.root * (arpPattern[arpIndex] === 2 ? 2 : 1);
    const bassEnvelope = Math.min(1, beatTime * 40) * Math.exp(-beatTime * (calm ? 2.6 : 3.8));
    const bass = Math.sin(tau * bassHz * time) * 0.16 + Math.sin(tau * bassHz * 2 * time) * 0.045;
    const duck = 1 - 0.24 * Math.exp(-beatTime * 12);
    mixed += bass * bassEnvelope * duck;

    const chordTime = time - bar * 2;
    const padEnvelope = Math.min(1, chordTime * 1.8) * Math.min(1, (2 - chordTime) * 2.5);
    for (const note of chord.notes) {
      mixed += (Math.sin(tau * note * time) * 0.021 + Math.sin(tau * note * 1.005 * time) * 0.008) * padEnvelope;
    }

    const melodyBeat = beat % 16;
    if (melodyBeat % (calm ? 4 : 2) === 0) {
      const noteTime = beatTime;
      const leadHz = lead[(Math.floor(beat / (calm ? 2 : 1)) + bar * 3) % lead.length] * (calm ? 0.5 : 1);
      const leadEnvelope = Math.min(1, noteTime * 25) * Math.exp(-noteTime * (calm ? 4 : 5));
      const fundamental = Math.sin(tau * leadHz * time);
      const overtone = Math.sin(tau * leadHz * 2 * time) * 0.28;
      mixed += (fundamental + overtone) * leadEnvelope * (calm ? 0.09 : 0.14);
    }

    const edgeFade = Math.min(1, time * 80, (duration - time) * 80);
    samples[index] = Math.tanh(mixed * (calm ? 1.1 : 1.25)) * edgeFade * 0.84;
  }
  return samples;
}

function renderEffect(name, duration, sampleAt) {
  const samples = new Float32Array(Math.floor(duration * sampleRate));
  for (let index = 0; index < samples.length; index += 1) samples[index] = sampleAt(index / sampleRate, index);
  encode(name, samples);
}

try {
  encode('music-main', renderMusic({ bars: 32 }));
  encode('music-menu', renderMusic({ bars: 32, calm: true }));

  renderEffect('sfx-engine-loop', 2, (t) => (Math.sin(tau * 52 * t) * 0.32 + Math.sin(tau * 104 * t) * 0.11) * (0.48 + 0.12 * Math.sin(tau * t)));
  renderEffect('sfx-air-wind-loop', 2, (t, index) => noiseAt(index) * (0.15 + 0.12 * (0.5 + 0.5 * Math.sin(tau * t))));
  renderEffect('sfx-jump', 0.28, (t) => Math.sin(tau * (220 + 440 * t) * t) * Math.exp(-t * 9) * 0.45);
  renderEffect('sfx-super-launch', 0.8, (t) => Math.sin(tau * (100 + 300 * t) * t) * Math.exp(-t * 3.8) * 0.55 + Math.sin(tau * 620 * t) * Math.exp(-t * 8) * 0.16);
  renderEffect('sfx-rocket', 0.5, (t) => Math.sin(tau * (150 + 500 * t) * t) * Math.exp(-t * 5) * 0.35);
  renderEffect('sfx-flip', 0.15, (t) => Math.sin(tau * (780 + 900 * t) * t) * Math.exp(-t * 16) * 0.35);
  renderEffect('sfx-land', 0.32, (t, i) => (noiseAt(i) * 0.34 + Math.sin(tau * 82 * t) * 0.48) * Math.exp(-t * 12));
  renderEffect('sfx-perfect', 0.7, (t) => (Math.sin(tau * 880 * t) + Math.sin(tau * 1320 * t) * 0.5) * Math.exp(-t * 3.2) * 0.18);
  renderEffect('sfx-combo-up', 0.42, (t) => Math.sin(tau * (420 + 460 * t) * t) * Math.exp(-t * 4.5) * 0.3);
  renderEffect('sfx-near-miss', 0.55, (t, i) => (noiseAt(i) * 0.14 + Math.sin(tau * (280 + 160 * t) * t) * 0.32) * Math.exp(-t * 4));
  renderEffect('sfx-crash', 0.95, (t, i) => (noiseAt(i) * 0.42 + Math.sin(tau * (70 - 42 * t) * t) * 0.55) * Math.exp(-t * 2.8));
  renderEffect('sfx-ui-click', 0.09, (t) => Math.sin(tau * 720 * t) * Math.exp(-t * 34) * 0.22);
  renderEffect('sfx-ui-hover', 0.07, (t) => Math.sin(tau * 1040 * t) * Math.exp(-t * 42) * 0.11);
  renderEffect('sfx-new-best', 1.1, (t) => (Math.sin(tau * 523.25 * t) + Math.sin(tau * 659.25 * t) + Math.sin(tau * 783.99 * t)) * Math.exp(-t * 1.7) * 0.12);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
