'use strict';

const path = require('node:path');

const { JsonFileRoleApplicationRepository } = require('./lib/repository');
const { createRoleApplicationServer } = require('./lib/server');

const port = Number.parseInt(process.env.PORT || '4101', 10);
const dataFile = process.env.ROLE_APPLICATION_DATA_FILE || path.join(__dirname, 'data', 'role-applications.json');
const repository = new JsonFileRoleApplicationRepository(dataFile);
const server = createRoleApplicationServer({ repository });

// Deliberately bind to loopback. This artifact is a local validation harness,
// not a deployment or a publicly reachable service.
server.listen(port, '127.0.0.1', () => {
  console.log(`role-application-flow listening on http://127.0.0.1:${port}`);
  console.log(`persistence: ${dataFile}`);
});

function shutdown(signal) {
  server.close(() => {
    console.log(`closed after ${signal}`);
    process.exit(0);
  });
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
