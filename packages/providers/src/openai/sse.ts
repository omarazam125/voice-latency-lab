/**
 * Minimal, allocation-conscious SSE parser for the OpenAI Responses stream.
 *
 * Wire format, per the documented curl output and the openai-node source:
 *
 *     event: response.output_text.delta\n
 *     data: {"type":"response.output_text.delta","delta":"In",...}\n
 *     \n
 *     ...
 *     data: [DONE]\n\n
 *
 * The `type` field is duplicated inside the JSON payload, so the parser only
 * needs to surface `data`. Lines are split on \n and a trailing \r is trimmed to
 * tolerate CRLF.
 */

export interface SseMessage {
  event?: string;
  data: string;
}

export class SseParser {
  private buf = '';
  private event: string | undefined;
  private dataLines: string[] = [];

  /** Feed a decoded text chunk; returns any complete messages it produced. */
  push(chunk: string): SseMessage[] {
    this.buf += chunk;
    const out: SseMessage[] = [];

    let idx: number;
    while ((idx = this.buf.indexOf('\n')) !== -1) {
      let line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);

      if (line === '') {
        if (this.dataLines.length > 0) {
          out.push({ event: this.event, data: this.dataLines.join('\n') });
        }
        this.event = undefined;
        this.dataLines = [];
        continue;
      }
      if (line.startsWith(':')) continue; // comment / keep-alive

      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);

      if (field === 'event') this.event = value;
      else if (field === 'data') this.dataLines.push(value);
      // `id` and `retry` are unused by this API.
    }
    return out;
  }

  /** Flush a final message if the stream ended without a trailing blank line. */
  finish(): SseMessage[] {
    if (this.dataLines.length === 0) return [];
    const m: SseMessage = { event: this.event, data: this.dataLines.join('\n') };
    this.event = undefined;
    this.dataLines = [];
    return [m];
  }
}
