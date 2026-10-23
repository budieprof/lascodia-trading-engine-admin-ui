import {
  MessageType,
  TransferFormat,
  type CancelInvocationMessage,
  type CompletionMessage,
  type HubMessage,
  type IHubProtocol,
  type ILogger,
  type InvocationMessage,
  type MessageHeaders,
  type StreamInvocationMessage,
  type StreamItemMessage,
} from '@microsoft/signalr';

import { MsgPackError, MsgPackReader, msgpackEncode } from './msgpack';

/**
 * The SignalR MessagePack hub protocol (name `messagepack`, version 2 — what ASP.NET Core 10's
 * `AddMessagePackProtocol()` speaks), on the in-repo codec (`msgpack.ts`). Wire format, as the official
 * `@microsoft/signalr-protocol-msgpack` writes it:
 * - each message is a VarInt length (7 bits a byte, low first, ≤ 5 bytes) followed by one MessagePack array;
 * - Invocation `[1, headers, invocationId|nil, target, arguments, streamIds?]`, StreamItem `[2, headers, id, item]`,
 *   Completion `[3, headers, id, resultKind (1 error, 2 void, 3 result), result?]`, StreamInvocation `[4, …]`,
 *   CancelInvocation `[5, headers, id]`, Ping `[6]`, Close `[7, error|nil, allowReconnect?]`, Ack `[8, seq]`,
 *   Sequence `[9, seq]`.
 * The handshake stays JSON (the HubConnection writes it itself).
 */
export class MessagePackHubProtocol implements IHubProtocol {
  readonly name = 'messagepack';
  readonly version = 2;
  readonly transferFormat = TransferFormat.Binary;

  parseMessages(input: string | ArrayBuffer, logger: ILogger): HubMessage[] {
    if (typeof input === 'string')
      throw new Error('MessagePack hub protocol: expected binary input.');
    const bytes = new Uint8Array(input);
    const out: HubMessage[] = [];
    for (const [start, end] of binaryFrames(bytes)) {
      const message = this.parseOne(bytes, start, end, logger);
      if (message) out.push(message);
    }
    return out;
  }

  private parseOne(
    bytes: Uint8Array,
    start: number,
    end: number,
    logger: ILogger,
  ): HubMessage | null {
    const props = new MsgPackReader(bytes, start, end).read();
    if (!Array.isArray(props) || props.length === 0) throw new MsgPackError('Invalid payload.');
    const type = props[0] as MessageType;
    switch (type) {
      case MessageType.Invocation: {
        if (props.length < 5) throw new MsgPackError('Invalid payload for Invocation message.');
        const id = props[2] as string | null;
        const msg: InvocationMessage = id
          ? {
              type,
              headers: headersOf(props[1]),
              invocationId: id,
              target: props[3] as string,
              arguments: (props[4] as unknown[]) ?? [],
              streamIds: (props[5] as string[] | undefined) ?? [],
            }
          : {
              type,
              headers: headersOf(props[1]),
              target: props[3] as string,
              arguments: (props[4] as unknown[]) ?? [],
              streamIds: (props[5] as string[] | undefined) ?? [],
            };
        return msg;
      }
      case MessageType.StreamItem: {
        if (props.length < 4) throw new MsgPackError('Invalid payload for StreamItem message.');
        return {
          type,
          headers: headersOf(props[1]),
          invocationId: props[2] as string,
          item: props[3],
        } satisfies StreamItemMessage;
      }
      case MessageType.Completion: {
        if (props.length < 4) throw new MsgPackError('Invalid payload for Completion message.');
        const kind = props[3];
        if (kind !== 2 && props.length < 5)
          throw new MsgPackError('Invalid payload for Completion message.');
        const base = { type, headers: headersOf(props[1]), invocationId: props[2] as string };
        if (kind === 1) return { ...base, error: String(props[4]) } satisfies CompletionMessage;
        if (kind === 3) return { ...base, result: props[4] } satisfies CompletionMessage;
        return base satisfies CompletionMessage;
      }
      case MessageType.Ping:
        return { type };
      case MessageType.Close: {
        if (props.length < 2) throw new MsgPackError('Invalid payload for Close message.');
        return {
          type,
          error: (props[1] as string | null) ?? undefined,
          allowReconnect: props.length >= 3 ? (props[2] as boolean) : undefined,
        };
      }
      case MessageType.Ack:
        return { type, sequenceId: Number(props[1]) };
      case MessageType.Sequence:
        return { type, sequenceId: Number(props[1]) };
      default:
        logger.log(2 /* Information */, `Unknown message type '${String(type)}' ignored.`);
        return null;
    }
  }

  writeMessage(message: HubMessage): ArrayBuffer {
    switch (message.type) {
      case MessageType.Invocation:
      case MessageType.StreamInvocation: {
        const m = message as InvocationMessage | StreamInvocationMessage;
        const payload: unknown[] = [
          m.type,
          m.headers ?? {},
          m.invocationId ?? null,
          m.target,
          m.arguments,
        ];
        if (m.streamIds) payload.push(m.streamIds);
        return frame(msgpackEncode(payload));
      }
      case MessageType.StreamItem:
        return frame(
          msgpackEncode([message.type, message.headers ?? {}, message.invocationId, message.item]),
        );
      case MessageType.Completion: {
        const m = message as CompletionMessage;
        const kind = m.error ? 1 : m.result !== undefined ? 3 : 2;
        const payload: unknown[] = [m.type, m.headers ?? {}, m.invocationId, kind];
        if (kind === 1) payload.push(m.error);
        if (kind === 3) payload.push(m.result);
        return frame(msgpackEncode(payload));
      }
      case MessageType.CancelInvocation: {
        const m = message as CancelInvocationMessage;
        return frame(msgpackEncode([m.type, m.headers ?? {}, m.invocationId]));
      }
      case MessageType.Ping:
        return frame(msgpackEncode([MessageType.Ping]));
      case MessageType.Close:
        throw new Error('A client never sends a Close message.');
      case MessageType.Ack:
      case MessageType.Sequence:
        return frame(msgpackEncode([message.type, message.sequenceId]));
      default:
        throw new Error('Unknown message type.');
    }
  }
}

function headersOf(raw: unknown): MessageHeaders {
  const out: MessageHeaders = {};
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) out[k] = String(v);
  }
  return out;
}

/** The [start, end) byte ranges of the length-prefixed messages in `bytes`. */
export function binaryFrames(bytes: Uint8Array): [number, number][] {
  const out: [number, number][] = [];
  let offset = 0;
  while (offset < bytes.length) {
    let size = 0;
    let shift = 0;
    let n = 0;
    let b: number;
    do {
      if (offset + n >= bytes.length) throw new MsgPackError('Cannot read message size.');
      b = bytes[offset + n];
      size += (b & 0x7f) * 2 ** shift;
      shift += 7;
      n++;
    } while (b & 0x80 && n < 5);
    if (b & 0x80) throw new MsgPackError('Messages bigger than 2 GB are not supported.');
    const start = offset + n;
    const end = start + size;
    if (end > bytes.length) throw new MsgPackError('Incomplete message.');
    out.push([start, end]);
    offset = end;
  }
  return out;
}

/** `payload` with its VarInt length prefix, as an ArrayBuffer. */
export function frame(payload: Uint8Array): ArrayBuffer {
  const head: number[] = [];
  let size = payload.length;
  do {
    let b = size & 0x7f;
    size = Math.floor(size / 128);
    if (size > 0) b |= 0x80;
    head.push(b);
  } while (size > 0);
  const out = new Uint8Array(head.length + payload.length);
  out.set(head, 0);
  out.set(payload, head.length);
  return out.buffer;
}
