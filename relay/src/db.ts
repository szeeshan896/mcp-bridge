import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { UsernameType } from './identity.js';

export type TokenKind = 'agent' | 'client';

export interface User {
  id: string;
  username: string;
  usernameType: UsernameType;
  /** null for an account that only ever signed in with Google */
  passwordHash: string | null;
  googleSub: string | null;
  totpSecret: string | null;
  /** set once the person has proven they can produce a code; null means 2FA is off */
  totpEnabledAt: number | null;
  createdAt: number;
}

export interface TokenRecord {
  userId: string;
  kind: TokenKind;
  hash: string;
  createdAt: number;
  lastUsedAt: number | null;
}

/**
 * Accounts and tokens, in SQLite through node's built-in binding — no native module to
 * compile in a container, one file to back up.
 *
 * <p>Tokens and recovery codes are stored as hashes only. A leaked database then yields
 * nothing that can connect an agent, delegate as a user, or pass a 2FA check.
 */
export class Db {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        username_type TEXT NOT NULL CHECK (username_type IN ('email', 'phone')),
        password_hash TEXT,
        google_sub TEXT UNIQUE,
        totp_secret TEXT,
        totp_enabled_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tokens (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('agent', 'client')),
        hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        PRIMARY KEY (user_id, kind)
      );
      CREATE TABLE IF NOT EXISTS recovery_codes (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        hash TEXT NOT NULL UNIQUE,
        used_at INTEGER
      );
    `);
  }

  // ---- users ---------------------------------------------------------------

  createUser(user: {
    id: string;
    username: string;
    usernameType: UsernameType;
    passwordHash?: string;
    googleSub?: string;
  }): User {
    const createdAt = Date.now();
    this.db
      .prepare(
        'INSERT INTO users (id, username, username_type, password_hash, google_sub, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(user.id, user.username, user.usernameType, user.passwordHash ?? null, user.googleSub ?? null, createdAt);
    return this.findUserById(user.id)!;
  }

  findUserByUsername(username: string): User | null {
    return this.rowToUser(this.db.prepare('SELECT * FROM users WHERE username = ?').get(username));
  }

  findUserByGoogleSub(sub: string): User | null {
    return this.rowToUser(this.db.prepare('SELECT * FROM users WHERE google_sub = ?').get(sub));
  }

  findUserById(id: string): User | null {
    return this.rowToUser(this.db.prepare('SELECT * FROM users WHERE id = ?').get(id));
  }

  setPassword(userId: string, passwordHash: string): void {
    this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, userId);
  }

  linkGoogle(userId: string, sub: string): void {
    this.db.prepare('UPDATE users SET google_sub = ? WHERE id = ?').run(sub, userId);
  }

  /** A secret with no enabled_at is an enrolment in progress; both null turns 2FA off. */
  setTotp(userId: string, secret: string | null, enabledAt: number | null): void {
    this.db.prepare('UPDATE users SET totp_secret = ?, totp_enabled_at = ? WHERE id = ?').run(secret, enabledAt, userId);
  }

  // ---- recovery codes ------------------------------------------------------

  replaceRecoveryCodes(userId: string, hashes: string[]): void {
    const del = this.db.prepare('DELETE FROM recovery_codes WHERE user_id = ?');
    const ins = this.db.prepare('INSERT INTO recovery_codes (user_id, hash) VALUES (?, ?)');
    del.run(userId);
    for (const hash of hashes) ins.run(userId, hash);
  }

  /** Burns a recovery code; false if it is unknown or already used. */
  consumeRecoveryCode(userId: string, hash: string): boolean {
    const result = this.db
      .prepare('UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND hash = ? AND used_at IS NULL')
      .run(Date.now(), userId, hash);
    return Number(result.changes) === 1;
  }

  unusedRecoveryCodeCount(userId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL')
      .get(userId) as { n: number };
    return Number(row.n);
  }

  // ---- tokens --------------------------------------------------------------

  /** One token per kind per user: setting a new one revokes the old by replacing it. */
  setToken(userId: string, kind: TokenKind, hash: string): void {
    this.db
      .prepare(
        `INSERT INTO tokens (user_id, kind, hash, created_at, last_used_at) VALUES (?, ?, ?, ?, NULL)
         ON CONFLICT (user_id, kind) DO UPDATE SET hash = excluded.hash, created_at = excluded.created_at, last_used_at = NULL`,
      )
      .run(userId, kind, hash, Date.now());
  }

  findToken(hash: string, kind: TokenKind): TokenRecord | null {
    const row = this.db.prepare('SELECT * FROM tokens WHERE hash = ? AND kind = ?').get(hash, kind) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      userId: String(row['user_id']),
      kind: row['kind'] as TokenKind,
      hash: String(row['hash']),
      createdAt: Number(row['created_at']),
      lastUsedAt: row['last_used_at'] == null ? null : Number(row['last_used_at']),
    };
  }

  tokenInfo(userId: string, kind: TokenKind): { createdAt: number; lastUsedAt: number | null } | null {
    const row = this.db
      .prepare('SELECT created_at, last_used_at FROM tokens WHERE user_id = ? AND kind = ?')
      .get(userId, kind) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      createdAt: Number(row['created_at']),
      lastUsedAt: row['last_used_at'] == null ? null : Number(row['last_used_at']),
    };
  }

  touchToken(hash: string): void {
    this.db.prepare('UPDATE tokens SET last_used_at = ? WHERE hash = ?').run(Date.now(), hash);
  }

  close(): void {
    this.db.close();
  }

  private rowToUser(row: unknown): User | null {
    const r = row as Record<string, unknown> | undefined;
    if (!r) return null;
    const num = (v: unknown) => (v == null ? null : Number(v));
    const str = (v: unknown) => (v == null ? null : String(v));
    return {
      id: String(r['id']),
      username: String(r['username']),
      usernameType: r['username_type'] as UsernameType,
      passwordHash: str(r['password_hash']),
      googleSub: str(r['google_sub']),
      totpSecret: str(r['totp_secret']),
      totpEnabledAt: num(r['totp_enabled_at']),
      createdAt: Number(r['created_at']),
    };
  }
}
