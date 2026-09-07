/**
 * Streaming PCM playback worklet.
 *
 * Consumes 16 kHz PCM16 chunks as they arrive from the server and plays them
 * with a deliberately small jitter buffer. It NEVER waits for the complete
 * response: the first chunk starts playing as soon as the configured buffer
 * (default 80 ms) is satisfied.
 *
 * Resampling to the device rate happens here rather than by constructing a
 * 16 kHz AudioContext, because the Web Audio spec warns that a context whose
 * rate differs from the output device "may be affected, possibly by a large
 * amount" in latency -- unacceptable in a tool whose entire purpose is
 * measuring latency.
 *
 * Generation tagging: every chunk carries the generation it belongs to. On
 * barge-in the main thread bumps the generation and any queued or in-flight
 * audio from an older generation is dropped rather than played late.
 */

class PlayerProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.sourceRate = o.sourceRate || 16000;
    this.jitterMs = o.jitterMs != null ? o.jitterMs : 80;
    this.maxQueueMs = o.maxQueueMs || 6000;

    this.ratio = this.sourceRate / sampleRate; // source samples consumed per output sample

    // Ring buffer of Float32 source-rate samples.
    this.capacity = Math.ceil((this.maxQueueMs / 1000) * this.sourceRate) + 16384;
    this.ring = new Float32Array(this.capacity);
    this.readIdx = 0;
    this.writeIdx = 0;
    this.available = 0;

    this.readFrac = 0;
    this.prevSample = 0;

    this.generation = 0;
    this.playing = false;
    this.startedThisGeneration = false;
    this.underruns = 0;
    this.underrunSamples = 0;
    this.reportCounter = 0;
    this.everReceived = false;
    this.pendingFirstPhraseSeq = 0;

    this.port.onmessage = (ev) => this.onMessage(ev.data);
    this.port.postMessage({ type: 'ready', sampleRate, sourceRate: this.sourceRate });
  }

  onMessage(d) {
    if (!d) return;
    switch (d.type) {
      case 'audio': {
        // Stale audio from a cancelled generation is dropped, never played.
        if (d.generation < this.generation) {
          this.port.postMessage({ type: 'dropped', generation: d.generation, bytes: d.pcm.byteLength });
          return;
        }
        const pcm = new Int16Array(d.pcm);
        this.enqueue(pcm);
        if (!this.everReceived) {
          this.everReceived = true;
          this.pendingFirstPhraseSeq = d.phraseSeq || 0;
        }
        break;
      }
      case 'flush':
        this.readIdx = 0;
        this.writeIdx = 0;
        this.available = 0;
        this.readFrac = 0;
        this.prevSample = 0;
        this.playing = false;
        this.startedThisGeneration = false;
        this.everReceived = false;
        this.generation = d.generation != null ? d.generation : this.generation;
        this.port.postMessage({ type: 'flushed', generation: this.generation });
        break;
      case 'generation':
        this.generation = d.generation;
        this.startedThisGeneration = false;
        break;
      case 'config':
        if (d.jitterMs != null) this.jitterMs = d.jitterMs;
        if (d.sourceRate != null) {
          this.sourceRate = d.sourceRate;
          this.ratio = this.sourceRate / sampleRate;
        }
        break;
      default:
        break;
    }
  }

  enqueue(pcm) {
    const n = pcm.length;
    const room = this.capacity - this.available;

    if (n > room) {
      // Drop the NEWEST audio, never the oldest.
      //
      // The previous policy advanced readIdx past the overflow, which deletes
      // the samples the speaker is rendering RIGHT NOW. Observed live: 15,350
      // samples -- 959 ms -- removed from the middle of a sentence, heard as
      // the agent saying a word, cutting out, saying the next word, cutting
      // out. For speech that is the worst possible choice: a hole in the middle
      // of a word destroys intelligibility, whereas losing the tail of an
      // over-long answer merely shortens it.
      //
      // Reaching here at all means something upstream is over-producing, so the
      // count is reported rather than silently absorbed.
      const kept = Math.max(0, room);
      for (let i = 0; i < kept; i++) {
        this.ring[this.writeIdx] = pcm[i] / 32768;
        this.writeIdx = (this.writeIdx + 1) % this.capacity;
      }
      this.available += kept;
      this.port.postMessage({ type: 'overflow', dropped: n - kept, keptIntact: true });
      return;
    }

    for (let i = 0; i < n; i++) {
      this.ring[this.writeIdx] = pcm[i] / 32768;
      this.writeIdx = (this.writeIdx + 1) % this.capacity;
    }
    this.available += n;
  }

  readSample() {
    if (this.available <= 0) return null;
    const v = this.ring[this.readIdx];
    this.readIdx = (this.readIdx + 1) % this.capacity;
    this.available--;
    return v;
  }

  get bufferedMs() {
    return (this.available / this.sourceRate) * 1000;
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const chan = out[0];
    const n = chan.length;

    // Hold silence until the jitter buffer is satisfied. This is the ONLY
    // deliberate delay in the playback path, and it is directly configurable.
    if (!this.playing) {
      if (this.bufferedMs >= this.jitterMs && this.available > 0) {
        this.playing = true;
        if (!this.startedThisGeneration) {
          this.startedThisGeneration = true;
          // `currentTime` is this quantum's start on the AudioContext clock;
          // the main thread converts it with getOutputTimestamp() so the
          // reported instant includes real device output latency.
          this.port.postMessage({
            type: 'playback_started',
            contextTime: currentTime,
            generation: this.generation,
            phraseSeq: this.pendingFirstPhraseSeq,
            bufferedMs: this.bufferedMs,
          });
        }
      } else {
        chan.fill(0);
        this.report();
        return true;
      }
    }

    let starved = 0;
    for (let i = 0; i < n; i++) {
      // Linear interpolation upsample from sourceRate to the device rate.
      while (this.readFrac >= 1) {
        const s = this.readSample();
        if (s === null) {
          starved++;
          break;
        }
        this.prevSample = this.nextSample !== undefined ? this.nextSample : s;
        this.nextSample = s;
        this.readFrac -= 1;
      }
      if (this.nextSample === undefined) {
        const s = this.readSample();
        if (s === null) {
          chan[i] = 0;
          starved++;
          continue;
        }
        this.prevSample = s;
        this.nextSample = s;
      }
      chan[i] = this.prevSample + (this.nextSample - this.prevSample) * this.readFrac;
      this.readFrac += this.ratio;
    }

    if (starved > 0) {
      this.underruns++;
      this.underrunSamples += starved;
      if (this.available === 0) {
        // Ran dry: go back to buffering rather than stuttering every quantum.
        this.playing = false;
        this.nextSample = undefined;
        this.readFrac = 0;
        this.port.postMessage({
          type: 'underrun',
          count: this.underruns,
          durationMs: (this.underrunSamples / this.sourceRate) * 1000,
          finished: this.everReceived,
        });
      }
    }

    this.report();
    return true;
  }

  report() {
    // ~every 21 ms at 128-frame quanta / 48 kHz. Cheap and enough for a meter.
    if (++this.reportCounter % 8 !== 0) return;
    this.port.postMessage({
      type: 'stats',
      bufferedMs: this.bufferedMs,
      frames: this.available,
      playing: this.playing,
      generation: this.generation,
    });
  }
}

registerProcessor('vll-player', PlayerProcessor);
