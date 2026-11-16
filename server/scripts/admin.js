/* eslint-disable no-console */
/**
 * Admin account CLI. The password is typed at a hidden prompt and only its bcrypt
 * hash is stored: it never lives in the repo, an env file or a log.
 *
 *   npm run admin:create                   First admin. Refuses once any admin exists.
 *   npm run admin:reset-password [email]   Lost password or locked out: sets a new one,
 *                                          signs out every session, lifts the lockout.
 *
 * It goes through the same pieces as the HTTP auth flows rather than copies of them:
 * the sign-up / set-password validator chains (length, character classes, common and
 * personal passwords), the same email normalisation the admin login looks accounts up
 * by, and the same steps `resetPassword` takes once the new password is accepted.
 *
 * Non-interactive (CI / containers): set ADMIN_EMAIL, ADMIN_NAME and ADMIN_PASSWORD for
 * that one command only, and remove them afterwards.
 */
const readline = require('readline');
const mongoose = require('mongoose');
const { validationResult } = require('express-validator');
const env = require('../src/config/env');
const { connectDB, disconnectDB } = require('../src/config/db');
const { User } = require('../src/models');
const sessionService = require('../src/services/session.service');
const { registerRules, loginRules, setPasswordRules } = require('../src/validators/auth.validators');

const [command, emailArg] = process.argv.slice(2);

class CliError extends Error {}

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer);
    });
    // The prompt is already written; from here keystrokes are not echoed.
    if (hidden) rl._writeToOutput = () => {};
  });
}

/**
 * Runs express-validator chains against a request-shaped object, exactly as the
 * router would, and returns the sanitised body. The first failure becomes the error.
 */
async function runRules(rules, req) {
  for (const rule of rules) await rule.run(req);
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new CliError(errors.array()[0].msg);
  return req.body;
}

function interactive() {
  return Boolean(process.stdin.isTTY);
}

async function readPassword() {
  if (process.env.ADMIN_PASSWORD) {
    console.warn('⚠️  Using ADMIN_PASSWORD from the environment. Remove it once this command is done.');
    return { password: process.env.ADMIN_PASSWORD, confirmPassword: process.env.ADMIN_PASSWORD };
  }
  if (!interactive()) {
    throw new CliError(
      'No interactive terminal to type the password in. Run this in PowerShell, cmd or a normal terminal, ' +
        'or set ADMIN_PASSWORD for this one command.'
    );
  }
  const password = await ask('New password (hidden): ', { hidden: true });
  const confirmPassword = await ask('Repeat password: ', { hidden: true });
  return { password, confirmPassword };
}

async function readField(label, envValue, fallback) {
  if (envValue) return envValue;
  if (!interactive()) {
    if (fallback) return fallback;
    throw new CliError(`${label} is required. Set it in the environment for non-interactive use.`);
  }
  const answer = (await ask(fallback ? `${label} [${fallback}]: ` : `${label}: `)).trim();
  return answer || fallback || '';
}

async function createAdmin() {
  const existing = await User.findOne({ role: 'admin' }).select('email').lean();
  if (existing) {
    throw new CliError(
      `An admin already exists (${existing.email}). Use "npm run admin:reset-password" to set a new password.`
    );
  }

  const name = await readField('Name', process.env.ADMIN_NAME, 'Store Admin');
  const email = await readField('Email', emailArg || process.env.ADMIN_EMAIL);
  const { password, confirmPassword } = await readPassword();

  // The storefront sign-up rules: same messages, same normalised email.
  const body = await runRules(registerRules, { body: { name, email, password, confirmPassword } });
  if (body.confirmPassword !== body.password) throw new CliError('Passwords do not match');

  if (await User.exists({ email: body.email })) {
    throw new CliError(`An account with ${body.email} already exists. Pick another email for the admin.`);
  }

  // Staff accounts are verified from birth, which is what the admin login expects.
  await User.create({
    name: body.name,
    email: body.email,
    password: body.password,
    role: 'admin',
    authProviders: ['local'],
    isEmailVerified: true,
  });
  console.log(`✅ Admin ${body.email} created. Sign in to the admin panel with it.`);
}

async function resetPassword() {
  const admins = await User.find({ role: 'admin' }).select('email').lean();
  if (!admins.length) throw new CliError('No admin exists yet. Run "npm run admin:create" first.');

  const given = emailArg || process.env.ADMIN_EMAIL;
  const rawEmail = !given && admins.length === 1 ? admins[0].email : await readField('Admin email', given, admins[0].email);
  // The admin login's own email chain, so this finds the same account the panel does.
  const { email } = await runRules([loginRules[0]], { body: { email: rawEmail } });

  const user = await User.findOne({ email, role: 'admin' }).select('+password');
  if (!user) throw new CliError(`No admin account with the email ${email}`);
  if (user.status !== 'active') {
    throw new CliError(`${email} is ${user.status}; a new password would not let it sign in.`);
  }

  console.log(`Resetting the password for ${email}.`);
  const { password, confirmPassword } = await readPassword();
  if (confirmPassword !== password) throw new CliError('Passwords do not match');
  // set-password rules, with the account itself as the "personal words" context.
  await runRules(setPasswordRules, { body: { password }, user: { email: user.email, name: user.name } });
  if (await user.comparePassword(password)) {
    throw new CliError('New password must be different from the current one');
  }

  // Same steps as POST /auth/reset-password. Saving sets passwordChangedAt, which
  // also rejects access tokens issued before now.
  user.password = password;
  user.enableLocalLogin();
  user.passwordResetToken = undefined;
  user.passwordResetExpires = undefined;
  await user.save();
  await User.clearLoginAttempts(user._id);
  const revoked = await sessionService.revokeAllForUser(user._id, { reason: 'password-reset' });

  console.log(`✅ Password updated. ${revoked} active session(s) signed out; any lockout on the account is lifted.`);
}

const COMMANDS = { create: createAdmin, 'reset-password': resetPassword };

async function main() {
  const run = COMMANDS[command];
  if (!run) throw new CliError('Usage: node scripts/admin.js <create [email] | reset-password [email]>');
  env.assertValid();
  await connectDB();
  try {
    await run();
  } finally {
    await disconnectDB();
    await mongoose.disconnect().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err instanceof CliError ? `❌ ${err.message}` : err);
  process.exitCode = 1;
});
