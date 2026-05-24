import express from 'express';
import P from 'pino';
import { requireToken } from './auth.js';
import { normalizeManagementCompanyId, WhatsappSessionManager } from './session-manager.js';

const port = Number(process.env.PORT || 3000);
const authRoot = process.env.AUTH_ROOT || process.env.AUTH_DIR || '/data/auth';
const bridgeToken = process.env.BRIDGE_TOKEN || '';
const webhookUrl = process.env.EVENT_WEBHOOK_URL || process.env.LARAVEL_WEBHOOK_URL || '';
const logger = P({ level: process.env.LOG_LEVEL || 'info' });

async function emit(event, managementCompanyId, payload = {}) {
  if (!webhookUrl || !bridgeToken) {
    logger.warn({ event, managementCompanyId }, 'Webhook skipped because EVENT_WEBHOOK_URL or BRIDGE_TOKEN is missing');
    return;
  }

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bridgeToken}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        event,
        managementCompanyId,
        ...payload,
      }),
    });

    if (!response.ok) {
      logger.warn({ status: response.status, body: await response.text(), managementCompanyId }, 'Event webhook failed');
    }
  } catch (error) {
    logger.warn({ error, managementCompanyId }, 'Event webhook unreachable');
  }
}

export function createApp({ manager } = {}) {
  const app = express();
  const sessionManager = manager || new WhatsappSessionManager({ authRoot, emit, logger });

  app.use(express.json({ limit: process.env.JSON_LIMIT || '25mb' }));

  app.get('/health', (request, response) => {
    response.json({ ok: true, sessions: sessionManager.sessions?.size || 0 });
  });

  app.use(requireToken(bridgeToken));

  app.param('managementCompanyId', (request, response, next, value) => {
    try {
      request.managementCompanyId = normalizeManagementCompanyId(value);
      next();
    } catch (error) {
      response.status(422).json({ message: error.message });
    }
  });

  app.get('/sessions/:managementCompanyId', (request, response) => {
    response.json(sessionManager.status(request.managementCompanyId));
  });

  app.post('/sessions/:managementCompanyId/start', async (request, response, next) => {
    try {
      response.json(await sessionManager.start(request.managementCompanyId));
    } catch (error) {
      next(error);
    }
  });

  app.post('/sessions/:managementCompanyId/stop', async (request, response, next) => {
    try {
      response.json(await sessionManager.stop(request.managementCompanyId));
    } catch (error) {
      next(error);
    }
  });

  app.post('/sessions/:managementCompanyId/logout', async (request, response, next) => {
    try {
      response.json(await sessionManager.logout(request.managementCompanyId));
    } catch (error) {
      next(error);
    }
  });

  app.post('/sessions/:managementCompanyId/messages/send', async (request, response, next) => {
    try {
      const { to, body, media } = request.body || {};
      response.json(await sessionManager.sendMessage(request.managementCompanyId, to, body, media));
    } catch (error) {
      if (error.message === '`to` and `body` or `media` are required.') {
        response.status(422).json({ message: error.message });
        return;
      }

      next(error);
    }
  });

  app.use((error, request, response, next) => {
    logger.error({ error, managementCompanyId: request.managementCompanyId }, 'Request failed');
    response.status(500).json({ message: error.message || 'Bridge request failed.' });
  });

  return app;
}

if (process.env.NODE_ENV !== 'test') {
  createApp().listen(port, () => {
    logger.info({ port, authRoot }, 'Baileys multi-session bridge listening');
  });
}
