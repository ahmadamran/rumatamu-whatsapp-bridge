import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import { Boom } from '@hapi/boom';

export function bodyFromMessage(message) {
  return (
    message?.conversation ||
    message?.extendedTextMessage?.text ||
    message?.imageMessage?.caption ||
    message?.videoMessage?.caption ||
    ''
  );
}

export function typeFromMessage(message) {
  const key = Object.keys(message || {})[0] || 'text';

  if (key === 'imageMessage') {
    return 'image';
  }

  if (key === 'audioMessage') {
    return 'audio';
  }

  return key.replace(/Message$/, '') || 'text';
}

export function mediaInfoFromMessage(message) {
  const image = message?.imageMessage;
  const audio = message?.audioMessage;

  if (image) {
    return {
      type: 'image',
      mimeType: image.mimetype || 'image/jpeg',
      fileName: image.fileName || null,
      caption: image.caption || '',
    };
  }

  if (audio) {
    return {
      type: audio.ptt ? 'voice' : 'audio',
      mimeType: audio.mimetype || 'audio/ogg',
      fileName: audio.fileName || null,
      voice: Boolean(audio.ptt),
    };
  }

  return null;
}

export function normalizeManagementCompanyId(value) {
  const id = Number(value);

  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error('A valid management company id is required.');
  }

  return id;
}

export function toWhatsappJid(value) {
  const to = String(value || '').trim();

  if (!to) {
    return '';
  }

  return to.includes('@') ? to : `${to.replace(/\D+/g, '')}@s.whatsapp.net`;
}

export function phoneJidFromMessage(item) {
  return (
    item?.key?.senderPn ||
    item?.key?.participantPn ||
    item?.senderPn ||
    item?.participantPn ||
    ''
  );
}

export function phoneFromJid(value) {
  return String(value || '').replace(/@.+$/, '').replace(/\D+/g, '');
}

export function mediaContentFromPayload(media = {}) {
  const payload = media || {};
  const type = String(payload.type || '').toLowerCase();
  const mimeType = String(payload.mimeType || payload.mimetype || '').toLowerCase();
  const buffer = payload.base64 ? Buffer.from(String(payload.base64), 'base64') : null;

  if (!buffer || !buffer.length) {
    return null;
  }

  if (type === 'image' || mimeType.startsWith('image/')) {
    return {
      image: buffer,
      caption: payload.caption || payload.body || undefined,
      mimetype: mimeType || undefined,
    };
  }

  if (['audio', 'voice'].includes(type) || mimeType.startsWith('audio/')) {
    return {
      audio: buffer,
      mimetype: mimeType || 'audio/ogg',
      ptt: type === 'voice' || Boolean(payload.voice),
    };
  }

  return null;
}

export function disconnectStatusCode(error) {
  if (!error) {
    return null;
  }

  return error?.output?.statusCode || error?.statusCode || new Boom(error)?.output?.statusCode || null;
}

export function normalizeEphemeralExpiration(value) {
  const expiration = Number(value || 0);

  return Number.isSafeInteger(expiration) && expiration > 0 ? expiration : null;
}

export function contextInfoFromMessage(message) {
  const content =
    message?.ephemeralMessage?.message ||
    message?.viewOnceMessage?.message ||
    message?.viewOnceMessageV2?.message ||
    message?.viewOnceMessageV2Extension?.message ||
    message;

  return (
    content?.extendedTextMessage?.contextInfo ||
    content?.imageMessage?.contextInfo ||
    content?.videoMessage?.contextInfo ||
    content?.documentMessage?.contextInfo ||
    content?.audioMessage?.contextInfo ||
    null
  );
}

export function ephemeralExpirationFromMessage(message) {
  const contextInfo = contextInfoFromMessage(message);

  if (!contextInfo || !Object.prototype.hasOwnProperty.call(contextInfo, 'expiration')) {
    return undefined;
  }

  return normalizeEphemeralExpiration(contextInfo.expiration);
}

export class WhatsappSessionManager {
  constructor({
    authRoot = '/data/auth',
    emit,
    logger,
    makeSocket = makeWASocket,
    authState = useMultiFileAuthState,
    latestVersion = fetchLatestBaileysVersion,
    qrToDataUrl = QRCode.toDataURL,
    reconnectDelay = 2500,
  }) {
    this.authRoot = authRoot;
    this.emit = emit;
    this.logger = logger;
    this.makeSocket = makeSocket;
    this.authState = authState;
    this.latestVersion = latestVersion;
    this.qrToDataUrl = qrToDataUrl;
    this.reconnectDelay = reconnectDelay;
    this.sessions = new Map();
  }

  sessionFor(managementCompanyId) {
    const id = normalizeManagementCompanyId(managementCompanyId);

    if (!this.sessions.has(id)) {
      this.sessions.set(id, {
        managementCompanyId: id,
        authDir: join(this.authRoot, String(id)),
        socket: null,
        connectionState: 'disconnected',
        latestQr: null,
        latestQrDataUrl: null,
        startPromise: null,
        ephemeralExpirations: new Map(),
      });
    }

    return this.sessions.get(id);
  }

  status(managementCompanyId) {
    const session = this.sessionFor(managementCompanyId);

    return {
      managementCompanyId: session.managementCompanyId,
      state: session.connectionState,
      connected: session.connectionState === 'connected',
      qr: session.latestQr,
      qrDataUrl: session.latestQrDataUrl,
      accountId: session.socket?.user?.id || null,
      authPath: session.authDir,
    };
  }

  async start(managementCompanyId) {
    const session = this.sessionFor(managementCompanyId);

    if (session.startPromise) {
      await session.startPromise;
      return this.status(session.managementCompanyId);
    }

    if (session.socket) {
      return this.status(session.managementCompanyId);
    }

    session.connectionState = 'connecting';
    session.startPromise = this.createSocket(session);

    try {
      await session.startPromise;
      return this.status(session.managementCompanyId);
    } finally {
      session.startPromise = null;
    }
  }

  async createSocket(session) {
    const { state, saveCreds } = await this.authState(session.authDir);
    const { version } = await this.latestVersion();
    const socket = this.makeSocket({
      auth: state,
      browser: ['RumaTamu', 'Chrome', '1.0.0'],
      logger: this.logger?.child ? this.logger.child({ module: 'baileys', managementCompanyId: session.managementCompanyId }) : this.logger,
      printQRInTerminal: false,
      version,
    });

    session.socket = socket;
    socket.ev.on('creds.update', saveCreds);
    socket.ev.on('connection.update', (update) => this.handleConnectionUpdate(session, update));
    socket.ev.on('messaging-history.set', (payload) => this.handleChatSet(session, payload?.chats || []));
    socket.ev.on('chats.upsert', (chats) => this.handleChatSet(session, chats || []));
    socket.ev.on('chats.update', (updates) => this.handleChatSet(session, updates || []));
    socket.ev.on('messages.upsert', (payload) => this.handleMessages(session, payload));

    return socket;
  }

  handleChatSet(session, chats) {
    for (const chat of chats || []) {
      const jid = chat?.id;

      if (!jid) {
        continue;
      }

      if (!Object.prototype.hasOwnProperty.call(chat, 'ephemeralExpiration')) {
        continue;
      }

      this.cacheEphemeralExpiration(session, [jid], chat.ephemeralExpiration);
    }
  }

  cacheEphemeralExpiration(session, jids, value) {
    const expiration = normalizeEphemeralExpiration(value);

    for (const jid of jids || []) {
      if (!jid) {
        continue;
      }

      if (expiration) {
        session.ephemeralExpirations.set(jid, expiration);
      } else {
        session.ephemeralExpirations.delete(jid);
      }
    }
  }

  syncEphemeralAliases(session, jids) {
    const aliases = (jids || []).filter(Boolean);
    const expiration = aliases.map((jid) => session.ephemeralExpirations.get(jid)).find(Boolean);

    if (!expiration) {
      return;
    }

    for (const jid of aliases) {
      session.ephemeralExpirations.set(jid, expiration);
    }
  }

  async handleConnectionUpdate(session, update) {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      session.latestQr = qr;
      session.latestQrDataUrl = await this.qrToDataUrl(qr, { margin: 1, scale: 6 });
      session.connectionState = 'qr_required';
      await this.emit('qr', session.managementCompanyId, {
        qr: session.latestQr,
        qrDataUrl: session.latestQrDataUrl,
        authPath: session.authDir,
      });
    }

    if (connection) {
      session.connectionState = connection === 'open' ? 'connected' : connection;
      await this.emit('connection', session.managementCompanyId, {
        state: session.connectionState,
        accountId: session.socket?.user?.id,
        error: lastDisconnect?.error?.message,
        authPath: session.authDir,
      });
    }

    if (connection === 'open') {
      session.latestQr = null;
      session.latestQrDataUrl = null;
    }

    if (connection === 'close') {
      const statusCode = disconnectStatusCode(lastDisconnect?.error);
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      session.socket = null;
      session.startPromise = null;

      if (!shouldReconnect) {
        session.connectionState = 'disconnected';
        session.latestQr = null;
        session.latestQrDataUrl = null;
        await rm(session.authDir, { recursive: true, force: true });

        await this.emit('connection', session.managementCompanyId, {
          state: 'disconnected',
          loggedOut: true,
          authPath: session.authDir,
        });

        return;
      }

      if (shouldReconnect) {
        setTimeout(() => {
          this.start(session.managementCompanyId).catch((error) => {
            this.logger?.error?.({ error, managementCompanyId: session.managementCompanyId }, 'Reconnect failed');
          });
        }, this.reconnectDelay);
      }
    }
  }

  async mediaPayloadForMessage(item) {
    const info = mediaInfoFromMessage(item.message);

    if (!info) {
      return null;
    }

    try {
      const buffer = await downloadMediaMessage(item, 'buffer', {}, {
        logger: this.logger?.child ? this.logger.child({ module: 'baileys-media' }) : this.logger,
      });

      return {
        ...info,
        base64: buffer.toString('base64'),
        size: buffer.length,
      };
    } catch (error) {
      this.logger?.warn?.({ error, messageId: item.key?.id }, 'Unable to download WhatsApp media');

      return {
        ...info,
        downloadError: error?.message || 'Unable to download WhatsApp media.',
      };
    }
  }

  async handleMessages(session, { messages }) {
    for (const item of messages || []) {
      if (!item.message || item.key.fromMe) {
        continue;
      }

      const remoteJid = item.key.remoteJid;
      const phoneJid = phoneJidFromMessage(item);
      const expiration = ephemeralExpirationFromMessage(item.message);

      if (expiration !== undefined) {
        this.cacheEphemeralExpiration(session, [remoteJid, phoneJid], expiration);
      } else {
        this.syncEphemeralAliases(session, [remoteJid, phoneJid]);
      }

      const type = typeFromMessage(item.message);
      const media = await this.mediaPayloadForMessage(item);

      await this.emit('message', session.managementCompanyId, {
        messageId: item.key.id,
        remoteJid,
        phoneJid,
        phone: phoneFromJid(phoneJid),
        pushName: item.pushName,
        timestamp: Number(item.messageTimestamp || Math.floor(Date.now() / 1000)),
        type,
        body: bodyFromMessage(item.message),
        media,
        payload: item,
      });
    }
  }

  async stop(managementCompanyId) {
    const session = this.sessionFor(managementCompanyId);

    session.socket?.end?.();
    session.socket = null;
    session.startPromise = null;
    session.connectionState = 'disconnected';

    await this.emit('connection', session.managementCompanyId, {
      state: 'disconnected',
      authPath: session.authDir,
    });

    return this.status(session.managementCompanyId);
  }

  async logout(managementCompanyId) {
    const session = this.sessionFor(managementCompanyId);

    if (session.socket?.logout) {
      await session.socket.logout();
    } else {
      session.socket?.end?.();
    }

    session.socket = null;
    session.startPromise = null;
    session.connectionState = 'disconnected';
    session.latestQr = null;
    session.latestQrDataUrl = null;
    await rm(session.authDir, { recursive: true, force: true });

    await this.emit('connection', session.managementCompanyId, {
      state: 'disconnected',
      loggedOut: true,
      authPath: session.authDir,
    });

    return this.status(session.managementCompanyId);
  }

  async sendMessage(managementCompanyId, to, body, media = null) {
    if (!to || (!body && !media)) {
      throw new Error('`to` and `body` or `media` are required.');
    }

    await this.start(managementCompanyId);
    const session = this.sessionFor(managementCompanyId);
    if (!session.socket) {
      throw new Error('WhatsApp session is not connected.');
    }

    const jid = toWhatsappJid(to);
    const mediaContent = mediaContentFromPayload(media);
    const ephemeralExpiration = session.ephemeralExpirations.get(jid);
    const options = ephemeralExpiration ? { ephemeralExpiration } : undefined;
    const result = await session.socket.sendMessage(jid, mediaContent || { text: String(body) }, options);

    return {
      ok: true,
      managementCompanyId: session.managementCompanyId,
      messageId: result?.key?.id || null,
      to: jid,
      mediaType: mediaContent ? String(media?.type || 'media') : null,
      ephemeralExpiration: ephemeralExpiration || null,
    };
  }
}
