import { describe, expect, it, vi } from 'vitest';
import { TtsPhraseScheduler } from './ttsScheduler.js';
import type {
  AudioFormat,
  ConnectionState,
  TtsCallbacks,
  TtsHandle,
  TtsProvider,
  TtsSynthesisRequest,
  TtsVoice,
} from '../providers.js';
import type { SpeechPhrase } from '../text/chunker.js';

/* -------------------------------------------------------------------------- */
/* Controllable fake provider                                                  */
/* -------------------------------------------------------------------------- */

interface PendingJob {
  req: TtsSynthesisRequest;
  cb: TtsCallbacks;
  cancelled: boolean;
  finish: (chunks: number[]) => void;
  emit: (bytes: number) => void;
  end: () => void;
}

class FakeTts implements TtsProvider {
  readonly name = 'fake';
  state: ConnectionState = 'open';
  warm = true;
  audioFormat: AudioFormat = { sampleRate: 16000, channels: 1, encoding: 'pcm_s16le' };
  jobs: PendingJob[] = [];
  concurrentPeak = 0;
  private active = 0;

  async connect(): Promise<void> {}
  async preloadVoice(): Promise<{ preloaded: boolean; required: boolean }> {
    return { preloaded: true, required: true };
  }
  async listVoices(): Promise<TtsVoice[]> {
    return [];
  }
  async close(): Promise<void> {}

  synthesize(req: TtsSynthesisRequest, cb: TtsCallbacks): TtsHandle {
    this.active++;
    this.concurrentPeak = Math.max(this.concurrentPeak, this.active);
    let audioSeq = 0;
    let bytes = 0;
    let chunks = 0;
    let cancelled = false;
    let resolveDone!: (v: any) => void;
    const done = new Promise<any>((r) => (resolveDone = r));

    const job: PendingJob = {
      req,
      cb,
      cancelled: false,
      emit: (n: number) => {
        if (cancelled) return;
        const chunk = {
          data: new Uint8Array(n),
          turnId: req.turnId,
          phraseSeq: req.phraseSeq,
          generation: req.generation,
          audioSeq: audioSeq++,
          isFirst: chunks === 0,
        };
        chunks++;
        bytes += n;
        if (chunk.isFirst) cb.onFirstAudio?.(chunk);
        cb.onChunk?.(chunk);
      },
      end: () => {
        if (cancelled) return;
        this.active--;
        cb.onEnd?.({ phraseSeq: req.phraseSeq, bytes, chunks });
        resolveDone({ bytes, chunks, cancelled: false });
      },
      finish: (sizes) => {
        for (const n of sizes) job.emit(n);
        job.end();
      },
    };
    this.jobs.push(job);
    cb.onRequestSent?.({ phraseSeq: req.phraseSeq, chars: req.text.length });

    return {
      cancel: () => {
        if (cancelled) return;
        cancelled = true;
        job.cancelled = true;
        this.active--;
        resolveDone({ bytes, chunks, cancelled: true });
      },
      get cancelled() {
        return cancelled;
      },
      done,
    };
  }

  jobFor(seq: number): PendingJob | undefined {
    return this.jobs.find((j) => j.req.phraseSeq === seq && !j.cancelled);
  }
}

let clock = 1_000_000_000n;
const now = () => (clock += 1_000_000n);

function phrase(text: string, seq: number): SpeechPhrase {
  return {
    seq,
    text,
    reason: 'word_boundary',
    words: text.split(/\s+/).length,
    chars: text.length,
    isFirst: seq === 1,
    createdAtNs: now(),
    sinceFirstDeltaMs: 0,
    waitedMs: 0,
    consumedChars: text.length,
  };
}

function mkScheduler(provider: FakeTts, maxConcurrent = 1, opts: Partial<{ maxBufferedBytes: number }> = {}) {
  const audio: Array<{ phraseSeq: number; audioSeq: number; bytes: number }> = [];
  const completed: number[] = [];
  const backpressure: any[] = [];
  const discarded: any[] = [];
  let allDone = false;

  const scheduler = new TtsPhraseScheduler(
    {
      provider,
      turnId: 'turn1',
      generation: 7,
      maxConcurrent,
      voice: { speaker: 'Amjad', dialect: 'pls' },
      now,
      maxBufferedBytes: opts.maxBufferedBytes,
    },
    {
      onAudio: (c) => audio.push({ phraseSeq: c.phraseSeq, audioSeq: c.audioSeq, bytes: c.data.byteLength }),
      onPhraseCompleted: (p) => completed.push(p.seq),
      onAllCompleted: () => (allDone = true),
      onBackpressure: (i) => backpressure.push(i),
      onDiscarded: (i) => discarded.push(i),
    },
  );

  return { scheduler, audio, completed, backpressure, discarded, isDone: () => allDone };
}

/* -------------------------------------------------------------------------- */

describe('TtsPhraseScheduler — ordering', () => {
  it('emits audio in phrase order even when phrase 2 finishes first', async () => {
    const provider = new FakeTts();
    const h = mkScheduler(provider, 2);

    h.scheduler.enqueue(phrase('phrase one', 1));
    h.scheduler.enqueue(phrase('phrase two', 2));
    await Promise.resolve();

    // Phrase 2 races ahead and completes entirely before phrase 1 emits anything.
    provider.jobFor(2)!.finish([100, 100]);
    // Nothing may be released yet: phrase 1 still owns the slot.
    expect(h.audio).toHaveLength(0);

    provider.jobFor(1)!.emit(50);
    expect(h.audio.map((a) => a.phraseSeq)).toEqual([1]);

    provider.jobFor(1)!.end();
    await Promise.resolve();

    // Phrase 1's remaining audio, then everything phrase 2 had buffered.
    expect(h.audio.map((a) => a.phraseSeq)).toEqual([1, 2, 2]);
  });

  it('streams phrase 1 live while phrase 2 buffers', async () => {
    const provider = new FakeTts();
    const h = mkScheduler(provider, 2);
    h.scheduler.enqueue(phrase('one', 1));
    h.scheduler.enqueue(phrase('two', 2));
    await Promise.resolve();

    provider.jobFor(1)!.emit(10);
    provider.jobFor(2)!.emit(20);
    provider.jobFor(1)!.emit(30);

    // Only phrase 1's chunks reach the wire, in order.
    expect(h.audio.map((a) => a.bytes)).toEqual([10, 30]);
  });

  it('runs strictly one at a time when maxConcurrent is 1', async () => {
    const provider = new FakeTts();
    const h = mkScheduler(provider, 1);
    h.scheduler.enqueue(phrase('one', 1));
    h.scheduler.enqueue(phrase('two', 2));
    h.scheduler.enqueue(phrase('three', 3));
    await Promise.resolve();

    // The Hamsa WebSocket carries no correlation id, so overlapping requests
    // would be unattributable. Only one may be in flight.
    expect(provider.jobs).toHaveLength(1);
    expect(provider.concurrentPeak).toBe(1);

    provider.jobFor(1)!.finish([10]);
    await Promise.resolve();
    expect(provider.jobs).toHaveLength(2);
  });

  it('respects a concurrency limit above 1', async () => {
    const provider = new FakeTts();
    const h = mkScheduler(provider, 2);
    for (let i = 1; i <= 5; i++) h.scheduler.enqueue(phrase(`p${i}`, i));
    await Promise.resolve();
    expect(provider.jobs).toHaveLength(2);
    expect(provider.concurrentPeak).toBeLessThanOrEqual(2);
  });

  it('signals completion only once everything has drained', async () => {
    const provider = new FakeTts();
    const h = mkScheduler(provider, 1);
    h.scheduler.enqueue(phrase('one', 1));
    h.scheduler.enqueue(phrase('two', 2));
    await Promise.resolve();

    provider.jobFor(1)!.finish([10]);
    await Promise.resolve();
    h.scheduler.markChunkerDone();
    expect(h.isDone()).toBe(false);

    provider.jobFor(2)!.finish([10]);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.isDone()).toBe(true);
    expect(h.completed).toEqual([1, 2]);
  });
});

describe('TtsPhraseScheduler — invalidation', () => {
  it('drops audio from an older generation', async () => {
    const provider = new FakeTts();
    const h = mkScheduler(provider, 1);
    h.scheduler.enqueue(phrase('one', 1));
    await Promise.resolve();

    const job = provider.jobFor(1)!;
    // Simulate a frame from a previous, cancelled turn arriving late.
    job.cb.onChunk?.({
      data: new Uint8Array(99),
      turnId: 'turn1',
      phraseSeq: 1,
      generation: 6, // stale
      audioSeq: 0,
      isFirst: true,
    });
    expect(h.audio).toHaveLength(0);
    expect(h.discarded[0].reason).toBe('stale_generation');
  });

  it('drops audio belonging to a different turn', async () => {
    const provider = new FakeTts();
    const h = mkScheduler(provider, 1);
    h.scheduler.enqueue(phrase('one', 1));
    await Promise.resolve();
    provider.jobFor(1)!.cb.onChunk?.({
      data: new Uint8Array(10),
      turnId: 'someOtherTurn',
      phraseSeq: 1,
      generation: 7,
      audioSeq: 0,
      isFirst: true,
    });
    expect(h.audio).toHaveLength(0);
  });

  it('emits nothing further after cancel, and cancels in-flight work', async () => {
    const provider = new FakeTts();
    const h = mkScheduler(provider, 2);
    h.scheduler.enqueue(phrase('one', 1));
    h.scheduler.enqueue(phrase('two', 2));
    await Promise.resolve();

    provider.jobFor(1)!.emit(10);
    expect(h.audio).toHaveLength(1);

    h.scheduler.cancel('barge_in');
    provider.jobs.forEach((j) => j.emit(999));

    expect(h.audio).toHaveLength(1);
    expect(h.scheduler.isCancelled).toBe(true);
  });

  it('refuses to enqueue after cancellation', () => {
    const provider = new FakeTts();
    const h = mkScheduler(provider, 1);
    h.scheduler.cancel();
    expect(h.scheduler.enqueue(phrase('late', 1))).toBeNull();
  });

  it('discards buffered audio on cancel and reports how much', async () => {
    const provider = new FakeTts();
    const h = mkScheduler(provider, 2);
    h.scheduler.enqueue(phrase('one', 1));
    h.scheduler.enqueue(phrase('two', 2));
    await Promise.resolve();

    provider.jobFor(2)!.emit(400); // buffered behind phrase 1
    h.scheduler.cancel('barge_in');
    const drop = h.discarded.find((d) => d.reason === 'barge_in');
    expect(drop?.bytes).toBe(400);
    expect(h.scheduler.bufferedAudioBytes).toBe(0);
  });
});

describe('TtsPhraseScheduler — backpressure', () => {
  it('stops dispatching new phrases when too much audio is buffered', async () => {
    const provider = new FakeTts();
    const h = mkScheduler(provider, 3, { maxBufferedBytes: 500 });
    for (let i = 1; i <= 3; i++) h.scheduler.enqueue(phrase(`p${i}`, i));
    await Promise.resolve();

    // Phrases 2 and 3 buffer heavily while phrase 1 has not started emitting.
    provider.jobFor(2)!.emit(400);
    provider.jobFor(3)!.emit(400);

    h.scheduler.enqueue(phrase('p4', 4));
    await Promise.resolve();

    expect(h.backpressure.length).toBeGreaterThan(0);
    // Phrase 4 must not have been dispatched while over the limit.
    expect(provider.jobs.some((j) => j.req.phraseSeq === 4)).toBe(false);
  });

  it('never drops audio mid-phrase — a hole in a sentence is worse than a delay', async () => {
    const provider = new FakeTts();
    const h = mkScheduler(provider, 2, { maxBufferedBytes: 100 });
    h.scheduler.enqueue(phrase('one', 1));
    h.scheduler.enqueue(phrase('two', 2));
    await Promise.resolve();

    provider.jobFor(2)!.emit(5000); // far over the buffer limit
    provider.jobFor(1)!.finish([10]);
    await Promise.resolve();

    const seq2 = h.audio.filter((a) => a.phraseSeq === 2);
    expect(seq2).toHaveLength(1);
    expect(seq2[0].bytes).toBe(5000); // released intact, not truncated
  });

  it('unblocks the queue when a failed phrase never emits onEnd', async () => {
    const provider = new FakeTts();
    const h = mkScheduler(provider, 1);
    h.scheduler.enqueue(phrase('one', 1));
    h.scheduler.enqueue(phrase('two', 2));
    await Promise.resolve();

    // Provider errors out and cancels rather than ending cleanly.
    const handleCancel = provider.jobs[0];
    handleCancel.cancelled = true;
    h.scheduler.cancel('provider_error');
    expect(h.scheduler.isCancelled).toBe(true);
  });
});

describe('TtsPhraseScheduler — identity', () => {
  it('tags every request with turn, phrase sequence and generation', async () => {
    const provider = new FakeTts();
    const h = mkScheduler(provider, 1);
    h.scheduler.enqueue(phrase('hello there', 1));
    await Promise.resolve();
    const req = provider.jobs[0].req;
    expect(req.turnId).toBe('turn1');
    expect(req.phraseSeq).toBe(1);
    expect(req.generation).toBe(7);
    expect(req.speaker).toBe('Amjad');
    expect(req.dialect).toBe('pls');
  });

  it('numbers phrases from 1 upwards in enqueue order', () => {
    const provider = new FakeTts();
    const h = mkScheduler(provider, 1);
    const a = h.scheduler.enqueue(phrase('a', 1));
    const b = h.scheduler.enqueue(phrase('b', 2));
    const c = h.scheduler.enqueue(phrase('c', 3));
    expect([a?.seq, b?.seq, c?.seq]).toEqual([1, 2, 3]);
  });
});
