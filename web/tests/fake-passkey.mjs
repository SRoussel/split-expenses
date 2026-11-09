// A software stand-in for a phone's passkey, for the API tests. It builds the same bytes
// an iPhone sends (CBOR attestation, authenticator data, ECDSA P-256 signatures), so the
// server's real checks run against it. Knobs let a test break one thing at a time.

const { subtle } = globalThis.crypto;
const enc = new TextEncoder();

export const b64u = (bytes) => Buffer.from(bytes).toString("base64url");
const fromB64u = (s) => new Uint8Array(Buffer.from(s, "base64url"));
const sha256 = async (bytes) => new Uint8Array(await subtle.digest("SHA-256", bytes));
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
};
const u32 = (n) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

// --- Minimal CBOR encoder: ints, byte strings, text, maps (as Map, to keep key order). ---
function head(major, n) {
  if (n < 24) return new Uint8Array([(major << 5) | n]);
  if (n < 256) return new Uint8Array([(major << 5) | 24, n]);
  if (n < 65536) return new Uint8Array([(major << 5) | 25, n >> 8, n & 255]);
  return concat(new Uint8Array([(major << 5) | 26]), u32(n));
}
function cbor(v) {
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") {
    const b = enc.encode(v);
    return concat(head(3, b.length), b);
  }
  if (v instanceof Uint8Array) return concat(head(2, v.length), v);
  if (v instanceof Map) return concat(head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)]));
  throw new Error(`cbor: unsupported ${typeof v}`);
}

/** WebCrypto signs ECDSA as raw r||s; WebAuthn wants it DER-encoded. */
function derSignature(raw) {
  const int = (b) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    b = b.slice(i);
    if (b[0] & 0x80) b = concat(new Uint8Array([0]), b);
    return concat(new Uint8Array([0x02, b.length]), b);
  };
  const body = concat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return concat(new Uint8Array([0x30, body.length]), body);
}

const UP = 0x01; // user present
const UV = 0x04; // user verified (Face ID)
const AT = 0x40; // attested credential data included

export class FakePasskey {
  constructor({ origin, rpID = "localhost" }) {
    this.origin = origin;
    this.rpID = rpID;
    this.credentialId = crypto.getRandomValues(new Uint8Array(16));
    this.id = b64u(this.credentialId);
    this.counter = 0;
    this.userHandle = null;
  }

  async init() {
    this.keys = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    return this;
  }

  /** What navigator.credentials.create() would return, as JSON. */
  async create(options, { origin = this.origin, flags = UP | UV | AT } = {}) {
    this.userHandle = options.user.id; // base64url, as the server sent it
    const jwk = await subtle.exportKey("jwk", this.keys.publicKey);
    const cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, fromB64u(jwk.x)], [-3, fromB64u(jwk.y)]]));
    const authData = concat(
      await sha256(enc.encode(this.rpID)),
      new Uint8Array([flags]),
      u32(this.counter),
      new Uint8Array(16), // AAGUID: all zeros, like Apple's
      new Uint8Array([this.credentialId.length >> 8, this.credentialId.length & 255]),
      this.credentialId,
      cose,
    );
    const clientData = enc.encode(JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin, crossOrigin: false }));
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: b64u(clientData),
        attestationObject: b64u(cbor(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]))),
        transports: ["internal", "hybrid"],
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }

  /** What navigator.credentials.get() would return, as JSON. */
  async get(options, { origin = this.origin, flags = UP | UV, rpID = this.rpID, keys = this.keys, userHandle = this.userHandle } = {}) {
    const authData = concat(await sha256(enc.encode(rpID)), new Uint8Array([flags]), u32(this.counter));
    const clientData = enc.encode(JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin, crossOrigin: false }));
    const signed = concat(authData, await sha256(clientData));
    const raw = new Uint8Array(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, signed));
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: b64u(clientData),
        authenticatorData: b64u(authData),
        signature: b64u(derSignature(raw)),
        userHandle: userHandle ?? undefined,
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }
}

export { UP, UV, AT };
