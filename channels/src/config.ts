export type Variables = Record<string, unknown>;
export function config(env: Variables) {
  function n(name: string, fallback: number, min: number, max: number): number {
    const raw = env[name] ?? String(fallback);
    if (typeof raw !== 'string' || !/^(0|[1-9][0-9]*)$/.test(raw)) throw new Error(`Invalid ${name}`);
    const v = Number(raw);
    if (!Number.isSafeInteger(v) || v < min || v > max) throw new Error(`Invalid ${name}`);
    return v;
  }
  const c = {
    maxMessage: n('MAX_MESSAGE_BYTES', 8192, 1, 8192),
    maxBytes: n('CHANNEL_BYTES', 262144, 8192, 1048576),
    maxMessages: n('CHANNEL_MESSAGES', 256, 1, 1024),
    messageAgeMs: n('MESSAGE_AGE_SECONDS', 3600, 1, 86400) * 1000,
    lifetimeMs: n('CHANNEL_LIFETIME_SECONDS', 86400, 1, 604800) * 1000,
    maxChannels: n('MAX_CHANNELS', 1000, 1, 10000),
    maxTickets: n('MAX_TICKETS', 512, 1, 4096),
    ticketMs: n('TICKET_SECONDS', 120, 1, 600) * 1000,
    createBits: n('CREATE_POW_BITS', 0, 0, 32),
    appendBits: n('APPEND_POW_BITS', 0, 0, 32),
    perByte: n('POW_PER_BYTE', 0, 0, 1000000),
    maxSockets: n('MAX_SUBSCRIPTIONS', 256, 1, 1024),
    channelSockets: n('CHANNEL_SUBSCRIPTIONS', 16, 1, 64),
    socketMs: n('SUBSCRIPTION_SECONDS', 300, 2, 1800) * 1000,
    ackMs: n('ACK_SECONDS', 15, 1, 60) * 1000,
    uploadMs: n('UPLOAD_TIMEOUT_MS', 10000, 100, 10000),
    policies: {
      requests: { capacity: n('REQUEST_BURST', 120, 1, 10000), refill: n('REQUESTS_PER_MINUTE', 600, 1, 60000), periodMs: 60000 },
      creates: { capacity: n('CREATE_BURST', 100, 1, 10000), refill: n('CREATES_PER_DAY', 100, 1, 100000), periodMs: 86400000 },
      challenges: { capacity: n('CHALLENGE_BURST', 60, 1, 1000), refill: n('CHALLENGES_PER_MINUTE', 60, 1, 10000), periodMs: 60000 },
      ingress: { capacity: n('INGRESS_CAPACITY_BYTES', 209715200, 8192, 2147483648), refill: n('INGRESS_BYTES_PER_DAY', 104857600, 1, 2147483648), periodMs: 86400000 },
      burst: { capacity: n('BURST_CAPACITY_BYTES', 8388608, 8192, 67108864), refill: n('BURST_BYTES_PER_HOUR', 8388608, 1, 67108864), periodMs: 3600000 },
      delivery: { capacity: n('DELIVERY_CAPACITY_BYTES', 838860800, 65536, 2147483648), refill: n('DELIVERY_BYTES_PER_DAY', 419430400, 1, 2147483648), periodMs: 86400000 },
      deliveryBurst: { capacity: n('DELIVERY_BURST_BYTES', 16777216, 65536, 67108864), refill: n('DELIVERY_BYTES_PER_HOUR', 16777216, 1, 67108864), periodMs: 3600000 },
    },
  };
  // Keep operator changes within the intended single-object bootstrap envelope,
  // leaving room for SQLite indexes and metadata rather than just payload bytes.
  if (c.maxChannels * c.maxBytes > 512 * 1024 * 1024 || c.maxChannels * c.maxMessages > 1000000) {
    throw new Error('Channel capacity exceeds the supported hub envelope (512 MiB payload / 1,000,000 message slots).');
  }
  return c;
}
export type Config = ReturnType<typeof config>;
