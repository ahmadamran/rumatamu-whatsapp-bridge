import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requireToken } from './auth.js';

function runMiddleware(expectedToken, header) {
  let statusCode = null;
  let body = null;
  let nextCalled = false;

  requireToken(expectedToken)(
    { get: () => header },
    {
      status(code) {
        statusCode = code;
        return this;
      },
      json(payload) {
        body = payload;
      },
    },
    () => {
      nextCalled = true;
    },
  );

  return { statusCode, body, nextCalled };
}

test('requires configured bearer token', () => {
  assert.deepEqual(runMiddleware('secret', 'Bearer bad'), {
    statusCode: 401,
    body: { message: 'Unauthorized.' },
    nextCalled: false,
  });

  assert.deepEqual(runMiddleware('secret', 'Bearer secret'), {
    statusCode: null,
    body: null,
    nextCalled: true,
  });
});
