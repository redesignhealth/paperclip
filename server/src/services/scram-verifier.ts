import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";

export const SCRAM_DEFAULT_ITERATIONS = 4096;
export const SCRAM_SALT_BYTES = 16;
export const SCRAM_PASSWORD_BYTES = 32;

export const SCRAM_VERIFIER_REGEX = /^SCRAM-SHA-256\$\d+:[A-Za-z0-9+/=]{20,30}\$[A-Za-z0-9+/=]{40,50}:[A-Za-z0-9+/=]{40,50}$/;

export interface ScramVerifierResult {
  readonly password: string;
  readonly saltBase64: string;
  readonly iterations: number;
  readonly storedKeyBase64: string;
  readonly serverKeyBase64: string;
  readonly verifier: string;
}

export function generateRandomPassword(): string {
  return randomBytes(SCRAM_PASSWORD_BYTES).toString("base64url");
}

export function generateScramVerifier(
  password: string = generateRandomPassword(),
  salt: Buffer = randomBytes(SCRAM_SALT_BYTES),
  iterations: number = SCRAM_DEFAULT_ITERATIONS,
): ScramVerifierResult {
  // Digest = PBKDF2(HMAC-SHA256, password, salt, iterations, 32)
  const digest = pbkdf2Sync(password, salt, iterations, 32, "sha256");

  // ClientKey = HMAC-SHA256(digest, "Client Key")
  const clientKey = createHmac("sha256", digest).update("Client Key").digest();

  // StoredKey = SHA256(clientKey)
  const storedKey = createHash("sha256").update(clientKey).digest();

  // ServerKey = HMAC-SHA256(digest, "Server Key")
  const serverKey = createHmac("sha256", digest).update("Server Key").digest();

  const saltBase64 = salt.toString("base64");
  const storedKeyBase64 = storedKey.toString("base64");
  const serverKeyBase64 = serverKey.toString("base64");

  const verifier = `SCRAM-SHA-256$${iterations}:${saltBase64}$${storedKeyBase64}:${serverKeyBase64}`;

  assertValidScramVerifier(verifier);

  return {
    password,
    saltBase64,
    iterations,
    storedKeyBase64,
    serverKeyBase64,
    verifier,
  };
}

export function rederiveScramVerifier(
  password: string,
  saltBase64: string,
  iterations: number = SCRAM_DEFAULT_ITERATIONS,
): ScramVerifierResult {
  const salt = Buffer.from(saltBase64, "base64");
  return generateScramVerifier(password, salt, iterations);
}

export function assertValidScramVerifier(verifier: string): void {
  if (typeof verifier !== "string" || !SCRAM_VERIFIER_REGEX.test(verifier)) {
    throw new Error("Invalid PostgreSQL SCRAM-SHA-256 verifier format");
  }
}
