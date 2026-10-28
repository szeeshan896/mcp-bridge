import { createHash, randomBytes } from 'node:crypto';

/**
 * Sign in with Google, as OpenID Connect's authorization-code flow with PKCE. Endpoints
 * are the ones Google's discovery document publishes. Nothing here is Google-specific
 * beyond those URLs; the shape is the standard one.
 *
 * <p>Enabled only when a client id and secret are configured, because they have to be
 * registered by the operator in Google Cloud Console with this relay's callback URL.
 */
export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
}

export interface GoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
}

const AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';

export function callbackUrl(publicUrl: string): string {
  return new URL('/auth/google/callback', publicUrl).toString();
}

/** A verifier for the cookie and the S256 challenge Google gets; the code is useless without the verifier. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function newState(): string {
  return randomBytes(16).toString('base64url');
}

export function authorizationUrl(config: GoogleConfig, redirectUri: string, state: string, challenge: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return `${AUTHORIZATION_ENDPOINT}?${params.toString()}`;
}

/**
 * Trades the code for tokens and asks Google who this is. The identity comes from the
 * userinfo endpoint over TLS with the access token Google just issued, which is why the id
 * token's signature does not also need checking here.
 */
export async function exchangeCode(
  config: GoogleConfig,
  redirectUri: string,
  code: string,
  verifier: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GoogleIdentity> {
  const tokenResponse = await fetchImpl(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
  });
  if (!tokenResponse.ok) {
    throw new Error(`Google refused the code (HTTP ${tokenResponse.status})`);
  }
  const tokens = (await tokenResponse.json()) as { access_token?: string };
  if (!tokens.access_token) throw new Error('Google returned no access token');

  const infoResponse = await fetchImpl(USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!infoResponse.ok) throw new Error(`Google userinfo failed (HTTP ${infoResponse.status})`);
  const info = (await infoResponse.json()) as { sub?: string; email?: string; email_verified?: boolean };
  if (!info.sub || !info.email) throw new Error('Google returned no identity');
  return { sub: info.sub, email: info.email, emailVerified: info.email_verified === true };
}
