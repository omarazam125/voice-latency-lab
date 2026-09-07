'use client';

import { useEffect, useState } from 'react';
import { serverUrl, useStore } from '../../lib/store';

type Tab =
  | 'agent'
  | 'pipeline'
  | 'stt'
  | 'vad'
  | 'llm'
  | 'tts'
  | 'rag'
  | 'audio'
  | 'advanced'
  | 'modec'
  | 'credentials';

export default function SettingsPage() {
  const config = useStore((s) => s.config);
  const status = useStore((s) => s.status);
  const updateConfig = useStore((s) => s.updateConfig);
  const [tab, setTab] = useState<Tab>('agent');
  const [defaults, setDefaults] = useState<any>(null);
  const [voices, setVoices] = useState<any[]>([]);
  const [prompt, setPrompt] = useState('');
  const [saved, setSaved] = useState(false);
  const [creds, setCreds] = useState({ openaiApiKey: '', speechmaticsApiKey: '', hamsaApiKey: '', hamsaSpeakerId: '' });
  const [credMsg, setCredMsg] = useState<string | null>(null);
  const [presets, setPresets] = useState<any[]>([]);

  useEffect(() => {
    fetch(`${serverUrl()}/api/defaults`)
      .then((r) => r.json())
      .then(setDefaults)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (config && !prompt) setPrompt(config.systemPrompt);
  }, [config, prompt]);

  useEffect(() => {
    fetch(`${serverUrl()}/api/modec/presets`)
      .then((r) => r.json())
      .then((d) => setPresets(d.presets ?? []))
      .catch(() => undefined);
  }, []);

  const applyPreset = async (presetId: string) => {
    await fetch(`${serverUrl()}/api/modec/preset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ presetId }),
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 1200);
  };

  const c = config ?? defaults?.config;
  if (!c) return <div className="card"><div className="empty">Loading configuration…</div></div>;

  const set = (patch: any) => {
    updateConfig(patch);
    setSaved(true);
    setTimeout(() => setSaved(false), 1200);
  };

  const loadVoices = async () => {
    const r = await fetch(`${serverUrl()}/api/voices`);
    const d = await r.json();
    setVoices(d.voices ?? []);
  };

  const saveCreds = async () => {
    const r = await fetch(`${serverUrl()}/api/credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(creds),
    });
    const d = await r.json();
    setCredMsg(r.ok ? 'Stored in server memory for this process only.' : d.error ?? 'Failed');
    setCreds({ openaiApiKey: '', speechmaticsApiKey: '', hamsaApiKey: '', hamsaSpeakerId: '' });
  };

  const TABS: Array<{ id: Tab; label: string }> = [
    { id: 'agent', label: 'Agent prompt' },
    { id: 'pipeline', label: 'Pipeline mode' },
    { id: 'stt', label: 'Speechmatics' },
    { id: 'vad', label: 'Turn detection' },
    { id: 'llm', label: 'OpenAI' },
    { id: 'tts', label: 'Hamsa' },
    { id: 'rag', label: 'RAG' },
    { id: 'audio', label: 'Audio' },
    { id: 'advanced', label: 'Chunker & speculative' },
    { id: 'modec', label: 'Mode C (Vapi-style)' },
    { id: 'credentials', label: 'Credentials' },
  ];

  return (
    <>
      <h1>Settings</h1>
      <p className="sub">
        Everything that affects latency is exposed here rather than hardcoded, so a naturalness/latency tradeoff can be
        benchmarked instead of assumed. Both modes share every one of these settings, so a comparison isolates the
        orchestration decision.
      </p>

      {saved && <div className="banner info">Applied.</div>}

      <div className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'agent' && (
        <div className="card">
          <h2>Agent system prompt</h2>
          <p className="hint" style={{ marginTop: 0, marginBottom: 10 }}>
            Paste the exact prompt your production call-centre agent uses. It is sent as the Responses API{' '}
            <code>instructions</code> field and is identical for both pipeline modes.
          </p>
          <textarea rows={20} dir="auto" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          <div className="row" style={{ marginTop: 10 }}>
            <button className="primary" onClick={() => set({ systemPrompt: prompt })}>
              Apply prompt
            </button>
            <button onClick={() => setPrompt(defaults?.prompts?.ar ?? '')}>Load Arabic sample</button>
            <button onClick={() => setPrompt(defaults?.prompts?.en ?? '')}>Load English sample</button>
            <span className="faint" style={{ fontSize: 12 }}>{prompt.length} characters</span>
          </div>
          <p className="hint">
            Prompt length affects input-token processing, but OpenAI's own guidance is that halving the prompt typically
            changes latency by only 1–5% — output length and reasoning effort matter far more.
          </p>
        </div>
      )}

      {tab === 'pipeline' && (
        <div className="split">
          <div className="card">
            <h2>Pipeline mode</h2>
            <div className="field">
              <label>Active mode</label>
              <div className="row">
                <button className={c.mode === 'B' ? 'primary' : ''} onClick={() => set({ mode: 'B' })}>
                  B — Ultra low latency
                </button>
                <button className={c.mode === 'C' ? 'primary' : ''} onClick={() => set({ mode: 'C' })}>
                  C — Vapi-style orchestration
                </button>
              </div>
            </div>
            <h3>Mode B — the streaming pipeline</h3>
            <p className="hint" style={{ marginTop: 0 }}>
              Proceeds from a stabilised partial transcript, prefetches retrieval speculatively, and hands short
              speakable phrases to Hamsa as soon as they exist so audio plays while the model is still generating.
            </p>
            <h3>Mode C — Vapi-style orchestration</h3>
            <p className="hint" style={{ marginTop: 0 }}>
              Everything Mode B does, plus a content-aware endpointing engine that picks the required silence from what
              the caller actually said, a voice chunk planner with flush support, conditional retrieval, and an
              interruption classifier that tells backchannels from real interruptions. Its settings live in the{' '}
              <strong>Mode C</strong> tab and apply only while this mode is active.
            </p>
          </div>
          <div className="card">
            <h2>Language</h2>
            <div className="field">
              <div className="row">
                <button className={c.language === 'ar' ? 'primary' : ''} onClick={() => set({ language: 'ar', stt: { language: 'ar' } })}>
                  Arabic
                </button>
                <button className={c.language === 'en' ? 'primary' : ''} onClick={() => set({ language: 'en', stt: { language: 'en' } })}>
                  English
                </button>
              </div>
              <div className="desc">Sets the Speechmatics language and switches the sample prompts and UI direction.</div>
            </div>
            {status && (
              <>
                <h3>Providers</h3>
                <dl className="kv">
                  <dt>STT</dt>
                  <dd>{status.providers.stt}</dd>
                  <dt>LLM</dt>
                  <dd>{status.providers.llm}</dd>
                  <dt>TTS</dt>
                  <dd>
                    {status.providers.tts} ({status.providers.ttsTransport})
                  </dd>
                  <dt>audio format</dt>
                  <dd>
                    {status.audioFormat.encoding} {status.audioFormat.sampleRate} Hz
                  </dd>
                </dl>
              </>
            )}
          </div>
        </div>
      )}

      {tab === 'stt' && (
        <div className="split">
          <div className="card">
            <h2>Speechmatics realtime</h2>
            <Num
              label="max_delay (seconds)"
              value={c.stt.maxDelay}
              min={0.7}
              max={4}
              step={0.1}
              onChange={(v) => set({ stt: { maxDelay: v } })}
              desc="Delay between the end of a spoken word and the FINAL transcript. Speechmatics documents a hard floor of 0.7 s, so any pipeline that waits for the final cannot start the LLM sooner than ~700 ms after the last word."
            />
            <Num
              label="end_of_utterance_silence_trigger (seconds, 0 disables)"
              value={c.stt.endOfUtteranceSilenceTrigger}
              min={0}
              max={2}
              step={0.1}
              onChange={(v) => set({ stt: { endOfUtteranceSilenceTrigger: v } })}
              desc="Provider-side endpointing. Kept below max_delay per Speechmatics guidance. Our own VAD is what actually triggers a turn; this is measured alongside it for comparison."
            />
            <div className="field">
              <label>Model</label>
              <select value={c.stt.model} onChange={(e) => set({ stt: { model: e.target.value } })}>
                <option value="standard">standard — fastest</option>
                <option value="enhanced">enhanced — most accurate</option>
              </select>
              <div className="desc">Feature-identical; they differ only in accuracy and throughput.</div>
            </div>
            <div className="field">
              <label>max_delay_mode</label>
              <select value={c.stt.maxDelayMode} onChange={(e) => set({ stt: { maxDelayMode: e.target.value } })}>
                <option value="flexible">flexible — waits for entities to complete</option>
                <option value="fixed">fixed — lower latency, worse number formatting</option>
              </select>
            </div>
            <Check
              label="enable_partials"
              value={c.stt.enablePartials}
              onChange={(v) => set({ stt: { enablePartials: v } })}
              desc="Partials typically arrive in under 500 ms and are unaffected by max_delay. Mode B depends on them."
            />
            <p className="hint">Changing any of these reopens the recognition session; the reconnect is recorded on the monitor.</p>
          </div>
          <div className="card">
            <h2>Vocabulary</h2>
            <div className="field">
              <label>Additional vocabulary (one per line)</label>
              <textarea
                rows={8}
                dir="auto"
                defaultValue={(c.stt.additionalVocab ?? []).join('\n')}
                onBlur={(e) => set({ stt: { additionalVocab: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) } })}
              />
              <div className="desc">
                Speechmatics warns of a latency and memory penalty here — expect up to 15 seconds of extra session setup.
                Setup cost is recorded separately from turn latency.
              </div>
            </div>
            <Num
              label="Punctuation sensitivity"
              value={c.stt.punctuationSensitivity}
              min={0}
              max={1}
              step={0.05}
              onChange={(v) => set({ stt: { punctuationSensitivity: v } })}
              desc="Higher values insert more punctuation, which directly affects where the chunker finds phrase boundaries."
            />
          </div>
        </div>
      )}

      {tab === 'vad' && (
        <div className="split">
          <div className="card">
            <h2>Turn detection</h2>
            <Num
              label="Silence threshold (ms)"
              value={c.vad.silenceThresholdMs}
              min={200}
              max={1200}
              step={10}
              range
              onChange={(v) => set({ vad: { silenceThresholdMs: v } })}
              desc="Trailing silence before the system declares the turn over. This is endpoint_detection_delay, and it is usually the single largest tunable contributor to perceived latency. 300–400 ms is the optimised target."
            />
            <Num
              label="Positive speech threshold"
              value={c.vad.positiveSpeechThreshold}
              min={0.1}
              max={0.95}
              step={0.05}
              range
              onChange={(v) => set({ vad: { positiveSpeechThreshold: v } })}
              desc="Probability at or above which a frame counts as speech."
            />
            <Num
              label="Negative speech threshold"
              value={c.vad.negativeSpeechThreshold}
              min={0.05}
              max={0.9}
              step={0.05}
              range
              onChange={(v) => set({ vad: { negativeSpeechThreshold: v } })}
              desc="Hysteresis: while already speaking, a frame stays speech until it drops below this."
            />
            <Num
              label="Minimum speech frames"
              value={c.vad.minSpeechFrames}
              min={1}
              max={15}
              step={1}
              onChange={(v) => set({ vad: { minSpeechFrames: v } })}
              desc="Frames of speech required to open a turn. Rejects clicks and coughs. One frame is 32 ms."
            />
          </div>
          <div className="card">
            <h2>Barge-in</h2>
            <Check
              label="Enable barge-in"
              value={c.vad.bargeInEnabled}
              onChange={(v) => set({ vad: { bargeInEnabled: v } })}
              desc="Speaking while the assistant is talking cancels the response. Playback stops locally and immediately — it does not wait for a server round trip."
            />
            <Num
              label="Barge-in speech frames"
              value={c.vad.bargeInSpeechFrames}
              min={1}
              max={15}
              step={1}
              onChange={(v) => set({ vad: { bargeInSpeechFrames: v } })}
              desc="Consecutive speech frames required before an interruption is declared. Lower is more responsive but more prone to false triggers from echo."
            />
            <p className="hint">
              Browser echo cancellation is enabled on the microphone. Without it the VAD hears the assistant through the
              speakers and fires a false barge-in on every reply.
            </p>
          </div>
        </div>
      )}

      {tab === 'llm' && (
        <div className="split">
          <div className="card">
            <h2>OpenAI</h2>
            <div className="field">
              <label>Model ID</label>
              <input type="text" defaultValue={c.llm.model} onBlur={(e) => set({ llm: { model: e.target.value.trim() } })} />
              <div className="desc">
                Free text — type any model id. Both modes must use the SAME model or the comparison is meaningless.
              </div>
            </div>
            <div className="row tight" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
              {(defaults?.models ?? []).map((m: any) => (
                <button key={m.id} className="sm" title={m.note} onClick={() => set({ llm: { model: m.id } })}>
                  {m.id}
                </button>
              ))}
            </div>
            <div className="field">
              <label>Reasoning effort</label>
              <select
                value={c.llm.reasoningEffort ?? ''}
                onChange={(e) => set({ llm: { reasoningEffort: e.target.value || null } })}
              >
                <option value="">(not sent)</option>
                {(defaults?.reasoningEfforts ?? []).map((r: string) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
              <div className="desc">
                The single biggest TTFT lever on a reasoning model. Use <code>none</code> for latency benchmarking. Not
                every model accepts every value — some reject <code>none</code> with a 400.
              </div>
            </div>
            <div className="field">
              <label>Verbosity</label>
              <select value={c.llm.verbosity ?? ''} onChange={(e) => set({ llm: { verbosity: e.target.value || null } })}>
                <option value="">(not sent)</option>
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
              </select>
              <div className="desc">Shorter output finishes sooner; it does not change time to FIRST token.</div>
            </div>
            <div className="field">
              <label>Service tier</label>
              <select value={c.llm.serviceTier ?? ''} onChange={(e) => set({ llm: { serviceTier: e.target.value || null } })}>
                <option value="">(not sent)</option>
                {(defaults?.serviceTiers ?? []).map((t: string) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <div className="desc">Documented as up to 2.5× faster on the fast/priority tiers, at a higher price.</div>
            </div>
          </div>
          <div className="card">
            <h2>Generation</h2>
            <Num
              label="Max output tokens"
              value={c.llm.maxOutputTokens}
              min={16}
              max={4096}
              step={16}
              onChange={(v) => set({ llm: { maxOutputTokens: v } })}
              desc="Caps total response length. Does not affect TTFS, only total response duration."
            />
            <div className="field">
              <label>Temperature</label>
              <div className="row">
                <input
                  type="number"
                  step={0.1}
                  min={0}
                  max={2}
                  value={c.llm.temperature ?? ''}
                  placeholder="(not sent)"
                  onChange={(e) => set({ llm: { temperature: e.target.value === '' ? null : Number(e.target.value) } })}
                />
                <button className="sm" onClick={() => set({ llm: { temperature: null } })}>
                  clear
                </button>
              </div>
              <div className="desc">Leave empty for reasoning models, which may reject it.</div>
            </div>
            <Num
              label="Conversation history turns"
              value={c.llm.historyTurns}
              min={0}
              max={20}
              step={1}
              onChange={(v) => set({ llm: { historyTurns: v } })}
              desc="Prior turns replayed to the model. History is placed BEFORE retrieved context so the cacheable prefix stays stable."
            />
            <Check
              label="store"
              value={c.llm.store}
              onChange={(v) => set({ llm: { store: v } })}
              desc="Whether OpenAI retains the response. Off by default here."
            />
          </div>
        </div>
      )}

      {tab === 'tts' && (
        <div className="split">
          <div className="card">
            <h2>Hamsa voice</h2>
            <div className="field">
              <label>Speaker (built-in name or cloned voice UUID)</label>
              <div className="row">
                <input type="text" defaultValue={c.tts.speaker} onBlur={(e) => set({ tts: { speaker: e.target.value.trim() } })} />
                <button className="sm" onClick={() => void loadVoices()}>
                  Load voices
                </button>
              </div>
              <div className="desc">
                A UUID is treated as a cloned voice and is preloaded at startup via the documented preload endpoint, so
                the first turn never pays the voice-model load cost.
              </div>
            </div>
            {voices.length > 0 && (
              <div className="row tight" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
                {voices.map((v) => (
                  <button key={v.id} className="sm" onClick={() => set({ tts: { speaker: v.name } })} title={`${v.language} ${v.gender ?? ''}`}>
                    {v.name} <span className="faint">{v.language}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="field">
              <label>Dialect</label>
              <select value={c.tts.dialect} onChange={(e) => set({ tts: { dialect: e.target.value } })}>
                {(defaults?.dialects ?? []).map((d: any) => (
                  <option key={d.code} value={d.code}>
                    {d.code} — {d.label}
                  </option>
                ))}
              </select>
            </div>
            <Num
              label="Expressiveness"
              value={c.tts.expressiveness}
              min={0}
              max={2}
              step={0.1}
              range
              onChange={(v) => set({ tts: { expressiveness: v } })}
              desc="0 flat, 1 natural, 2 highly expressive."
            />
          </div>
          <div className="card">
            <h2>Transport &amp; format</h2>
            <div className="field">
              <label>Realtime transport</label>
              <div className="row">
                <button className={c.tts.transport === 'websocket' ? 'primary' : ''} onClick={() => set({ tts: { transport: 'websocket' } })}>
                  WebSocket
                </button>
                <button className={c.tts.transport === 'http' ? 'primary' : ''} onClick={() => set({ tts: { transport: 'http' } })}>
                  HTTP chunked
                </button>
              </div>
              <div className="desc">
                <strong>WebSocket</strong>: one pre-warmed socket, no per-phrase handshake — but strictly sequential
                (frames carry no correlation id) and with no cancellation primitive.
                <br />
                <strong>HTTP chunked</strong>: real cancellation via request abort and overlapping phrases, at the cost of
                per-request setup. This is the transport Hamsa's own production integration uses. Benchmark both.
              </div>
            </div>
            <div className="field">
              <label>Sample rate</label>
              <select value={c.tts.sampleRate} disabled={c.tts.mulaw} onChange={(e) => set({ tts: { sampleRate: e.target.value } })}>
                <option value="16k">16 kHz</option>
                <option value="8k">8 kHz</option>
              </select>
              <div className="desc">PCM only. Mu-law output is always 8 kHz and cannot be combined with this.</div>
            </div>
            <Check
              label="mu-law (G.711, telephony)"
              value={c.tts.mulaw}
              onChange={(v) => set({ tts: { mulaw: v } })}
              desc="About 4× fewer bytes on the wire than 16-bit 16 kHz PCM. Forces 8 kHz."
            />
            <Num
              label="Max concurrent phrases (HTTP transport)"
              value={c.tts.maxConcurrentPhrases}
              min={1}
              max={4}
              step={1}
              onChange={(v) => set({ tts: { maxConcurrentPhrases: v } })}
              desc="Phrase N+1 can synthesise while N plays. Audio is still released strictly in order."
            />
          </div>
        </div>
      )}

      {tab === 'rag' && (
        <div className="split">
          <div className="card">
            <h2>Retrieval</h2>
            <Check
              label="Enable RAG"
              value={c.rag.enabled}
              onChange={(v) => set({ rag: { enabled: v } })}
              desc="Turn off to quantify exactly how much latency retrieval contributes. The Full pipeline benchmarks run both ways for you."
            />
            <Num label="Top K" value={c.rag.topK} min={1} max={20} step={1} onChange={(v) => set({ rag: { topK: v } })} />
            <Num
              label="Minimum score"
              value={c.rag.minScore}
              min={0}
              max={1}
              step={0.01}
              onChange={(v) => set({ rag: { minScore: v } })}
              desc="Floor on the NORMALISED score. Weak as a relevance gate: the score is divided by the best hit, so the top result is always 1.0 and this can never reject it. Use minimum coverage below instead."
            />
            <Num
              label="Minimum coverage"
              value={c.rag.minCoverage}
              min={0}
              max={1}
              step={0.05}
              onChange={(v) => set({ rag: { minCoverage: v } })}
              desc="The real relevance gate: the share of the question's meaning (IDF-weighted) a passage has to account for. At 0 an off-topic question still retrieves three confident-looking passages, and the agent answers a question nobody asked. Raising it makes the agent fall back instead — safer than confidently answering from unrelated text."
            />
            <Num
              label="Max context characters"
              value={c.rag.maxContextChars}
              min={200}
              max={20000}
              step={100}
              onChange={(v) => set({ rag: { maxContextChars: v } })}
              desc="Retrieved context is placed after the history so the cacheable prompt prefix stays stable."
            />
          </div>
          <div className="card">
            <h2>Speculative retrieval (Mode B)</h2>
            <Check
              label="Prefetch on stabilised partials"
              value={c.rag.prefetchEnabled}
              onChange={(v) => set({ rag: { prefetchEnabled: v } })}
              desc="Starts retrieval before the user has finished, using a partial transcript that has stopped changing. On a hit, retrieval contributes zero to the critical path."
            />
            <Num
              label="Partial stability window (ms)"
              value={c.rag.partialStabilityMs}
              min={50}
              max={800}
              step={10}
              range
              onChange={(v) => set({ rag: { partialStabilityMs: v } })}
              desc="How long a partial must be unchanged before it is treated as stable."
            />
            <Num
              label="Prefetch reuse threshold"
              value={c.rag.prefetchReuseThreshold}
              min={0.3}
              max={1}
              step={0.05}
              range
              onChange={(v) => set({ rag: { prefetchReuseThreshold: v } })}
              desc="Similarity above which the prefetched result is reused for the final query. Too high wastes prefetches; too low answers the wrong question."
            />
          </div>
        </div>
      )}

      {tab === 'audio' && (
        <div className="card">
          <h2>Audio</h2>
          <div className="split">
            <div>
              <Num
                label="Jitter buffer (ms)"
                value={c.audio.jitterBufferMs}
                min={0}
                max={500}
                step={5}
                range
                onChange={(v) => set({ audio: { jitterBufferMs: v } })}
                desc="Audio buffered in the browser before playback starts. This is a DIRECT addition to time to first speech, traded against underrun risk. It is the only deliberate delay in the playback path."
              />
              <Num
                label="Max playback queue (ms)"
                value={c.audio.maxQueueMs}
                min={1000}
                max={60000}
                step={500}
                onChange={(v) => set({ audio: { maxQueueMs: v } })}
                desc="Hard bound on queued audio. Beyond it the oldest audio is dropped rather than letting playback drift ever further behind the conversation."
              />
            </div>
            <div>
              <Num
                label="Microphone frame size (ms)"
                value={c.audio.micFrameMs}
                min={10}
                max={100}
                step={5}
                range
                onChange={(v) => set({ audio: { micFrameMs: v } })}
                desc="PCM frame size sent to the server. 20 ms is the target: small enough to be genuinely continuous, large enough not to flood the socket."
              />
              <p className="hint">
                Audio travels as binary WebSocket frames with a 24-byte header in both directions. It is never
                base64-encoded or wrapped in JSON, which would inflate every frame by about a third.
              </p>
            </div>
          </div>
        </div>
      )}

      {tab === 'advanced' && (
        <div className="split">
          <div className="card">
            <h2>Streaming chunker (Mode B)</h2>
            <p className="hint" style={{ marginTop: 0 }}>
              Controls when partially-generated text becomes speakable. The first phrase is intentionally more aggressive
              than later ones because first-audio latency matters most.
            </p>
            <h3>First phrase</h3>
            <ChunkFields
              p={c.chunker.B.first}
              onChange={(patch) => set({ chunker: { B: { first: patch } } })}
            />
            <h3>Subsequent phrases</h3>
            <ChunkFields
              p={c.chunker.B.subsequent}
              onChange={(patch) => set({ chunker: { B: { subsequent: patch } } })}
            />
          </div>
          <div className="card">
            <h2>Speculative generation</h2>
            <div className="banner warn" style={{ fontSize: 12 }}>
              Experimental. When enabled, the LLM may be called before the turn is confirmed and cancelled if the
              transcript changes materially. Wasted requests are recorded and displayed, never hidden.
            </div>
            <Check
              label="Enable speculative generation"
              value={c.speculative.enabled}
              onChange={(v) => set({ speculative: { enabled: v } })}
            />
            <Check
              label="Pre-emptive LLM request"
              value={c.speculative.preemptiveLlm}
              onChange={(v) => set({ speculative: { preemptiveLlm: v } })}
              desc="Start generation before endpoint confirmation. Measures how much endpointing latency can be hidden."
            />
            <Num
              label="Stability window (ms)"
              value={c.speculative.stabilityMs}
              min={50}
              max={1000}
              step={10}
              onChange={(v) => set({ speculative: { stabilityMs: v } })}
            />
            <Num
              label="Minimum words"
              value={c.speculative.minWords}
              min={1}
              max={20}
              step={1}
              onChange={(v) => set({ speculative: { minWords: v } })}
            />
            <Num
              label="Divergence threshold"
              value={c.speculative.divergenceThreshold}
              min={0.05}
              max={0.9}
              step={0.05}
              range
              onChange={(v) => set({ speculative: { divergenceThreshold: v } })}
              desc="Normalised difference above which the speculative request is discarded and restarted."
            />
          </div>
        </div>
      )}

      {tab === 'modec' && (
        <>
          <div className="banner info" style={{ fontSize: 12 }}>
            These settings apply <strong>only while Mode C is active</strong> (currently <strong>Mode {c.mode}</strong>).
            They are stored regardless, so switching away and back preserves them, and Modes A and B are completely
            unaffected by anything here.
          </div>

          <div className="card" style={{ marginBottom: 12 }}>
            <div className="row" style={{ marginBottom: 8 }}>
              <h2 style={{ margin: 0 }}>Presets</h2>
              <div className="spacer" />
              <span className="faint" style={{ fontSize: 11 }}>applies a whole timing profile at once</span>
            </div>
            <div className="row tight" style={{ flexWrap: 'wrap' }}>
              {(presets ?? []).map((p: any) => (
                <button key={p.id} className="sm" title={p.description} onClick={() => void applyPreset(p.id)}>
                  {p.label}
                </button>
              ))}
            </div>
            <p className="hint">
              The <strong>VAD silence only</strong> preset disables the smart path entirely, so Mode C uses the same
              fixed timer as Modes A and B. Run it to isolate exactly what the endpointing engine is worth.
            </p>
          </div>

          <div className="split" style={{ marginBottom: 12 }}>
            <div className="card">
              <h2>Endpointing engine</h2>
              <div className="field">
                <label>Strategy</label>
                <select
                  value={c.modeC.endpointing.strategy}
                  onChange={(e) => set({ modeC: { endpointing: { strategy: e.target.value } } })}
                >
                  <option value="vapi_transcription">vapi_transcription — content-aware timers</option>
                  <option value="hybrid">hybrid — content-aware with a VAD ceiling</option>
                  <option value="vad_silence">vad_silence — fixed timer (control)</option>
                </select>
                <div className="desc">
                  A fixed timer must be set for the worst case, so short questions wait as long as someone reading an
                  account number. The content-aware strategies pick the required silence from what was actually said.
                </div>
              </div>
              <Num
                label="waitSeconds — minimum silence before any commit"
                value={c.modeC.endpointing.waitSeconds}
                min={0} max={5} step={0.05} range
                onChange={(v) => set({ modeC: { endpointing: { waitSeconds: v } } })}
                desc="Documented default 0.4 s, range 0-5. The floor that guards against committing on a mid-sentence pause."
              />
              <Num
                label="onPunctuationSeconds — transcript ends in . ? ! or ؟"
                value={c.modeC.endpointing.onPunctuationSeconds}
                min={0} max={3} step={0.05} range
                onChange={(v) => set({ modeC: { endpointing: { onPunctuationSeconds: v } } })}
                desc="Documented default 0.1 s. The thought looks complete, so commit almost immediately."
              />
              <Num
                label="onNoPunctuationSeconds — no punctuation at all"
                value={c.modeC.endpointing.onNoPunctuationSeconds}
                min={0} max={5} step={0.1} range
                onChange={(v) => set({ modeC: { endpointing: { onNoPunctuationSeconds: v } } })}
                desc="Documented default 1.5 s. Ambiguous, so fall back to the long timer."
              />
              <Num
                label="onNumberSeconds — transcript ends in a number"
                value={c.modeC.endpointing.onNumberSeconds}
                min={0} max={5} step={0.05} range
                onChange={(v) => set({ modeC: { endpointing: { onNumberSeconds: v } } })}
                desc="Documented default 0.5 s. Longer than punctuation: a caller reading digits pauses between groups."
              />
              <Num
                label="maxWaitSeconds — absolute ceiling"
                value={c.modeC.endpointing.maxWaitSeconds}
                min={0.3} max={10} step={0.1}
                onChange={(v) => set({ modeC: { endpointing: { maxWaitSeconds: v } } })}
                desc="The turn commits after this no matter what, so it can never hang."
              />
              <Num
                label="Transcript stability window (ms)"
                value={c.modeC.endpointing.transcriptStabilityMs}
                min={20} max={2000} step={10} range
                onChange={(v) => set({ modeC: { endpointing: { transcriptStabilityMs: v } } })}
                desc="How long a partial must be unchanged before it counts as settled."
              />
              <Num
                label="Minimum stability score for an early commit"
                value={c.modeC.endpointing.minStabilityScore}
                min={0} max={1} step={0.05} range
                onChange={(v) => set({ modeC: { endpointing: { minStabilityScore: v } } })}
                desc="Punctuation on a transcript that is still being revised is not yet trustworthy. A false endpoint cuts the caller off, so this is the safety valve."
              />
            </div>

            <div className="card">
              <h2>Voice chunk plan</h2>
              <Check
                label="Chunking enabled"
                value={c.modeC.chunkPlan.enabled}
                onChange={(v) => set({ modeC: { chunkPlan: { enabled: v } } })}
                desc="Off means the whole response is synthesised in one request, which pushes first audio far later."
              />
              <Num
                label="minCharacters (baseline)"
                value={c.modeC.chunkPlan.minCharacters}
                min={1} max={500} step={1}
                onChange={(v) => set({ modeC: { chunkPlan: { minCharacters: v } } })}
                desc="Documented default 30."
              />
              <h3>First chunk — latency-critical</h3>
              <div className="grid cols-2" style={{ gap: 8 }}>
                <Num label="min characters" value={c.modeC.chunkPlan.first.minCharacters} min={1} max={300} step={1}
                  onChange={(v) => set({ modeC: { chunkPlan: { first: { minCharacters: v } } } })} />
                <Num label="preferred characters" value={c.modeC.chunkPlan.first.preferredCharacters} min={1} max={400} step={1}
                  onChange={(v) => set({ modeC: { chunkPlan: { first: { preferredCharacters: v } } } })} />
                <Num label="min words" value={c.modeC.chunkPlan.first.minWords} min={1} max={30} step={1}
                  onChange={(v) => set({ modeC: { chunkPlan: { first: { minWords: v } } } })} />
                <Num label="max wait (ms)" value={c.modeC.chunkPlan.first.maxWaitMs} min={0} max={2000} step={10}
                  onChange={(v) => set({ modeC: { chunkPlan: { first: { maxWaitMs: v } } } })} />
              </div>
              <h3>Subsequent chunks — naturalness matters more</h3>
              <div className="grid cols-2" style={{ gap: 8 }}>
                <Num label="min characters" value={c.modeC.chunkPlan.subsequent.minCharacters} min={1} max={500} step={5}
                  onChange={(v) => set({ modeC: { chunkPlan: { subsequent: { minCharacters: v } } } })} />
                <Num label="max characters" value={c.modeC.chunkPlan.subsequent.maxCharacters} min={1} max={800} step={5}
                  onChange={(v) => set({ modeC: { chunkPlan: { subsequent: { maxCharacters: v } } } })} />
                <Num label="min words" value={c.modeC.chunkPlan.subsequent.minWords} min={1} max={60} step={1}
                  onChange={(v) => set({ modeC: { chunkPlan: { subsequent: { minWords: v } } } })} />
                <Num label="max words" value={c.modeC.chunkPlan.subsequent.maxWords} min={1} max={100} step={1}
                  onChange={(v) => set({ modeC: { chunkPlan: { subsequent: { maxWords: v } } } })} />
              </div>
              <Check
                label="Honour inline flush markers"
                value={c.modeC.chunkPlan.flushEnabled}
                onChange={(v) => set({ modeC: { chunkPlan: { flushEnabled: v } } })}
                desc={FLUSH_DESC}
              />
            </div>
          </div>

          <div className="split" style={{ marginBottom: 12 }}>
            <div className="card">
              <h2>Retrieval strategy</h2>
              <div className="field">
                <label>Strategy</label>
                <select
                  value={c.modeC.rag.strategy}
                  onChange={(e) => set({ modeC: { rag: { strategy: e.target.value } } })}
                >
                  <option value="serial">serial — endpoint, transcript, retrieve, then generate</option>
                  <option value="prefetch">prefetch — speculative retrieval on a stable partial</option>
                  <option value="conditional">conditional — skip retrieval when the turn does not need it</option>
                </select>
                <div className="desc">
                  Conditional classifies the turn first. Spending 500 ms retrieving documents to answer a greeting is
                  pure latency for zero benefit.
                </div>
              </div>
              <Num
                label="Prefetch reuse threshold"
                value={c.modeC.rag.prefetchReuseThreshold}
                min={0.1} max={1} step={0.05} range
                onChange={(v) => set({ modeC: { rag: { prefetchReuseThreshold: v } } })}
                desc="Similarity required to reuse a prefetched result. Too high wastes prefetches; too low answers the wrong question."
              />
              <Num
                label="Minimum words before retrieving"
                value={c.modeC.rag.minWordsForRetrieval}
                min={0} max={20} step={1}
                onChange={(v) => set({ modeC: { rag: { minWordsForRetrieval: v } } })}
              />
            </div>

            <div className="card">
              <h2>Interruption handling</h2>
              <Check
                label="Enabled"
                value={c.modeC.stopSpeaking.enabled}
                onChange={(v) => set({ modeC: { stopSpeaking: { enabled: v } } })}
              />
              <Num
                label="numWords — words required before an interruption counts"
                value={c.modeC.stopSpeaking.numWords}
                min={0} max={10} step={1}
                onChange={(v) => set({ modeC: { stopSpeaking: { numWords: v } } })}
                desc="Documented default 0, meaning voice activity alone is enough. Browser echo cancellation is what makes that safe."
              />
              <Num
                label="voiceSeconds — sustained speech required"
                value={c.modeC.stopSpeaking.voiceSeconds}
                min={0} max={1} step={0.05} range
                onChange={(v) => set({ modeC: { stopSpeaking: { voiceSeconds: v } } })}
                desc="Documented default 0.2 s, documented range 0-0.5."
              />
              <Num
                label="backoffSeconds — ignore further interruptions after one"
                value={c.modeC.stopSpeaking.backoffSeconds}
                min={0} max={10} step={0.1}
                onChange={(v) => set({ modeC: { stopSpeaking: { backoffSeconds: v } } })}
                desc="Documented default 1.0 s."
              />
              <div className="field">
                <label>Acknowledgement phrases, one per line — these do NOT interrupt</label>
                <textarea
                  rows={5}
                  dir="auto"
                  defaultValue={(c.modeC.stopSpeaking.acknowledgementPhrases ?? []).join(NEWLINE)}
                  onBlur={(e) =>
                    set({
                      modeC: {
                        stopSpeaking: {
                          acknowledgementPhrases: splitLines(e.target.value),
                        },
                      },
                    })
                  }
                />
                <div className="desc">
                  A caller murmuring agreement while the assistant talks is not taking the floor. Treating that as an
                  interruption makes the agent stop constantly and feel broken.
                </div>
              </div>
              <div className="field">
                <label>Interruption phrases, one per line — these always interrupt</label>
                <textarea
                  rows={4}
                  dir="auto"
                  defaultValue={(c.modeC.stopSpeaking.interruptionPhrases ?? []).join(NEWLINE)}
                  onBlur={(e) =>
                    set({
                      modeC: {
                        stopSpeaking: {
                          interruptionPhrases: splitLines(e.target.value),
                        },
                      },
                    })
                  }
                />
              </div>
            </div>
          </div>

          <div className="split">
            <div className="card">
              <h2>Perceived latency</h2>
              <div className="banner warn" style={{ fontSize: 12 }}>
                OFF by default. This changes PERCEIVED latency, not real latency, and the two are always reported as
                separate numbers so a baseline measurement is never quietly flattered by it.
              </div>
              <Check
                label="Speak an acknowledgement while a slow operation runs"
                value={c.modeC.perceivedLatency.enabled}
                onChange={(v) => set({ modeC: { perceivedLatency: { enabled: v } } })}
              />
              <Num
                label="Only acknowledge when the operation exceeds (ms)"
                value={c.modeC.perceivedLatency.minOperationMs}
                min={0} max={5000} step={50}
                onChange={(v) => set({ modeC: { perceivedLatency: { minOperationMs: v } } })}
                desc="No acknowledgement is spoken when there is no real operation to cover."
              />
              <div className="field">
                <label>Acknowledgement phrases</label>
                <textarea
                  rows={3}
                  dir="auto"
                  defaultValue={(c.modeC.perceivedLatency.phrases ?? []).join(NEWLINE)}
                  onBlur={(e) =>
                    set({ modeC: { perceivedLatency: { phrases: splitLines(e.target.value) } } })
                  }
                />
              </div>
            </div>

            <div className="card">
              <h2>Background audio</h2>
              <div className="banner warn" style={{ fontSize: 12 }}>
                OFF by default, and Mode C only. Ambience, typing and hesitation sounds change PERCEIVED latency and
                change real latency by exactly zero milliseconds. None of it is ever counted as the first audio byte,
                so TTFS stays honest whether this is on or off.
              </div>
              <Check
                label="Enable background audio"
                value={c.modeC.backgroundAudio.enabled}
                onChange={(v) => set({ modeC: { backgroundAudio: { enabled: v } } })}
                desc="Master switch. Vapi exposes the equivalent as a single backgroundSound property, defaulting to office on phone calls and off on web calls."
              />

              <h3 style={{ fontSize: 13, margin: '14px 0 6px' }}>Office bed</h3>
              <Check
                label="Play a call-centre ambience bed"
                value={c.modeC.backgroundAudio.bed.enabled}
                onChange={(v) => set({ modeC: { backgroundAudio: { bed: { enabled: v } } } })}
                desc="Synthesised in the browser: no audio file is downloaded and no third-party sample licence applies."
              />
              <Num
                label="Resting level"
                value={c.modeC.backgroundAudio.bed.gain}
                min={0} max={0.4} step={0.005}
                onChange={(v) => set({ modeC: { backgroundAudio: { bed: { gain: v } } } })}
                desc="A bed you consciously notice is too loud. 0.03-0.05 reads as a room; above 0.1 it competes with the voice."
              />
              <Num
                label="Ducked level (while anyone is speaking)"
                value={c.modeC.backgroundAudio.bed.duckedGain}
                min={0} max={0.4} step={0.005}
                onChange={(v) => set({ modeC: { backgroundAudio: { bed: { duckedGain: v } } } })}
                desc="Clamped so it can never exceed the resting level. Ducking also keeps the bed out of the caller's own microphone."
              />

              <h3 style={{ fontSize: 13, margin: '14px 0 6px' }}>Keyboard</h3>
              <Check
                label="Type while the agent is working"
                value={c.modeC.backgroundAudio.keyboard.enabled}
                onChange={(v) => set({ modeC: { backgroundAudio: { keyboard: { enabled: v } } } })}
                desc="Covers the gap between the endpoint and the first audio byte. Stops the instant the answer is audible."
              />
              <Num
                label="Start typing only after (ms)"
                value={c.modeC.backgroundAudio.keyboard.startAfterMs}
                min={100} max={3000} step={25}
                onChange={(v) => set({ modeC: { backgroundAudio: { keyboard: { startAfterMs: v } } } })}
                desc="The whole trick is in this number. Typing that starts and stops inside 200 ms reads as a glitch and makes the agent feel broken, so fast turns must stay silent."
              />
              <Num
                label="Keystrokes per second"
                value={c.modeC.backgroundAudio.keyboard.rate}
                min={1} max={20} step={0.5}
                onChange={(v) => set({ modeC: { backgroundAudio: { keyboard: { rate: v } } } })}
                desc="Sustained human typing is roughly 4-8."
              />

              <h3 style={{ fontSize: 13, margin: '14px 0 6px' }}>Hesitation sounds</h3>
              <Check
                label={'Play a hesitation sound ("ممم") on a long wait'}
                value={c.modeC.backgroundAudio.filler.enabled}
                onChange={(v) => set({ modeC: { backgroundAudio: { filler: { enabled: v } } } })}
                desc="Rendered once at mic start through the session's own Hamsa voice and held in memory, so playing one costs no network. Non-lexical only: a sound commits the agent to nothing, whereas a phrase like 'one moment' is a promise the answer may contradict."
              />
              <Num
                label="Only after the wait exceeds (ms)"
                value={c.modeC.backgroundAudio.filler.afterMs}
                min={150} max={3000} step={50}
                onChange={(v) => set({ modeC: { backgroundAudio: { filler: { afterMs: v } } } })}
                desc="A filler in front of a fast answer ADDS perceived latency, because the answer then queues behind it."
              />
              <Check
                label="Backchannel while the caller is still speaking"
                value={c.modeC.backgroundAudio.backchannel.enabled}
                onChange={(v) => set({ modeC: { backgroundAudio: { backchannel: { enabled: v } } } })}
                desc="The riskiest option here: a backchannel mistimed over the caller's own words is an interruption, which is worse than silence. Vapi removed its backchannelingEnabled flag in October 2024 and folded the behaviour into the stop-speaking plan."
              />
            </div>

            <div className="card">
              <h2>Speculation, cache and transport</h2>
              <Check
                label="Pre-emptive LLM request (experimental)"
                value={c.modeC.preemptiveLlm.enabled}
                onChange={(v) => set({ modeC: { preemptiveLlm: { enabled: v } } })}
                desc="Start generation before the endpoint is confirmed, to test how much endpointing latency can be hidden. Wasted requests are recorded, never hidden."
              />
              <Check
                label="TTS phrase cache"
                value={c.modeC.ttsCache.enabled}
                onChange={(v) => set({ modeC: { ttsCache: { enabled: v } } })}
                desc="Caches short repeated phrases. Leave OFF during provider comparisons: a cache hit measures our own memory rather than the voice engine, and every hit is tagged so it can be excluded from provider statistics."
              />
              <Num
                label="Cache only phrases up to (characters)"
                value={c.modeC.ttsCache.maxPhraseChars}
                min={1} max={500} step={5}
                onChange={(v) => set({ modeC: { ttsCache: { maxPhraseChars: v } } })}
              />
              <Num
                label="Startup jitter buffer (ms)"
                value={c.modeC.transport.jitterBufferMs}
                min={0} max={500} step={5} range
                onChange={(v) => set({ modeC: { transport: { jitterBufferMs: v } } })}
                desc="The smallest reliable buffer is the goal. Lower it until underruns appear on the Debug page."
              />
              <Check
                label="Cold connection test"
                value={c.modeC.transport.coldConnectionTest}
                onChange={(v) => set({ modeC: { transport: { coldConnectionTest: v } } })}
                desc="Measure connection setup cost instead of reusing the warm session."
              />
            </div>
          </div>
        </>
      )}

      {tab === 'credentials' && (
        <div className="card" style={{ maxWidth: 640 }}>
          <h2>Temporary credentials</h2>
          <div className="banner info" style={{ fontSize: 12 }}>
            Keys entered here are sent to the local server over the loopback interface and held in process memory for
            this run only. They are never written to disk, never stored in localStorage, never returned to the browser
            and never included in an export. For anything beyond a quick test, use the <code>.env</code> file instead.
          </div>
          {status?.secrets && (
            <dl className="kv" style={{ marginBottom: 14 }}>
              <dt>OpenAI</dt>
              <dd>{(status as any).secrets.openai ? '✓ configured' : '✗ missing'}</dd>
              <dt>Speechmatics</dt>
              <dd>{(status as any).secrets.speechmatics ? '✓ configured' : '✗ missing'}</dd>
              <dt>Hamsa</dt>
              <dd>{(status as any).secrets.hamsa ? '✓ configured' : '✗ missing'}</dd>
            </dl>
          )}
          {(['openaiApiKey', 'speechmaticsApiKey', 'hamsaApiKey', 'hamsaSpeakerId'] as const).map((k) => (
            <div className="field" key={k}>
              <label>{k}</label>
              <input
                type={k === 'hamsaSpeakerId' ? 'text' : 'password'}
                value={creds[k]}
                autoComplete="off"
                onChange={(e) => setCreds({ ...creds, [k]: e.target.value })}
              />
            </div>
          ))}
          <button className="primary" onClick={() => void saveCreds()}>
            Store in server memory
          </button>
          {credMsg && <p className="hint">{credMsg}</p>}
        </div>
      )}
    </>
  );
}

/* -------------------------------------------------------------------------- */


/** Newline constant kept out of JSX so the source stays readable. */
const NEWLINE = '\n';

const splitLines = (v: string): string[] => v.split(NEWLINE).map((x) => x.trim()).filter(Boolean);

/**
 * Explains the flush marker. Kept as a constant because it contains angle
 * brackets that would otherwise have to be escaped inside JSX.
 */
const FLUSH_DESC =
  'Text before the marker is submitted to the voice engine immediately. Three forms are accepted: <flush />, <flush> and </flush>. The marker is ALWAYS stripped before synthesis, even with this switched off, so the caller can never hear the word spoken aloud.';

function Num({
  label,
  value,
  min,
  max,
  step,
  onChange,
  desc,
  range,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  desc?: string;
  range?: boolean;
}) {
  return (
    <div className="field">
      <label>
        {label} <span className="mono" style={{ color: 'var(--accent)' }}>{value}</span>
      </label>
      {range ? (
        <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      ) : (
        <input type="number" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      )}
      {desc && <div className="desc">{desc}</div>}
    </div>
  );
}

function Check({ label, value, onChange, desc }: { label: string; value: boolean; onChange: (v: boolean) => void; desc?: string }) {
  return (
    <div className="field">
      <label className="row tight" style={{ cursor: 'pointer' }}>
        <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
        <span>{label}</span>
      </label>
      {desc && <div className="desc">{desc}</div>}
    </div>
  );
}

function ChunkFields({ p, onChange }: { p: any; onChange: (patch: any) => void }) {
  return (
    <div className="grid cols-2" style={{ gap: 8 }}>
      <Num label="min words" value={p.minWords} min={1} max={30} step={1} onChange={(v) => onChange({ minWords: v })} />
      <Num label="min chars" value={p.minChars} min={5} max={300} step={5} onChange={(v) => onChange({ minChars: v })} />
      <Num label="max words" value={p.maxWords} min={2} max={60} step={1} onChange={(v) => onChange({ maxWords: v })} />
      <Num label="max chars" value={p.maxChars} min={10} max={500} step={10} onChange={(v) => onChange({ maxChars: v })} />
      <Num label="grace (ms)" value={p.graceMs} min={0} max={600} step={10} onChange={(v) => onChange({ graceMs: v })} />
      <div className="field">
        <label>boundary preference</label>
        <select value={p.boundaryPreference} onChange={(e) => onChange({ boundaryPreference: e.target.value })}>
          <option value="earliest">earliest — minimum latency</option>
          <option value="strongest">strongest — better prosody</option>
        </select>
      </div>
    </div>
  );
}
