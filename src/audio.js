// French Flashcards — audio module
//
// Uses Azure Speech Services for high-quality TTS and pronunciation assessment.
// All API calls go through Vercel serverless functions; the Azure key never
// touches the browser.
//
// Three subsystems:
//   1. speakFrench(text)        — TTS with IndexedDB cache, returns when done
//   2. WavRecorder              — captures mic audio as 16kHz mono WAV
//   3. assessPronunciation(...) — sends WAV to backend, returns parsed scores

// ═══════════════════════════════════════════════════════════════════════════
// TTS — text-to-speech with persistent client-side cache
// ═══════════════════════════════════════════════════════════════════════════

const DB_NAME = "fc-audio";
const STORE = "tts";
const DB_VERSION = 1;

let _dbPromise = null;
function openDb() {
  if (_dbPromise) return _dbPromise;
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
  });
  return _dbPromise;
}

async function getCachedAudio(key) {
  try {
    const db = await openDb();
    if (!db) return null;
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

async function putCachedAudio(key, blob) {
  try {
    const db = await openDb();
    if (!db) return;
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(blob, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // cache failures are non-fatal
  }
}

// Clean text for cleaner TTS output: strip parentheticals, replace slashes
// with commas (so "le vendeur / la vendeuse" reads naturally), collapse spaces
function cleanForTts(text) {
  return text
    .replace(/\([^)]*\)/g, "")
    .replace(/\s*\/\s*/g, ", ")
    .replace(/\s+/g, " ")
    .trim();
}

let _currentAudio = null;
let _currentUrl = null;

export function stopSpeaking() {
  if (_currentAudio) {
    try {
      _currentAudio.pause();
      _currentAudio.currentTime = 0;
    } catch {}
    _currentAudio = null;
  }
  if (_currentUrl) {
    try {
      URL.revokeObjectURL(_currentUrl);
    } catch {}
    _currentUrl = null;
  }
  // The browser fallback is a separate audio channel — cancel it too, or the
  // two can talk over each other.
  try {
    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
  } catch {}
}

// The browser's own speech synthesis, used when Azure is unavailable.
//
// Azure gives far better French, but it needs AZURE_SPEECH_KEY and
// AZURE_SPEECH_REGION on the server. Without them /api/tts 500s and the
// speaker button did nothing at all — no sound, no message, nothing to
// distinguish "misconfigured" from "broken". Falling back means the button
// always does something, and the only cost of a missing key is voice quality.
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

// Speak French text. Returns a promise that resolves when playback ends.
// Uses cache when available. Falls back to browser speech if the TTS backend
// is unavailable; only throws nothing — failures are logged.
export async function speakFrench(text, voice = "fr-FR-DeniseNeural") {
  if (!text || typeof window === "undefined") return;
  const clean = cleanForTts(text);
  if (!clean) return;

  const cacheKey = `${voice}|${clean}`;

  let blob = await getCachedAudio(cacheKey);
  if (!blob) {
    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: clean, voice }),
      });
      if (!res.ok) {
        const err = await res.text().catch(() => "");
        console.error(
          `TTS API error ${res.status}: ${err} — falling back to browser speech.`
        );
        stopSpeaking();
        await speakWithBrowser(clean);
        return;
      }
      blob = await res.blob();
      // Fire-and-forget cache write
      putCachedAudio(cacheKey, blob);
    } catch (e) {
      console.error("TTS request failed, falling back to browser speech:", e);
      stopSpeaking();
      await speakWithBrowser(clean);
      return;
    }
  }

  // Stop any previous playback
  stopSpeaking();

  // Play the new audio
  return new Promise((resolve) => {
    try {
      const url = URL.createObjectURL(blob);
      _currentUrl = url;
      const audio = new Audio(url);
      _currentAudio = audio;
      const cleanup = () => {
        if (_currentUrl === url) {
          URL.revokeObjectURL(url);
          _currentUrl = null;
        }
        if (_currentAudio === audio) _currentAudio = null;
        resolve();
      };
      audio.onended = cleanup;
      audio.onerror = cleanup;
      audio.play().catch((e) => {
        console.error("Audio play() failed, falling back to browser speech:", e);
        cleanup();
        speakWithBrowser(clean);
      });
    } catch (e) {
      console.error("Audio setup failed:", e);
      resolve();
    }
  });
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

export async function assessPronunciation(audioBlob, referenceText, lang = "fr-FR") {
  // Strip parentheticals from the reference text — we don't want Azure
  // expecting the user to say "(adj)" out loud
  const cleanRef = referenceText
    .replace(/\([^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleanRef) return { error: "No reference text" };
  if (!audioBlob || audioBlob.size < 1000) return { error: "Recording too short" };

  const params = new URLSearchParams({ text: cleanRef, lang });

  try {
    const res = await fetch(`/api/pronounce?${params}`, {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: audioBlob,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return { error: err.error || `HTTP ${res.status}` };
    }
    const data = await res.json();
    return parseAssessment(data, cleanRef);
  } catch (e) {
    console.error("Pronunciation request failed:", e);
    return { error: e.message || "Request failed" };
  }
}

// Azure returns scores in TWO different shapes depending on which interface
// you use:
//
//   REST endpoint (cognitiveservices/v1, what we use):
//     NBest[0].AccuracyScore, .PronScore, .FluencyScore, .CompletenessScore,
//             .ProsodyScore   ← flat properties on NBest
//     Words[i].AccuracyScore, .ErrorType   ← also flat
//     Phonemes[i].AccuracyScore   ← also flat
//
//   Speech SDK (WebSocket):
//     NBest[0].PronunciationAssessment = { AccuracyScore, PronScore, ... }
//     Words[i].PronunciationAssessment = { AccuracyScore, ErrorType }
//     Phonemes[i].PronunciationAssessment = { AccuracyScore }
//
// `pick(obj, key)` looks at both — flat first, then the wrapper as fallback.
// This makes the parser tolerant if Azure ever changes shape on us, and lets
// us swap to the SDK later without rewriting this function.
//
// Additionally: French (and several other non-English locales) return EMPTY
// Phoneme strings — Azure doesn't have IPA labels for those locales. But
// Syllables[].Grapheme is populated ("vi", "vre", etc), so when phonemes
// lack labels we map syllables as the per-unit breakdown instead.
function pick(obj, key) {
  if (obj == null) return undefined;
  if (obj[key] != null) return obj[key];
  if (obj.PronunciationAssessment && obj.PronunciationAssessment[key] != null) {
    return obj.PronunciationAssessment[key];
  }
  return undefined;
}

function parseAssessment(data, refText) {
  if (data.RecognitionStatus && data.RecognitionStatus !== "Success") {
    return {
      error: data.RecognitionStatus === "InitialSilenceTimeout"
        ? "Didn't hear anything — try again"
        : data.RecognitionStatus,
    };
  }
  const best = Array.isArray(data.NBest) && data.NBest[0];
  if (!best) return { error: "No transcription returned" };

  const words = (best.Words || []).map((w) => {
    // Prefer real phonemes when Azure gave us labels; otherwise fall back to
    // syllables (Grapheme) so French has something to render.
    const rawPhonemes = w.Phonemes || [];
    const hasPhonemeLabels = rawPhonemes.some((p) => p.Phoneme && p.Phoneme.length > 0);

    let phonemes;
    if (hasPhonemeLabels) {
      phonemes = rawPhonemes.map((p) => ({
        phoneme: p.Phoneme,
        accuracy: round(pick(p, "AccuracyScore")),
      }));
    } else {
      // Syllable fallback for locales without phoneme labels (French et al)
      phonemes = (w.Syllables || []).map((s) => ({
        phoneme: s.Grapheme || s.Syllable || "·",
        accuracy: round(pick(s, "AccuracyScore")),
      }));
    }

    return {
      word: w.Word,
      accuracy: round(pick(w, "AccuracyScore")),
      errorType: pick(w, "ErrorType") || "None",
      phonemes,
    };
  });

  return {
    transcribed: best.Display || best.Lexical || "",
    referenceText: refText,
    accuracy: round(pick(best, "AccuracyScore")),
    pronunciation: round(pick(best, "PronScore") ?? pick(best, "PronunciationScore")),
    completeness: round(pick(best, "CompletenessScore")),
    fluency: round(pick(best, "FluencyScore")),
    prosody: round(pick(best, "ProsodyScore")),
    words,
  };
}

function round(n) {
  if (n == null) return null;
  return Math.round(n);
}

// ═══════════════════════════════════════════════════════════════════════════
// FEATURE DETECTION
// ═══════════════════════════════════════════════════════════════════════════

export const TTS_AVAILABLE =
  typeof window !== "undefined" && typeof Audio !== "undefined";

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
