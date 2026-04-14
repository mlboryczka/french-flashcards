// Vercel serverless function: POST /api/pronounce
// Forwards a WAV recording to Azure Pronunciation Assessment and returns
// the detailed scores (per-word, per-phoneme).
//
// Query params:
//   text  — reference text the user was supposed to say (URL-encoded)
//   lang  — speech language, default "fr-FR"
//
// Body: raw WAV audio (16kHz, mono, 16-bit PCM). The bodyParser is disabled
// so we can stream raw bytes through.
//
// Environment variables:
//   AZURE_SPEECH_KEY     — same as TTS
//   AZURE_SPEECH_REGION  — same as TTS

export const config = {
  api: { bodyParser: false },
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { AZURE_SPEECH_KEY, AZURE_SPEECH_REGION } = process.env;
  if (!AZURE_SPEECH_KEY || !AZURE_SPEECH_REGION) {
    return res
      .status(500)
      .json({ error: "Server misconfigured: missing Azure Speech env vars" });
  }

  const refText = req.query.text;
  const lang = req.query.lang || "fr-FR";
  if (!refText || typeof refText !== "string") {
    return res.status(400).json({ error: "Missing reference text" });
  }
  if (refText.length > 500) {
    return res.status(400).json({ error: "Reference text too long" });
  }

  // Collect raw audio bytes from the request stream
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    chunks.push(chunk);
    totalBytes += chunk.length;
    if (totalBytes > 5 * 1024 * 1024) {
      return res.status(413).json({ error: "Recording too large (max 5MB)" });
    }
  }
  const audioBuffer = Buffer.concat(chunks);
  if (audioBuffer.length < 2000) {
    return res.status(400).json({ error: "Recording too short" });
  }

  // Build the assessment params header (base64-encoded JSON).
  //
  // CRITICAL: Dimension MUST be "Comprehensive" to get the full set of
  // scores back. Without it, Azure defaults to returning ONLY AccuracyScore
  // and silently omits FluencyScore, CompletenessScore, ProsodyScore, and
  // PronScore. This is documented in Microsoft's REST API reference but
  // not loudly enough — the omission causes the UI to render em-dashes
  // for everything except accuracy.
  //
  // Microsoft's canonical sample (from rest-speech-to-text-short docs):
  //   { ReferenceText, GradingSystem: "HundredMark", Granularity: "Word",
  //     Dimension: "Comprehensive", EnableProsodyAssessment: "True" }
  //
  // We use Granularity "Phoneme" to also get per-syllable / per-phoneme
  // scores. EnableMiscue stays a JSON boolean (works fine, doesn't need
  // to be the string "True" despite some MS samples using strings).
  const assessmentConfig = {
    ReferenceText: refText,
    GradingSystem: "HundredMark",
    Granularity: "Phoneme",
    Dimension: "Comprehensive",
    EnableMiscue: true,
    EnableProsodyAssessment: "True",
  };
  const assessmentB64 = Buffer.from(JSON.stringify(assessmentConfig)).toString(
    "base64"
  );

  try {
    const azureRes = await fetch(
      `https://${AZURE_SPEECH_REGION}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=${encodeURIComponent(lang)}&format=detailed`,
      {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": AZURE_SPEECH_KEY,
          "Content-Type": "audio/wav; codecs=audio/pcm; samplerate=16000",
          "Pronunciation-Assessment": assessmentB64,
          Accept: "application/json",
        },
        body: audioBuffer,
      }
    );

    const responseText = await azureRes.text();
    if (!azureRes.ok) {
      console.error(
        "Azure pronunciation error:",
        azureRes.status,
        responseText.slice(0, 500)
      );
      return res.status(502).json({
        error: `Assessment provider failed (${azureRes.status})`,
        details: responseText.slice(0, 200),
      });
    }

    let data;
    try {
      data = JSON.parse(responseText);
    } catch {
      return res
        .status(502)
        .json({ error: "Provider returned non-JSON response" });
    }

    // Debug logging — visible in Vercel function logs.
    // The REST endpoint puts scores FLAT on NBest[0], not inside a
    // PronunciationAssessment wrapper (that's the SDK shape).
    const nbest = data.NBest && data.NBest[0];
    console.log(
      "[pronounce] status:",
      data.RecognitionStatus,
      "| bytes:",
      audioBuffer.length,
      "| ref:",
      refText
    );
    console.log(
      "[pronounce] transcribed:",
      (nbest && (nbest.Display || nbest.Lexical)) || "(none)"
    );
    console.log(
      "[pronounce] scores:",
      nbest
        ? `acc=${nbest.AccuracyScore} pron=${nbest.PronScore} flu=${nbest.FluencyScore} comp=${nbest.CompletenessScore} pros=${nbest.ProsodyScore}`
        : "(MISSING)"
    );

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json(data);
  } catch (e) {
    console.error("Pronunciation request failed:", e);
    res.status(500).json({ error: "Request failed: " + (e.message || "unknown") });
  }
}
