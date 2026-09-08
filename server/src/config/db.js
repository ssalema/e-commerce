const mongoose = require('mongoose');
const env = require('./env');
const logger = require('../utils/logger');

mongoose.set('strictQuery', true);

async function connectDB() {
  const conn = await mongoose.connect(env.mongoUri, {
    serverSelectionTimeoutMS: 10000,
    maxPoolSize: 20,
    /**
     * A floor under the pool, so a burst does not pay to open connections on the
     * request path.
     *
     * With no minimum the driver lets an idle pool drain to nothing, which is exactly
     * the state the shop sits in before a sale opens or a campaign lands. The first
     * requests of the spike then each wait on a fresh TCP connection plus a TLS
     * handshake to the cluster before their query is even sent — the slowest requests
     * of the day arriving at the worst possible moment.
     *
     * Idle sockets are also recycled rather than held forever, so a quiet night does
     * not keep twenty stale connections open against the cluster's own limits.
     */
    minPoolSize: 5,
    maxIdleTimeMS: 60000,
  });
  console.log(`✅ MongoDB Connected`);

  mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));
  mongoose.connection.on('error', (err) => logger.error(`MongoDB error: ${err.message}`));

  return conn;
}

async function disconnectDB() {
  await mongoose.connection.close();
}

module.exports = { connectDB, disconnectDB };
