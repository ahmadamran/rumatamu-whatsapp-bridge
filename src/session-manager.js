import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import makeWASocket, {
  DisconnectReason,
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
    socket.ev.on('messages.upsert', (payload) => this.handleMessages(session, payload));

    return socket;
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
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      session.socket = null;
      session.startPromise = null;

      if (shouldReconnect) {
        setTimeout(() => {
          this.start(session.managementCompanyId).catch((error) => {
            this.logger?.error?.({ error, managementCompanyId: session.managementCompanyId }, 'Reconnect failed');
          });
        }, this.reconnectDelay);
      }
    }
  }

  async handleMessages(session, { messages }) {
    for (const item of messages || []) {
      if (!item.message || item.key.fromMe) {
        continue;
      }

      await this.emit('message', session.managementCompanyId, {
        messageId: item.key.id,
        remoteJid: item.key.remoteJid,
        phoneJid: phoneJidFromMessage(item),
        phone: phoneFromJid(phoneJidFromMessage(item)),
        pushName: item.pushName,
        timestamp: Number(item.messageTimestamp || Math.floor(Date.now() / 1000)),
        type: Object.keys(item.message)[0] || 'text',
        body: bodyFromMessage(item.message),
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

  async sendMessage(managementCompanyId, to, body) {
    if (!to || !body) {
      throw new Error('`to` and `body` are required.');
    }

    await this.start(managementCompanyId);
    const session = this.sessionFor(managementCompanyId);
    if (!session.socket) {
      throw new Error('WhatsApp session is not connected.');
    }

    const jid = toWhatsappJid(to);
    const result = await session.socket.sendMessage(jid, { text: String(body) });

    return {
      ok: true,
      managementCompanyId: session.managementCompanyId,
      messageId: result?.key?.id || null,
      to: jid,
    };
  }
}
