const http = require('http');

const env = require('./config/env');
const logger = require('./utils/logger');
const { connectDB, disconnectDB } = require('./config/db');
const app = require('./app');
const realtime = require('./realtime');
const sessionService = require('./services/session.service');
const commerceSettings = require('./services/commerce.service');
const viewCounter = require('./services/viewCounter');

let server;
let sessionSweeper;

/**
 * Marks login sessions that have gone idle past the policy as expired.
 *
 * Purely housekeeping: every read already ignores an idle session, so nothing
 * depends on this having run. It keeps the stored status honest for anyone reading
 * the collection directly, and Mongo's TTL index removes the rows afterwards.
 */
function startSessionSweeper() {
  const run = () =>
    sessionService
      .expireInactive()
      .then((count) => count && logger.info(`Expired ${count} inactive session(s)`))
      .catch((err) => logger.warn(`Session sweep failed: ${err.message}`));

  run();
  // Hourly is far finer than the multi-day policy it enforces, and `unref` keeps the
  // timer from holding the process open during shutdown.
  sessionSweeper = setInterval(run, 60 * 60 * 1000).unref();
}

async function start() {
  env.assertValid();
  await connectDB();

  // Delivery pricing and the return window live in the settings document now, and
  // the pricing service reads them synchronously on the request path — so the
  // snapshot is filled before the first request rather than on it.
  await commerceSettings.prime();

  // Socket.IO needs the raw HTTP server, so express no longer creates it itself.
  server = http.createServer(app);
  realtime.init(server);
  startSessionSweeper();
  // Product views accumulate in memory and are written in bulk rather than one $inc
  // per page load; this is the timer that drains them.
  viewCounter.start();

  server.listen(env.port, () => {
    console.log(`🚀 Server running on port ${env.port}`);
  });
}

/** Finish in-flight requests before exiting, then bail out if that stalls. */
async function shutdown(signal, code = 0) {
  logger.warn(`${signal} received — shutting down`);
  const force = setTimeout(() => process.exit(1), 10000).unref();
  clearInterval(sessionSweeper);

  // Close sockets first so open connections don't hold the HTTP server open.
  await realtime.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  // Whatever views are still buffered go out while the connection is still open.
  await viewCounter.stop();
  await disconnectDB();
  clearTimeout(force);
  process.exit(code);
}

process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled rejection: ${reason?.stack || reason}`);
  shutdown('unhandledRejection', 1);
});

process.on('uncaughtException', (err) => {
  // The process is in an unknown state — log and exit rather than limp along.
  logger.error(`Uncaught exception: ${err.stack}`);
  process.exit(1);
});

['SIGTERM', 'SIGINT'].forEach((sig) => process.on(sig, () => shutdown(sig)));

start().catch((err) => {
  logger.error(`Failed to start server: ${err.message}`);
  process.exit(1);
});
