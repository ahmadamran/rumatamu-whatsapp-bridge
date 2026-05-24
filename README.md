# Baileys Multi-Session Bridge

Standalone Node sidecar for WhatsApp messaging through Baileys. One container can run many Baileys sockets, with one socket/auth folder per external tenant id. RumaTamu keeps the connector/orchestration code and calls this container through `WHATSAPP_BRIDGE_URL`.

## Environment

- `PORT`: HTTP port, defaults to `3000`.
- `BRIDGE_TOKEN`: shared bearer token used by the connector and this bridge.
- `EVENT_WEBHOOK_URL`: connector endpoint for QR, connection, and message events.
- `LARAVEL_WEBHOOK_URL`: backwards-compatible alias for `EVENT_WEBHOOK_URL`.
- `AUTH_ROOT`: mounted root directory for Baileys auth state, defaults to `/data/auth`.

Each tenant session is stored under:

```text
/data/auth/{tenantId}
```

## HTTP API

All endpoints except `/health` require `Authorization: Bearer <BRIDGE_TOKEN>`.

- `GET /sessions/{tenantId}`
- `POST /sessions/{tenantId}/start`
- `POST /sessions/{tenantId}/stop`
- `POST /sessions/{tenantId}/logout`
- `POST /sessions/{tenantId}/messages/send`

The event payload uses `managementCompanyId` for compatibility with the current RumaTamu connector. Treat it as the caller-provided tenant id.

## Example Production Run

```bash
docker build -t baileys-multi-session-bridge .
docker volume create baileys-auth
docker run -d \
  --name rumatamu-whatsapp-bridge \
  --network codechu \
  -p 3000:3000 \
  -e BRIDGE_TOKEN="$MESSAGING_BRIDGE_TOKEN" \
  -e EVENT_WEBHOOK_URL="http://site-rumatamu-production-app/api/messaging/bridge/whatsapp/events" \
  -e AUTH_ROOT="/data/auth" \
  -v baileys-auth:/data/auth \
  baileys-multi-session-bridge
```

Set Laravel `WHATSAPP_BRIDGE_URL=http://rumatamu-whatsapp-bridge:3000` and the same `MESSAGING_BRIDGE_TOKEN`.
