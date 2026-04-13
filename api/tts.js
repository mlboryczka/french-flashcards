// Vercel serverless function: POST /api/tts
// Calls Azure Speech Synthesis to generate high-quality French TTS.
// Returns audio/mpeg (MP3) bytes.
//
// Body (JSON): { text: string, voice?: string }
// Default voice: fr-FR-DeniseNeural (most popular French neural voice)
//
// Environment variables:
//   AZURE_SPEECH_KEY     — primary key from Azure Portal → Speech Service → Keys
//   AZURE_SPEECH_REGION  — e.g., "francecentral", "eastus", "westeurope"

const ALLOWED_VOICES = new Set([
  "fr-FR-DeniseNeural", // female, friendly (default)
  "fr-FR-HenriNeural", // male, friendly
  "fr-FR-AlainNeural", // male, calm
  "fr-FR-BrigitteNeural", // female
  "fr-FR-CelesteNeural", // female
  "fr-FR-CoralieNeural", // female
  "fr-FR-EloiseNeural", // female, young
  "fr-FR-JacquelineNeural", // female
  "fr-FR-JeromeNeural", // male
  "fr-FR-JosephineNeural", // female
  "fr-FR-MauriceNeural", // male
  "fr-FR-YvesNeural", // male
  "fr-FR-YvetteNeural", // female
]);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { text, voice = "fr-FR-DeniseNeural" } = req.body || {};
  if (!text || typeof text !== "string") {
    return res.status(400).json({ error: "Missing text" });
  }
  if (text.length > 1000) {
    return res.status(400).json({ error: "Text too long (max 1000 chars)" });
  }
  if (!ALLOWED_VOICES.has(voice)) {
    return res.status(400).json({ error: "Invalid voice" });
  }

  const { AZURE_SPEECH_KEY, AZURE_SPEECH_REGION } = process.env;
  if (!AZURE_SPEECH_KEY || !AZURE_SPEECH_REGION) {
    return res
      .status(500)
      .json({ error: "Server misconfigured: missing AZURE_SPEECH_KEY or AZURE_SPEECH_REGION" });
  }

  // SSML body. Slight rate adjustment for slower clearer speech.
  const ssml = `<speak version='1.0' xml:lang='fr-FR'><voice xml:lang='fr-FR' name='${voice}'><prosody rate='-5%'>${escapeXml(text)}</prosody></voice></speak>`;

  try {
    const azureRes = await fetch(
      `https://${AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`,
      {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": AZURE_SPEECH_KEY,
          "Content-Type": "application/ssml+xml",
          "X-Microsoft-OutputFormat": "audio-24khz-96kbitrate-mono-mp3",
          "User-Agent": "french-flashcards",
        },
        body: ssml,
      }
    );

    if (!azureRes.ok) {
      const errText = await azureRes.text().catch(() => "");
      console.error("Azure TTS error:", azureRes.status, errText);
      return res
        .status(502)
        .json({ error: `TTS provider failed (${azureRes.status})` });
    }

    const audioBuffer = Buffer.from(await azureRes.arrayBuffer());
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.status(200).send(audioBuffer);
  } catch (e) {
    console.error("TTS request failed:", e);
    res.status(500).json({ error: "TTS request failed" });
  }
}

function escapeXml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
