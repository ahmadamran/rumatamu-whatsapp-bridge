import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { mediaContentFromPayload, WhatsappSessionManager } from './session-manager.js';

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
        ev: new EventEmitter(),
        user: { id: `user-${sockets.size + 1}` },
        sent: [],
        endCalled: false,
        async sendMessage(to, message) {
          this.sent.push({ to, message });
          return { key: { id: `message-${this.sent.length}` } };
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
