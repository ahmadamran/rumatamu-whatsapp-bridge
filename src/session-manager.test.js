import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { disconnectStatusCode, mediaContentFromPayload, mediaInfoFromMessage, messageKeyFromPayload, messageStoreKey, quotedMessageFromPayload, WhatsappSessionManager } from './session-manager.js';

function makeManager() {
  const events = [];
  const sockets = new Map();

  const manager = new WhatsappSessionManager({
    authRoot: '/tmp/rt-auth',
    reconnectDelay: 1,
    logger: { child: () => ({ error() {} }), error() {} },
    emit: async (event, managementCompanyId, payload) => {
      events.push({ event, managementCompanyId, payload });
    },
    authState: async (authDir) => ({
      state: { creds: {}, keys: { get: async () => ({}), set: async () => {} } },
      saveCreds: async () => {},
      authDir,
    }),
    latestVersion: async () => ({ version: [2, 3000, 1015901307] }),
    qrToDataUrl: async (qr) => `data:image/png;base64,${qr}`,
    makeSocket: (config) => {
      const socket = {
        config,
        ev: new EventEmitter(),
        user: { id: `user-${sockets.size + 1}` },
        sent: [],
        historyRequests: [],
        endCalled: false,
        async sendMessage(to, message, options) {
          this.sent.push({ to, message, options });
          return { key: { id: `message-${this.sent.length}` } };
        },
        async fetchMessageHistory(count, messageKey, timestamp) {
          this.historyRequests.push({ count, messageKey, timestamp });
          return `history-${this.historyRequests.length}`;
        },
        end() {
          this.endCalled = true;
        },
      };

      sockets.set(config.auth, socket);

      return socket;
    },
  });

  return { manager, events, sockets };
}

async function flushAsyncEvents() {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

test('keeps separate session state for separate management companies', async () => {
  const { manager } = makeManager();

  await manager.start(1);
  await manager.start(2);

  assert.equal(manager.sessions.size, 2);
  assert.equal(manager.status(1).authPath, '/tmp/rt-auth/1');
  assert.equal(manager.status(2).authPath, '/tmp/rt-auth/2');
  assert.notEqual(manager.sessionFor(1).socket, manager.sessionFor(2).socket);
});

test('sends through the requested management company socket only', async () => {
  const { manager } = makeManager();

  await manager.start(1);
  await manager.start(2);
  const companyOneSocket = manager.sessionFor(1).socket;
  const companyTwoSocket = manager.sessionFor(2).socket;

  const response = await manager.sendMessage(2, '60123456789', 'Hello');

  assert.equal(response.managementCompanyId, 2);
  assert.equal(companyOneSocket.sent.length, 0);
  assert.equal(companyTwoSocket.sent.length, 1);
  assert.equal(companyTwoSocket.sent[0].to, '60123456789@s.whatsapp.net');
  assert.equal(companyTwoSocket.sent[0].options, undefined);
});

test('provides cached outbound messages for WhatsApp retry requests', async () => {
  const { manager } = makeManager();

  await manager.start(2);
  const socket = manager.sessionFor(2).socket;
  await manager.sendMessage(2, '60123456789', 'Retry me');

  const message = await socket.config.getMessage({
    remoteJid: '60123456789@s.whatsapp.net',
    id: 'message-1',
  });

  assert.deepEqual(message, { text: 'Retry me' });
});

test('provides cached inbound messages for quote and retry lookups', async () => {
  const { manager } = makeManager();

  await manager.start(2);
  const socket = manager.sessionFor(2).socket;
  await socket.ev.emit('messages.upsert', {
    messages: [
      {
        key: {
          id: 'inbound-1',
          remoteJid: '60123456789@s.whatsapp.net',
          fromMe: false,
        },
        messageTimestamp: 1779634752,
        message: {
          conversation: 'Original inbound',
        },
      },
    ],
  });

  const message = await socket.config.getMessage({
    remoteJid: '60123456789@s.whatsapp.net',
    id: 'inbound-1',
  });

  assert.deepEqual(message, { conversation: 'Original inbound' });
});

test('builds stable message store keys only when jid and id are present', () => {
  assert.equal(messageStoreKey({ remoteJid: '60123456789@s.whatsapp.net', id: 'abc' }), '60123456789@s.whatsapp.net:abc');
  assert.equal(messageStoreKey({ remoteJid: '60123456789@s.whatsapp.net' }), '');
  assert.equal(messageStoreKey({ id: 'abc' }), '');
});

test('sends with the chat ephemeral expiration when disappearing messages are enabled', async () => {
  const { manager } = makeManager();

  await manager.start(2);
  const socket = manager.sessionFor(2).socket;
  socket.ev.emit('chats.update', [
    {
      id: '60123456789@s.whatsapp.net',
      ephemeralExpiration: 86400,
    },
  ]);

  const response = await manager.sendMessage(2, '60123456789', 'Hello');

  assert.equal(response.ephemeralExpiration, 86400);
  assert.equal(socket.sent.length, 1);
  assert.deepEqual(socket.sent[0], {
    to: '60123456789@s.whatsapp.net',
    message: { text: 'Hello' },
    options: { ephemeralExpiration: 86400 },
  });
});

test('uses ephemeral expiration from messaging history before sending', async () => {
  const { manager } = makeManager();

  await manager.start(2);
  const socket = manager.sessionFor(2).socket;
  socket.ev.emit('messaging-history.set', {
    chats: [
      {
        id: '60199990000@s.whatsapp.net',
        ephemeralExpiration: 604800,
      },
    ],
  });

  await manager.sendMessage(2, '60199990000', 'History timer');

  assert.deepEqual(socket.sent[0].options, { ephemeralExpiration: 604800 });
});

test('emits recent messages from whatsapp history sync quietly tagged for import', async () => {
  const { manager, events } = makeManager();

  await manager.start(2);
  const socket = manager.sessionFor(2).socket;
  await socket.ev.emit('messaging-history.set', {
    syncType: 3,
    messages: [
      {
        key: {
          id: 'history-inbound-1',
          remoteJid: '60123456789@s.whatsapp.net',
          fromMe: false,
        },
        pushName: 'Aina',
        messageTimestamp: Math.floor(Date.now() / 1000) - 60,
        message: {
          conversation: 'Missed message',
        },
      },
    ],
  });
  await flushAsyncEvents();

  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'message');
  assert.equal(events[0].payload.messageId, 'history-inbound-1');
  assert.equal(events[0].payload.source, 'history_sync');
  assert.equal(events[0].payload.historySync, true);
  assert.equal(events[0].payload.syncType, 3);
  assert.equal(events[0].payload.body, 'Missed message');
});

test('history sync skips old empty status and internal messages', async () => {
  const { manager, events } = makeManager();

  await manager.start(2);
  const socket = manager.sessionFor(2).socket;
  const recent = Math.floor(Date.now() / 1000) - 60;
  await socket.ev.emit('messaging-history.set', {
    messages: [
      {
        key: { id: 'history-old', remoteJid: '60111111111@s.whatsapp.net', fromMe: false },
        messageTimestamp: recent - (8 * 24 * 60 * 60),
        message: { conversation: 'Too old' },
      },
      {
        key: { id: 'history-empty', remoteJid: '60122222222@s.whatsapp.net', fromMe: false },
        messageTimestamp: recent,
        message: { conversation: '' },
      },
      {
        key: { id: 'history-status', remoteJid: 'status@broadcast', fromMe: false },
        messageTimestamp: recent,
        message: { conversation: 'Story update' },
      },
      {
        key: { id: 'history-internal', remoteJid: '60133333333@s.whatsapp.net', fromMe: false },
        messageTimestamp: recent,
        message: { messageContextInfo: {} },
      },
    ],
  });
  await flushAsyncEvents();

  assert.equal(events.length, 0);
});

test('history sync caps import to the newest 500 messages and emits oldest first', async () => {
  const { manager, events } = makeManager();

  await manager.start(2);
  const socket = manager.sessionFor(2).socket;
  const base = Math.floor(Date.now() / 1000) - 1000;
  const messages = Array.from({ length: 505 }, (_, index) => ({
    key: {
      id: `history-cap-${index + 1}`,
      remoteJid: '60123456789@s.whatsapp.net',
      fromMe: false,
    },
    messageTimestamp: base + index,
    message: {
      conversation: `Message ${index + 1}`,
    },
  }));

  await socket.ev.emit('messaging-history.set', { messages });
  await flushAsyncEvents();

  assert.equal(events.length, 500);
  assert.equal(events[0].payload.messageId, 'history-cap-6');
  assert.equal(events[499].payload.messageId, 'history-cap-505');
});

test('history sync caches messages for whatsapp retry lookup', async () => {
  const { manager } = makeManager();

  await manager.start(2);
  const socket = manager.sessionFor(2).socket;
  await socket.ev.emit('messaging-history.set', {
    messages: [
      {
        key: {
          id: 'history-cache-1',
          remoteJid: '60123456789@s.whatsapp.net',
          fromMe: false,
        },
        messageTimestamp: Math.floor(Date.now() / 1000) - 60,
        message: {
          conversation: 'Cache me',
        },
      },
    ],
  });
  await flushAsyncEvents();

  const message = await socket.config.getMessage({
    remoteJid: '60123456789@s.whatsapp.net',
    id: 'history-cache-1',
  });

  assert.deepEqual(message, { conversation: 'Cache me' });
});

test('uses explicit ephemeral expiration from send request before cached chat state', async () => {
  const { manager } = makeManager();

  await manager.start(2);
  const socket = manager.sessionFor(2).socket;
  socket.ev.emit('chats.update', [
    {
      id: '60123456789@s.whatsapp.net',
      ephemeralExpiration: 86400,
    },
  ]);

  const response = await manager.sendMessage(2, '60123456789', 'Override timer', null, 604800);

  assert.equal(response.ephemeralExpiration, 604800);
  assert.deepEqual(socket.sent[0].options, { ephemeralExpiration: 604800 });
});

test('sends with quoted message options for native WhatsApp replies', async () => {
  const { manager } = makeManager();

  await manager.start(2);
  const socket = manager.sessionFor(2).socket;
  const quoted = {
    key: {
      id: 'IN-QUOTE-1',
      remoteJid: '60123456789@s.whatsapp.net',
      fromMe: false,
    },
    message: {
      conversation: 'Original question',
    },
  };

  const response = await manager.sendMessage(2, '60123456789', 'Native quote reply', null, null, quoted);

  assert.equal(response.quotedMessageId, 'IN-QUOTE-1');
  assert.deepEqual(socket.sent[0], {
    to: '60123456789@s.whatsapp.net',
    message: { text: 'Native quote reply' },
    options: { quoted },
  });
});

test('ignores invalid quoted message payloads', () => {
  assert.equal(quotedMessageFromPayload(null), null);
  assert.equal(quotedMessageFromPayload({ key: { id: 'missing-message' } }), null);
  assert.equal(quotedMessageFromPayload({ message: { conversation: 'missing id' } }), null);
});

test('sends message reactions through whatsapp', async () => {
  const { manager } = makeManager();

  await manager.start(2);
  const socket = manager.sessionFor(2).socket;
  const key = {
    id: 'IN-REACT-1',
    remoteJid: '60123456789@s.whatsapp.net',
    fromMe: false,
  };

  const response = await manager.sendReaction(2, '60123456789', '👍', key);

  assert.equal(response.reactionMessageId, 'IN-REACT-1');
  assert.equal(response.emoji, '👍');
  assert.deepEqual(socket.sent[0], {
    to: '60123456789@s.whatsapp.net',
    message: {
      react: {
        text: '👍',
        key,
      },
    },
    options: undefined,
  });
});

test('ignores invalid reaction message keys', () => {
  assert.equal(messageKeyFromPayload(null), null);
  assert.equal(messageKeyFromPayload({ remoteJid: '60123456789@s.whatsapp.net' }), null);
});

test('does not send stale ephemeral expiration after the chat disables disappearing messages', async () => {
  const { manager } = makeManager();

  await manager.start(2);
  const socket = manager.sessionFor(2).socket;
  socket.ev.emit('chats.update', [
    {
      id: '60123456789@s.whatsapp.net',
      ephemeralExpiration: 86400,
    },
  ]);
  socket.ev.emit('chats.update', [
    {
      id: '60123456789@s.whatsapp.net',
      ephemeralExpiration: 0,
    },
  ]);

  const response = await manager.sendMessage(2, '60123456789', 'Normal again');

  assert.equal(response.ephemeralExpiration, null);
  assert.equal(socket.sent[0].options, undefined);
});

test('learns disappearing message timer from inbound message context info for lid chats', async () => {
  const { manager } = makeManager();

  await manager.start(2);
  const socket = manager.sessionFor(2).socket;
  await socket.ev.emit('messages.upsert', {
    messages: [
      {
        key: {
          id: 'message-ephemeral-1',
          remoteJid: '72082536796288@lid',
          senderPn: '60136102545@s.whatsapp.net',
          fromMe: false,
        },
        messageTimestamp: 1779634752,
        message: {
          extendedTextMessage: {
            text: 'Takde email pun',
            contextInfo: { expiration: 86400 },
          },
        },
      },
    ],
  });

  const response = await manager.sendMessage(2, '72082536796288@lid', 'Reply');

  assert.equal(response.ephemeralExpiration, 86400);
  assert.deepEqual(socket.sent[0].options, { ephemeralExpiration: 86400 });
});

test('caches inbound disappearing message timer for the phone jid alias', async () => {
  const { manager } = makeManager();

  await manager.start(2);
  const socket = manager.sessionFor(2).socket;
  await socket.ev.emit('messages.upsert', {
    messages: [
      {
        key: {
          id: 'message-ephemeral-2',
          remoteJid: '72082536796288@lid',
          senderPn: '60136102545@s.whatsapp.net',
          fromMe: false,
        },
        messageTimestamp: 1779634752,
        message: {
          extendedTextMessage: {
            text: 'Ada kosong esok?',
            contextInfo: { expiration: 86400 },
          },
        },
      },
    ],
  });

  await manager.sendMessage(2, '60136102545', 'Phone alias reply');

  assert.deepEqual(socket.sent[0], {
    to: '60136102545@s.whatsapp.net',
    message: { text: 'Phone alias reply' },
    options: { ephemeralExpiration: 86400 },
  });
});

test('qr events include the correct management company id', async () => {
  const { manager, events } = makeManager();

  await manager.start(7);
  await manager.sessionFor(7).socket.ev.emit('connection.update', { qr: 'scan-me' });

  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'qr');
  assert.equal(events[0].managementCompanyId, 7);
  assert.equal(events[0].payload.qrDataUrl, 'data:image/png;base64,scan-me');
});

test('logged out closes clear stale auth and do not reconnect', async () => {
  const { manager, events } = makeManager();

  await manager.start(1);
  await manager.sessionFor(1).socket.ev.emit('connection.update', {
    connection: 'close',
    lastDisconnect: { error: { output: { statusCode: 401 } } },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(manager.status(1).state, 'disconnected');
  assert.equal(manager.sessionFor(1).socket, null);
  assert.deepEqual(events.find((event) => event.payload.loggedOut), {
    event: 'connection',
    managementCompanyId: 1,
    payload: {
      state: 'disconnected',
      loggedOut: true,
      authPath: '/tmp/rt-auth/1',
    },
  });
});

test('disconnect status can be read from baileys boom errors', () => {
  assert.equal(disconnectStatusCode({ output: { statusCode: 401 } }), 401);
});

test('message events include phone jid when whatsapp sends a lid remote jid', async () => {
  const { manager, events } = makeManager();

  await manager.start(1);
  await manager.sessionFor(1).socket.ev.emit('messages.upsert', {
    messages: [
      {
        key: {
          id: 'message-1',
          remoteJid: '72082536796288@lid',
          senderPn: '60136102545@s.whatsapp.net',
          fromMe: false,
        },
        pushName: 'Amran',
        messageTimestamp: 1779634752,
        message: { conversation: 'Hello' },
      },
    ],
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'message');
  assert.equal(events[0].payload.remoteJid, '72082536796288@lid');
  assert.equal(events[0].payload.phoneJid, '60136102545@s.whatsapp.net');
  assert.equal(events[0].payload.phone, '60136102545');
});

test('live whatsapp client messages are emitted as outbound fromMe messages', async () => {
  const { manager, events } = makeManager();

  await manager.start(2);
  await manager.sessionFor(2).socket.ev.emit('messages.upsert', {
    messages: [
      {
        key: {
          id: 'client-outbound-1',
          remoteJid: '60123456789@s.whatsapp.net',
          fromMe: true,
        },
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: { conversation: 'Sent from WhatsApp client' },
      },
    ],
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'message');
  assert.equal(events[0].payload.messageId, 'client-outbound-1');
  assert.equal(events[0].payload.remoteJid, '60123456789@s.whatsapp.net');
  assert.equal(events[0].payload.fromMe, true);
  assert.equal(events[0].payload.body, 'Sent from WhatsApp client');
});

test('requests on-demand whatsapp history before a known message', async () => {
  const { manager } = makeManager();

  await manager.start(2);
  const socket = manager.sessionFor(2).socket;
  const response = await manager.fetchRecentHistory(2, {
    id: 'known-message-1',
    remoteJid: '60123456789@s.whatsapp.net',
    fromMe: true,
  }, 1780584934, 100);

  assert.equal(response.ok, true);
  assert.equal(response.requestId, 'history-1');
  assert.equal(response.count, 50);
  assert.deepEqual(socket.historyRequests[0], {
    count: 50,
    messageKey: {
      id: 'known-message-1',
      remoteJid: '60123456789@s.whatsapp.net',
      fromMe: true,
    },
    timestamp: 1780584934,
  });
});

test('rejects on-demand history without a remote jid and timestamp', async () => {
  const { manager } = makeManager();

  await assert.rejects(
    () => manager.fetchRecentHistory(2, { id: 'known-message-1' }, 1780584934),
    /`messageKey` with `remoteJid` and `timestamp` are required\./,
  );
  await assert.rejects(
    () => manager.fetchRecentHistory(2, { id: 'known-message-1', remoteJid: '60123456789@s.whatsapp.net' }, 0),
    /`messageKey` with `remoteJid` and `timestamp` are required\./,
  );
});

test('media payloads are converted into baileys image content', () => {
  const content = mediaContentFromPayload({
    type: 'image',
    mimeType: 'image/png',
    caption: 'Receipt',
    base64: Buffer.from('fake-image').toString('base64'),
  });

  assert.equal(Buffer.isBuffer(content.image), true);
  assert.equal(content.mimetype, 'image/png');
  assert.equal(content.caption, 'Receipt');
});

test('video messages expose downloadable media metadata', () => {
  const info = mediaInfoFromMessage({
    videoMessage: {
      mimetype: 'video/mp4',
      fileName: 'guest-video.mp4',
      caption: 'Arrival video',
    },
  });

  assert.deepEqual(info, {
    type: 'video',
    mimeType: 'video/mp4',
    fileName: 'guest-video.mp4',
    caption: 'Arrival video',
  });
});

test('media payloads are converted into baileys voice content', () => {
  const content = mediaContentFromPayload({
    type: 'voice',
    mimeType: 'audio/ogg',
    base64: Buffer.from('fake-audio').toString('base64'),
  });

  assert.equal(Buffer.isBuffer(content.audio), true);
  assert.equal(content.mimetype, 'audio/ogg');
  assert.equal(content.ptt, true);
});
