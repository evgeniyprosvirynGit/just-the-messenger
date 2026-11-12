import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { createServer } from "node:http";

const issuer = process.env.OIDC_MOCK_ISSUER ?? "http://oidc-mock:8099";
const port = Number(process.env.OIDC_MOCK_PORT ?? "8099");
const clientId = "meridian-playwright";
const clientSecret = "e2e-test-only";
const keyId = "meridian-playwright-key";
const authCodes = new Map();
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: keyId, alg: "RS256", use: "sig" };

function sendJSON(response, status, payload) {
  response.writeHead(status, { "Cache-Control": "no-store", "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}

function unsignedTokenPart(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function issueIDToken({ nonce, subject }) {
  const now = Math.floor(Date.now() / 1000);
  const header = unsignedTokenPart({ alg: "RS256", kid: keyId, typ: "JWT" });
  const payload = unsignedTokenPart({
    iss: issuer,
    aud: clientId,
    sub: subject,
    iat: now,
    exp: now + 300,
    nonce,
  });
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url")}`;
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", issuer);

  if (url.pathname === "/healthz") {
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("ok");
    return;
  }

  if (url.pathname === "/.well-known/openid-configuration") {
    sendJSON(response, 200, {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks.json`,
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      scopes_supported: ["openid"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
      code_challenge_methods_supported: ["S256"],
    });
    return;
  }

  if (url.pathname === "/jwks.json") {
    sendJSON(response, 200, { keys: [jwk] });
    return;
  }

  if (url.pathname === "/authorize") {
    const redirectURI = url.searchParams.get("redirect_uri");
    const state = url.searchParams.get("state");
    const nonce = url.searchParams.get("nonce");
    const challenge = url.searchParams.get("code_challenge");
    const method = url.searchParams.get("code_challenge_method");
    if (url.searchParams.get("client_id") !== clientId
      || url.searchParams.get("response_type") !== "code"
      || url.searchParams.get("scope") !== "openid"
      || !redirectURI
      || !state
      || !nonce
      || !challenge
      || method !== "S256") {
      response.writeHead(400, { "Content-Type": "text/plain" });
      response.end("Invalid authorization request");
      return;
    }

    const savedCookie = request.headers.cookie?.match(/(?:^|;\s*)meridian_oidc_test_user=([a-zA-Z0-9_-]+)/)?.[1];
    const testUserID = savedCookie ?? randomBytes(12).toString("base64url");
    if (!savedCookie) {
      response.setHeader("Set-Cookie", `meridian_oidc_test_user=${testUserID}; Path=/; Max-Age=86400; HttpOnly; SameSite=Lax`);
    }
    const code = randomBytes(18).toString("base64url");
    authCodes.set(code, {
      challenge,
      nonce,
      redirectURI,
      subject: `playwright-${testUserID}`,
    });
    response.writeHead(302, { Location: `${redirectURI}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}` });
    response.end();
    return;
  }

  if (url.pathname === "/token" && request.method === "POST") {
    const form = new URLSearchParams(await readBody(request));
    const code = form.get("code") ?? "";
    const grant = authCodes.get(code);
    authCodes.delete(code);
    const authorization = request.headers.authorization?.startsWith("Basic ")
      ? Buffer.from(request.headers.authorization.slice("Basic ".length), "base64").toString("utf8")
      : "";
    const [basicClientID, basicClientSecret] = authorization.split(":", 2);
    const suppliedClientID = form.get("client_id") ?? basicClientID;
    const suppliedClientSecret = form.get("client_secret") ?? basicClientSecret;
    const verifier = form.get("code_verifier") ?? "";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    if (!grant
      || suppliedClientID !== clientId
      || suppliedClientSecret !== clientSecret
      || form.get("redirect_uri") !== grant.redirectURI
      || challenge !== grant.challenge) {
      sendJSON(response, 400, { error: "invalid_grant" });
      return;
    }
    sendJSON(response, 200, {
      access_token: "test-token-not-persisted",
      token_type: "Bearer",
      expires_in: 300,
      id_token: issueIDToken(grant),
    });
    return;
  }

  response.writeHead(404, { "Content-Type": "text/plain" });
  response.end("Not found");
});

server.listen(port, "0.0.0.0", () => {
  process.stdout.write(`Playwright OIDC provider listening on ${port}\n`);
});
