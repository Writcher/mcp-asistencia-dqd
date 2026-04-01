import jwt from "jsonwebtoken";
import * as dotenv from "dotenv";

dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET!;
const TENANT_ID = process.env.DIR_ID!;
const CLIENT_ID = process.env.APP_ID!;
const CLIENT_SECRET = process.env.CLIENT_SECRET!;
const BASE_URL = process.env.BASE_URL!;

// State temporal: azureState → { redirectUri, codeVerifier, clientState }
const pendingStates = new Map<string, {
  redirectUri: string;
  codeVerifier: string;
  clientState: string;
}>();

// Codes temporales: code → email
const authCodes = new Map<string, { email: string; expira: number }>();

// DCR: clientes registrados dinámicamente (Claude se registra acá)
const registeredClients = new Map<string, { redirectUris: string[] }>();

// --- PKCE helpers -----------------------------------------------------------

function base64url(buffer: Uint8Array | ArrayBuffer): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

async function sha256(plain: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(plain);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return base64url(hash);
}

function randomBase64url(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

// --- DCR --------------------------------------------------------------------

export function registrarCliente(body: Record<string, any>): Record<string, any> {
  const clientId = `claude-${crypto.randomUUID()}`;
  const redirectUris: string[] = body.redirect_uris ?? [];
  registeredClients.set(clientId, { redirectUris });

  return {
    client_id: clientId,
    client_secret: "not-used",
    redirect_uris: redirectUris,
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

// --- Authorization ----------------------------------------------------------

export async function generarUrlAzure(
  redirectUri: string,
  clientState: string
): Promise<{ location: string }> {
  const azureState = crypto.randomUUID();
  const codeVerifier = randomBase64url(32);
  const codeChallenge = await sha256(codeVerifier);

  pendingStates.set(azureState, { redirectUri, codeVerifier, clientState });
  setTimeout(() => pendingStates.delete(azureState), 10 * 60 * 1000);

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: `${BASE_URL}/oauth/callback`,
    scope: "openid profile email",
    state: azureState,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  return {
    location: `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/authorize?${params}`,
  };
}

// --- Callback ---------------------------------------------------------------

export async function manejarCallback(
  code: string,
  azureState: string
): Promise<{ redirectUri: string; clientState: string; email: string } | null> {
  const pending = pendingStates.get(azureState);
  if (!pending) return null;
  pendingStates.delete(azureState);

  // Intercambiamos el code con Azure
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code,
    redirect_uri: `${BASE_URL}/oauth/callback`,
    grant_type: "authorization_code",
    code_verifier: pending.codeVerifier,
  });

  const resp = await fetch(
    `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    }
  );

  if (!resp.ok) return null;

  const tokens = await resp.json();

  // Decodificamos el id_token para sacar el email (sin verificar firma, es interno)
  const [, payload] = tokens.id_token.split(".");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
  const email: string = claims.preferred_username ?? claims.email ?? claims.upn;

  return { redirectUri: pending.redirectUri, clientState: pending.clientState, email };
}

// --- Auth codes -------------------------------------------------------------

export function generarAuthCode(email: string): string {
  const code = crypto.randomUUID();
  authCodes.set(code, { email, expira: Date.now() + 5 * 60 * 1000 });
  return code;
}

export function canjearAuthCode(code: string): string | null {
  const entry = authCodes.get(code);
  if (!entry) return null;
  if (Date.now() > entry.expira) { authCodes.delete(code); return null; }
  authCodes.delete(code);
  return entry.email;
}

// --- JWT --------------------------------------------------------------------

export function generarToken(email: string): string {
  return jwt.sign({ usuario: email }, JWT_SECRET, { expiresIn: "8h" });
}

export function verificarToken(token: string): string | null {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { usuario: string };
    return payload.usuario;
  } catch {
    return null;
  }
}