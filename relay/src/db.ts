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

/** A client that registered itself (RFC 7591); a metadata-document client is never stored. */
export interface OAuthClient {
  id: string;
  secretHash: string | null;
  name: string;
  redirectUris: string[];
  createdAt: number;
}

export interface OAuthCode {
  hash: string;
  userId: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  expiresAt: number;
}

/** One approval by one user for one client: the pair of tokens that came out of it. */
export interface OAuthGrant {
  id: string;
  userId: string;
  clientId: string;
  clientName: string;
  scope: string;
  accessHash: string;
  refreshHash: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
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
      CREATE TABLE IF NOT EXISTS oauth_clients (
        id TEXT PRIMARY KEY,
        secret_hash TEXT,
        name TEXT NOT NULL,
        redirect_uris TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oauth_codes (
        hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        client_id TEXT NOT NULL,
        client_name TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        scope TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oauth_grants (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        client_id TEXT NOT NULL,
        client_name TEXT NOT NULL,
        scope TEXT NOT NULL,
        access_hash TEXT NOT NULL UNIQUE,
        refresh_hash TEXT NOT NULL UNIQUE,
        access_expires_at INTEGER NOT NULL,
        refresh_expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked_at INTEGER
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

  // ---- oauth ---------------------------------------------------------------

  createOAuthClient(client: OAuthClient): void {
    this.db
      .prepare('INSERT INTO oauth_clients (id, secret_hash, name, redirect_uris, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(client.id, client.secretHash, client.name, JSON.stringify(client.redirectUris), client.createdAt);
  }

  findOAuthClient(id: string): OAuthClient | null {
    const r = this.db.prepare('SELECT * FROM oauth_clients WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      id: String(r['id']),
      secretHash: r['secret_hash'] == null ? null : String(r['secret_hash']),
      name: String(r['name']),
      redirectUris: JSON.parse(String(r['redirect_uris'])) as string[],
      createdAt: Number(r['created_at']),
    };
  }

  createOAuthCode(code: OAuthCode): void {
    this.db
      .prepare(
        `INSERT INTO oauth_codes (hash, user_id, client_id, client_name, redirect_uri, code_challenge, scope, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(code.hash, code.userId, code.clientId, code.clientName, code.redirectUri, code.codeChallenge, code.scope, code.expiresAt);
  }

  /** Reads and deletes in one step, so a code can be exchanged exactly once. */
  consumeOAuthCode(hash: string): OAuthCode | null {
    const r = this.db.prepare('DELETE FROM oauth_codes WHERE hash = ? RETURNING *').get(hash) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      hash: String(r['hash']),
      userId: String(r['user_id']),
      clientId: String(r['client_id']),
      clientName: String(r['client_name']),
      redirectUri: String(r['redirect_uri']),
      codeChallenge: String(r['code_challenge']),
      scope: String(r['scope']),
      expiresAt: Number(r['expires_at']),
    };
  }

  createOAuthGrant(grant: OAuthGrant): void {
    this.db
      .prepare(
        `INSERT INTO oauth_grants (id, user_id, client_id, client_name, scope, access_hash, refresh_hash,
           access_expires_at, refresh_expires_at, created_at, last_used_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      )
      .run(
        grant.id, grant.userId, grant.clientId, grant.clientName, grant.scope, grant.accessHash, grant.refreshHash,
        grant.accessExpiresAt, grant.refreshExpiresAt, grant.createdAt,
      );
  }

  findOAuthGrantByAccess(hash: string): OAuthGrant | null {
    return this.rowToGrant(this.db.prepare('SELECT * FROM oauth_grants WHERE access_hash = ?').get(hash));
  }

  findOAuthGrantByRefresh(hash: string): OAuthGrant | null {
    return this.rowToGrant(this.db.prepare('SELECT * FROM oauth_grants WHERE refresh_hash = ?').get(hash));
  }

  /** A refresh replaces both tokens; the old refresh token stops working at once. */
  rotateOAuthGrant(id: string, next: { accessHash: string; refreshHash: string; accessExpiresAt: number; refreshExpiresAt: number }): void {
    this.db
      .prepare('UPDATE oauth_grants SET access_hash = ?, refresh_hash = ?, access_expires_at = ?, refresh_expires_at = ? WHERE id = ?')
      .run(next.accessHash, next.refreshHash, next.accessExpiresAt, next.refreshExpiresAt, id);
  }

  touchOAuthGrant(id: string): void {
    this.db.prepare('UPDATE oauth_grants SET last_used_at = ? WHERE id = ?').run(Date.now(), id);
  }

  /** Revokes one grant, only if it belongs to that user; true if a row changed. */
  revokeOAuthGrant(id: string, userId: string): boolean {
    const result = this.db
      .prepare('UPDATE oauth_grants SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL')
      .run(Date.now(), id, userId);
    return Number(result.changes) === 1;
  }

  /** The live grants for the dashboard, newest first. */
  listOAuthGrants(userId: string): OAuthGrant[] {
    const rows = this.db
      .prepare('SELECT * FROM oauth_grants WHERE user_id = ? AND revoked_at IS NULL AND refresh_expires_at > ? ORDER BY created_at DESC')
      .all(userId, Date.now());
    return rows.map((r) => this.rowToGrant(r)!);
  }

  /** Expired codes and long-dead grants have nothing left to say. */
  pruneOAuth(now = Date.now()): void {
    this.db.prepare('DELETE FROM oauth_codes WHERE expires_at < ?').run(now);
    this.db.prepare('DELETE FROM oauth_grants WHERE refresh_expires_at < ? OR revoked_at < ?').run(now, now - 30 * 24 * 60 * 60 * 1000);
  }

  close(): void {
    this.db.close();
  }

  private rowToGrant(row: unknown): OAuthGrant | null {
    const r = row as Record<string, unknown> | undefined;
    if (!r) return null;
    const num = (v: unknown) => (v == null ? null : Number(v));
    return {
      id: String(r['id']),
      userId: String(r['user_id']),
      clientId: String(r['client_id']),
      clientName: String(r['client_name']),
      scope: String(r['scope']),
      accessHash: String(r['access_hash']),
      refreshHash: String(r['refresh_hash']),
      accessExpiresAt: Number(r['access_expires_at']),
      refreshExpiresAt: Number(r['refresh_expires_at']),
      createdAt: Number(r['created_at']),
      lastUsedAt: num(r['last_used_at']),
      revokedAt: num(r['revoked_at']),
    };
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
