// French Flashcards — audio module
//
// Speech is the browser's own speechSynthesis. There is no backend and no
// key: the Azure TTS and pronunciation-assessment endpoints (api/tts.js,
// api/pronounce.js) were unauthenticated proxies to the deploy owner's Azure
// subscription — anyone who found the URLs could bill them — and have been
// removed rather than secured. Browser speech was already the fallback and
// costs nothing.
//
// Two subsystems now:
//   1. speakFrench(text)  — browser speech synthesis, resolves when done
//   2. WavRecorder        — captures mic audio as 16kHz mono WAV (local only)
//
// The IndexedDB audio cache went with the MP3s it existed to cache.

// Clean text for cleaner TTS output: strip parentheticals, replace slashes
// with commas (so "le vendeur / la vendeuse" reads naturally), collapse spaces
function cleanForTts(text) {
  return text
    .replace(/\([^)]*\)/g, "")
    .replace(/\s*\/\s*/g, ", ")
    .replace(/\s+/g, " ")
    .trim();
}

export function stopSpeaking() {
  try {
    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
  } catch {}
}

// The browser's own speech synthesis — the only speech path there is now.
//
// This was written as the FALLBACK for Azure: without AZURE_SPEECH_KEY and
// AZURE_SPEECH_REGION, /api/tts answered 500 and the speaker button did
// nothing at all — no sound, no message, nothing to distinguish
// "misconfigured" from "broken" — so falling back meant the button always did
// something and a missing key cost only voice quality. That endpoint no longer
// exists (see the note at the top of this file), so there is nothing to fall
// back FROM. The reasoning is kept because it is still the argument for
// restoring Azure behind a fallback rather than in place of one.
//
// Resolves true if it actually spoke.
function speakWithBrowser(text) {
  return new Promise((resolve) => {
    const synth = typeof window !== "undefined" && window.speechSynthesis;
    if (!synth) return resolve(false);

    const speak = () => {
      try {
        synth.cancel();
        const utter = new SpeechSynthesisUtterance(text);
        utter.lang = "fr-FR";
        utter.rate = 0.95;
        const fr = (synth.getVoices() || []).find(
          (v) => v.lang && v.lang.toLowerCase().startsWith("fr")
        );
        // Without a French voice the platform reads French with an English
        // mouth, which is worse than useless for pronunciation practice.
        if (!fr) {
          console.warn("No French voice installed for browser speech.");
          return resolve(false);
        }
        utter.voice = fr;
        utter.onend = () => resolve(true);
        utter.onerror = () => resolve(false);
        synth.speak(utter);
      } catch {
        resolve(false);
      }
    };

    // getVoices() is empty until the list loads, on first call in most
    // browsers — wait for it once rather than deciding there are no voices.
    if ((synth.getVoices() || []).length > 0) return speak();
    let done = false;
    const onVoices = () => {
      if (done) return;
      done = true;
      synth.removeEventListener("voiceschanged", onVoices);
      speak();
    };
    synth.addEventListener("voiceschanged", onVoices);
    setTimeout(onVoices, 1200);
  });
}

// Speak French text. Resolves when playback ends.
//
// This used to call /api/tts, which proxied Azure Speech on the deploy
// owner's subscription — with no authentication, so anyone who found the URL
// could bill it. The endpoint is gone. The browser's own speech synthesis was
// already the fallback path and costs nothing, so it is now the only path.
//
// Bringing Azure back means restoring api/tts.js behind requireUser (and,
// if it should not be the owner paying, a per-user credential like the
// Anthropic one).
export async function speakFrench(text) {
  if (!text || typeof window === "undefined") return;
  const clean = cleanForTts(text);
  if (!clean) return;
  stopSpeaking();
  await speakWithBrowser(clean);
}

// ═══════════════════════════════════════════════════════════════════════════
// RECORDER — captures mic audio as 16kHz mono 16-bit PCM WAV
// ═══════════════════════════════════════════════════════════════════════════
//
// Why WAV directly instead of MediaRecorder webm? Because Azure's pronunciation
// assessment REST API only accepts WAV/PCM and OGG-Opus, and WebM (which is
// what MediaRecorder produces by default in Chrome) is neither — it's the same
// codec as OGG-Opus but a different container, so we can't just rename it.
// Capturing raw float32 samples and encoding WAV ourselves avoids any
// server-side conversion.

export class WavRecorder {
  constructor() {
    this.audioContext = null;
    this.mediaStream = null;
    this.processor = null;
    this.source = null;
    this.buffers = [];
    this.recording = false;
    this.startedAt = 0;
  }

  async start() {
    if (this.recording) return;

    // Request microphone (will prompt user for permission)
    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    // Create audio context. We pass a hint of 16kHz but browsers may use
    // their default (e.g., 48kHz on Mac). We resample to 16kHz on stop().
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    this.audioContext = new AudioCtx();
    this.source = this.audioContext.createMediaStreamSource(this.mediaStream);

    const bufferSize = 4096;
    // ScriptProcessorNode is deprecated but works everywhere we care about.
    // AudioWorklet is the modern replacement but requires a separate file.
    this.processor = this.audioContext.createScriptProcessor(bufferSize, 1, 1);
    this.buffers = [];
    this.processor.onaudioprocess = (e) => {
      if (!this.recording) return;
      const input = e.inputBuffer.getChannelData(0);
      // Copy because the input buffer is reused on the next callback
      this.buffers.push(new Float32Array(input));
    };

    this.source.connect(this.processor);
    this.processor.connect(this.audioContext.destination);
    this.recording = true;
    this.startedAt = Date.now();
  }

  // Returns a WAV Blob, or null if recording was empty
  async stop() {
    if (!this.recording) return null;
    this.recording = false;

    const sourceRate = this.audioContext.sampleRate;

    if (this.source) this.source.disconnect();
    if (this.processor) this.processor.disconnect();
    if (this.mediaStream) this.mediaStream.getTracks().forEach((t) => t.stop());

    // Concatenate captured buffers
    const totalLength = this.buffers.reduce((sum, b) => sum + b.length, 0);
    if (totalLength === 0) {
      this._cleanup();
      return null;
    }
    const merged = new Float32Array(totalLength);
    let offset = 0;
    for (const b of this.buffers) {
      merged.set(b, offset);
      offset += b.length;
    }

    // Resample to 16kHz (Azure's required rate)
    const resampled = sourceRate === 16000 ? merged : resample(merged, sourceRate, 16000);

    if (this.audioContext) {
      try {
        await this.audioContext.close();
      } catch {}
    }
    this._cleanup();

    return encodeWav(resampled, 16000);
  }

  _cleanup() {
    this.audioContext = null;
    this.mediaStream = null;
    this.processor = null;
    this.source = null;
    this.buffers = [];
  }

  durationSec() {
    return this.recording ? (Date.now() - this.startedAt) / 1000 : 0;
  }
}

// Linear interpolation resampling. Good enough for speech (16kHz target).
function resample(input, fromRate, toRate) {
  const ratio = fromRate / toRate;
  const newLength = Math.round(input.length / ratio);
  const output = new Float32Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const srcIdx = i * ratio;
    const idx0 = Math.floor(srcIdx);
    const idx1 = Math.min(idx0 + 1, input.length - 1);
    const frac = srcIdx - idx0;
    output[i] = input[idx0] * (1 - frac) + input[idx1] * frac;
  }
  return output;
}

// Encode Float32Array as 16-bit PCM WAV blob
function encodeWav(samples, sampleRate) {
  const numChannels = 1;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  // RIFF header
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, "WAVE");

  // fmt sub-chunk
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true); // PCM = 16
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample

  // data sub-chunk
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);

  // Write 16-bit PCM samples
  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PRONUNCIATION ASSESSMENT — sends WAV to backend, returns parsed scores
// ═══════════════════════════════════════════════════════════════════════════
//
// Returns an object shaped like:
//   {
//     transcribed: "le vendeur",
//     accuracy: 87,        // 0-100, how correctly each phoneme was pronounced
//     pronunciation: 85,   // 0-100, weighted overall score
//     completeness: 100,   // 0-100, did they say all the words
//     fluency: 88,         // 0-100, how natural the rhythm/pace is
//     words: [
//       { word: "le", accuracy: 92, errorType: "None", phonemes: [...] },
//       { word: "vendeur", accuracy: 84, errorType: "None", phonemes: [...] },
//     ],
//   }
//
// Or { error: "..." } on failure.

export async function assessPronunciation() {
  // /api/pronounce proxied Azure's pronunciation assessment, unauthenticated,
  // on the deploy owner's subscription. It has been removed. The UI that
  // called this is behind PRONUNCIATION_ENABLED, which is already false.
  return { error: "Pronunciation scoring is turned off." };
}

// ═══════════════════════════════════════════════════════════════════════════
// FEATURE DETECTION
// ═══════════════════════════════════════════════════════════════════════════

// Was `typeof Audio !== "undefined"`, which described playing an MP3 blob
// from Azure. What speaks now is speechSynthesis, so that is what to test —
// otherwise the speaker button renders on a browser that cannot use it.
export const TTS_AVAILABLE =
  typeof window !== "undefined" && "speechSynthesis" in window;

export const STT_AVAILABLE =
  typeof window !== "undefined" &&
  !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) &&
  !!(window.AudioContext || window.webkitAudioContext);

// Score → color helper for the UI
export function scoreColor(score) {
  if (score == null) return "#888";
  if (score >= 90) return "#2d6a4f"; // dark green
  if (score >= 75) return "#52b788"; // light green
  if (score >= 60) return "#b8860b"; // amber
  return "#c44536"; // red
}
