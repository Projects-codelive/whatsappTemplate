/**
 * Firebase Cloud Messaging — HTTP v1 client.
 *
 * This is the Next.js App Router port of the reference FCM integration
 * (public/demo.js). Only the notification-sending logic is reused:
 *   - access token via GoogleAuth (OAuth2, firebase.messaging scope)
 *   - POST https://fcm.googleapis.com/v1/projects/{project}/messages:send
 *   - notification { title, body }, data { type, agent },
 *     android { priority: HIGH, channel_id }
 *
 * The Express server, MySQL access and axios calls are NOT carried over —
 * sends use global `fetch` and recipients come from Supabase.
 *
 * Server-only. Never import this from a client component.
 */

import { GoogleAuth } from 'google-auth-library';
import { readFileSync } from 'node:fs';

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const FCM_BASE_URL = 'https://fcm.googleapis.com/v1/projects';
const FCM_CHANNEL_ID = 'promo_channel';
/** Node's `fetch` never times out on its own; a hung Firebase endpoint
 *  would otherwise stall the whole route until the platform kills it. */
const FCM_REQUEST_TIMEOUT_MS = 10_000;

/** FCM registration tokens are ~160-char opaque strings. Shorter values
 *  are almost certainly junk — the reference used this same heuristic. */
export const MIN_FCM_TOKEN_LENGTH = 100;

interface FirebaseServiceAccount {
  project_id?: string;
  client_email?: string;
  private_key?: string;
  [key: string]: unknown;
}

interface AccessTokenCache {
  token: string;
  expiresAt: number;
}

let accessTokenCache: AccessTokenCache | null = null;

function loadServiceAccount(): FirebaseServiceAccount {
  const inline = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (inline) {
    try {
      return JSON.parse(inline) as FirebaseServiceAccount;
    } catch {
      throw new Error(
        '[fcm] FIREBASE_SERVICE_ACCOUNT is set but is not valid JSON',
      );
    }
  }

  const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (keyFile) {
    try {
      return JSON.parse(readFileSync(keyFile, 'utf8')) as FirebaseServiceAccount;
    } catch {
      throw new Error(
        `[fcm] failed to read Firebase service account file at ${keyFile}`,
      );
    }
  }

  throw new Error(
    '[fcm] Firebase credentials missing: set FIREBASE_SERVICE_ACCOUNT or GOOGLE_APPLICATION_CREDENTIALS',
  );
}

function loadProjectId(): string {
  const override = process.env.FIREBASE_PROJECT_ID;
  if (override) return override;
  const projectId = loadServiceAccount().project_id;
  if (!projectId) {
    throw new Error(
      '[fcm] cannot resolve Firebase project id — set FIREBASE_PROJECT_ID or provide a service account with project_id',
    );
  }
  return projectId;
}

/**
 * OAuth2 access token for FCM. Cached for ~45 minutes (tokens live 1 hour)
 * so a multi-recipient send only authenticates once.
 */
export async function getFcmAccessToken(): Promise<string> {
  const now = Date.now();
  if (accessTokenCache && accessTokenCache.expiresAt > now) {
    return accessTokenCache.token;
  }

  const auth = new GoogleAuth({
    credentials: loadServiceAccount(),
    scopes: [FCM_SCOPE],
  });
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();

  if (!token) {
    throw new Error('[fcm] Firebase returned no access token (authentication failed)');
  }

  accessTokenCache = { token, expiresAt: now + 45 * 60 * 1000 };
  return token;
}

/** Loose validity check — null/empty/short tokens are never sent. */
export function isValidFcmToken(token: string | null | undefined): token is string {
  return typeof token === 'string' && token.length >= MIN_FCM_TOKEN_LENGTH;
}

interface BuildFcmMessageArgs {
  token: string;
  title: string;
  body: string;
  /** Optional sender label appended to the body (`body || agent`),
   *  matching the reference payload. */
  agent?: string;
  /** Extra data payload entries, merged over the defaults. */
  data?: Record<string, string>;
  /** Optional image URL for the notification `image` field. Only
   *  included when present — image-less notifications keep the exact
   *  previous payload. */
  image?: string;
}

/** Pure payload builder — kept separate so it is unit-testable without
 *  a network call or a GoogleAuth token. */
export function buildFcmMessage(args: BuildFcmMessageArgs): Record<string, unknown> {
  const { token, title, body, agent, data, image } = args;
  const notification: Record<string, string> = {
    title,
    body: agent ? `${body} || ${agent}` : body,
  };
  if (image) {
    notification.image = image;
  }
  return {
    message: {
      token,
      notification,
      data: {
        type: 'notification',
        agent: agent ?? '',
        ...data,
      },
      android: {
        priority: 'HIGH',
        notification: {
          channel_id: FCM_CHANNEL_ID,
        },
      },
    },
  };
}

interface FcmErrorResponse {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: unknown;
  };
}

/** Throws with the Firebase `message`/`status` retained, mirroring the
 *  meta-api `throwMetaError` pattern. */
async function throwFcmError(response: Response, fallback: string): Promise<never> {
  let message = fallback;
  let status: string | undefined;

  try {
    const data = (await response.json()) as FcmErrorResponse;
    if (data.error?.message) message = data.error.message;
    status = data.error?.status;
  } catch {
    // response body wasn't JSON — keep the fallback
  }

  console.error('[fcm] Firebase error response', {
    http: response.status,
    message,
    status,
  });

  throw new Error(`Firebase error: ${message}`);
}

export interface SendFcmMessageArgs {
  /** OAuth2 token from `getFcmAccessToken()`. */
  accessToken: string;
  token: string;
  title: string;
  body: string;
  agent?: string;
  data?: Record<string, string>;
  /** Optional image URL — omitted from the FCM payload when absent. */
  image?: string;
}

interface FcmSuccessResponse {
  name?: string;
}

/** Send one FCM HTTP v1 message to a single device token. Throws on
 *  failure; callers loop and collect per-user results.
 *
 *  Returns `{ messageId }` extracted from the Firebase response body
 *  when available (the `name` field in HTTP v1). Callers can persist
 *  this as the provider message id for tracking/dedup. */
export async function sendFcmMessage(
  args: SendFcmMessageArgs,
): Promise<{ messageId?: string }> {
  const { accessToken, token, title, body, agent, data, image } = args;
  const url = `${FCM_BASE_URL}/${loadProjectId()}/messages:send`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(buildFcmMessage({ token, title, body, agent, data, image })),
    signal: AbortSignal.timeout(FCM_REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    await throwFcmError(response, `Firebase error: HTTP ${response.status}`);
  }

  try {
    const json = (await response.json()) as FcmSuccessResponse;
    return { messageId: json.name };
  } catch {
    return {};
  }
}
