// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useState } from "react";
import type { AppState } from "@bivy/core";
import { controller } from "../store/useStore.js";
import { getSpeechPreferences, OPENAI_VOICES, setSpeechPreferences, SPEECH_TONES, type SpeechPreferences } from "../speech.js";

/** Voice settings are lazy-loaded because the voice lists and controls are not
 * needed on the initial chat route, keeping them out of the entry bundle. */
export function VoiceSettings({ state }: { state: AppState }) {
  const [speech, setSpeech] = useState<SpeechPreferences>(() => getSpeechPreferences());
  const [browserVoices, setBrowserVoices] = useState<SpeechSynthesisVoice[]>([]);
  useEffect(() => { controller.getSttConfig(); }, []);
  useEffect(() => {
    if (!("speechSynthesis" in window)) return;
    const refresh = () => setBrowserVoices(window.speechSynthesis.getVoices());
    refresh();
    window.speechSynthesis.addEventListener("voiceschanged", refresh);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", refresh);
  }, []);

  const updateSpeech = (patch: Partial<SpeechPreferences>) => {
    const next = { ...speech, ...patch };
    setSpeech(next);
    setSpeechPreferences(next);
  };
  const config = state.sttConfig;
  const providers = config?.providers ?? [];
  const openAiReady = providers.some((provider) => provider.id === "openai" && provider.configured);

  return (
    <div className="settings-form">
      <section className="settings-section">
        <h3>Voice input</h3>
        <p className="muted settings-intro">
          Dictate with the composer mic. Whisper converts speech to text using the same Groq or OpenAI key under
          <strong> Keys &amp; OAuth</strong>. With no key, supported browsers use built-in dictation.
        </p>
        <label className="field-label">Preferred transcription provider</label>
        <div className="seg-row">
          {providers.map((provider) => (
            <button key={provider.id} type="button" className={`seg-btn${config?.provider === provider.id ? " active" : ""}`} onClick={() => controller.setSttProvider(provider.id)}>
              {provider.label}
            </button>
          ))}
          {providers.length === 0 && <span className="muted">Loading…</span>}
        </div>
        {providers.map((provider) => (
          <div key={provider.id} className="voice-provider">
            <div className="voice-provider-head">
              <span className="field-label">{provider.label}</span>
              {provider.configured ? <span className="chip ok">Available</span> : <span className="chip">No account key</span>}
            </div>
            <div className="muted small">{provider.model} · Manage this key under Keys &amp; OAuth.</div>
          </div>
        ))}
      </section>

      <section className="settings-section">
        <h3>Read aloud</h3>
        <p className="muted settings-intro">Choose the reader used by the speaker button on assistant replies. OpenAI speech is higher quality; browser speech is free and stays on this device.</p>
        <label className="field-label" htmlFor="speech-reader">Reader</label>
        <select id="speech-reader" className="picker-search" value={speech.reader} onChange={(event) => updateSpeech({ reader: event.target.value as SpeechPreferences["reader"] })}>
          <option value="browser">Browser voice (free, on-device)</option>
          <option value="openai" disabled={!openAiReady}>OpenAI neural voice{openAiReady ? "" : " — add OpenAI key"}</option>
        </select>

        {speech.reader === "browser" ? (
          <>
            <label className="field-label" htmlFor="browser-reader-voice">Voice</label>
            <select id="browser-reader-voice" className="picker-search" value={speech.browserVoice} onChange={(event) => updateSpeech({ browserVoice: event.target.value })}>
              <option value="">System default</option>
              {browserVoices.map((voice) => <option key={voice.voiceURI} value={voice.voiceURI}>{voice.name} ({voice.lang})</option>)}
            </select>
            <label className="field-label" htmlFor="reader-speed">Speed · {speech.rate.toFixed(1)}×</label>
            <input id="reader-speed" type="range" min="0.7" max="1.5" step="0.1" value={speech.rate} onChange={(event) => updateSpeech({ rate: Number(event.target.value) })} />
          </>
        ) : (
          <>
            <label className="field-label" htmlFor="openai-reader-voice">Voice</label>
            <select id="openai-reader-voice" className="picker-search" value={speech.openaiVoice} onChange={(event) => updateSpeech({ openaiVoice: event.target.value })}>
              {OPENAI_VOICES.map((voice) => <option key={voice} value={voice}>{voice.charAt(0).toUpperCase() + voice.slice(1)}</option>)}
            </select>
            <label className="field-label" htmlFor="reader-tone">Tone</label>
            <select id="reader-tone" className="picker-search" value={speech.tone} onChange={(event) => updateSpeech({ tone: event.target.value as SpeechPreferences["tone"] })}>
              {SPEECH_TONES.map((tone) => <option key={tone.id} value={tone.id}>{tone.label}</option>)}
            </select>
            <div className="muted small">Uses gpt-4o-mini-tts and your existing OpenAI API key. Audio text is sent to OpenAI and may incur usage charges.</div>
          </>
        )}
      </section>
    </div>
  );
}
