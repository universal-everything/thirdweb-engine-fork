import { CloudKmsSigner } from "@cloud-cryptographic-wallet/cloud-kms-signer";
import { Bytes } from "@cloud-cryptographic-wallet/signer";
import { KeyManagementServiceClient, protos } from "@google-cloud/kms";
import { describe, expect, it, vi } from "vitest";

// Published upstream CloudKmsSigner 0.1.2 test vectors (MIT licensed).
// Real installed signer, Google client and generated protobuf codecs; only the
// remote RPC responses are stubbed. No credentials or live signing are used.
const pem =
  "-----BEGIN PUBLIC KEY-----\n" +
  "MFYwEAYHKoZIzj0CAQYFK4EEAAoDQgAE1PZkpC+R30dOTpdUn3c6GH7YX5Ovn8QF\n" +
  "OimWHZyBDqM8iJSjE2Mcfu6DkW7zKtXbwyHwax1gDwOe7iJIjWtI0Q==\n" +
  "-----END PUBLIC KEY-----\n";
const hash = "8f5c4a30797ff58826711013473057e15ab305046fc5d2f76699769ed30d40f6";
const der =
  "3045022100f66b26e8370aead7cab0fedd9650705be79be165ba807b5e2d1b18030d726d2302204e77b43a05c5901c38ed60957bc38dadea4a6b91837815f197a520871fa53e72";

function signerFixture(badCrc = false) {
  const signer = new CloudKmsSigner("keyName");
  const client = (signer as unknown as { client: KeyManagementServiceClient })
    .client;
  expect(client).toBeInstanceOf(KeyManagementServiceClient);
  vi.spyOn(client, "getPublicKey").mockImplementation(
    async () =>
      [
        {
          name: "keyName",
          pem,
          pemCrc32c: { value: "4077715619" },
        },
      ] as never,
  );
  const sign = vi.spyOn(client, "asymmetricSign").mockImplementation(
    async () =>
      [
        {
          signature: Buffer.from(der, "hex"),
          signatureCrc32c: { value: badCrc ? "42" : "3151495169" },
        },
      ] as never,
  );
  return { signer, sign };
}

describe("KMS dependency compatibility", () => {
  it("preserves generated KMS protobuf signing request bytes", () => {
    const type = protos.google.cloud.kms.v1.AsymmetricSignRequest;
    const request = {
      name: "keyName",
      digest: { sha256: Buffer.from(hash, "hex") },
    };
    const bytes = type.encode(request).finish();
    // field 1 name; field 3 Digest, field 1 sha256 (32 bytes).
    expect(Buffer.from(bytes).toString("hex")).toBe(
      `0a076b65794e616d651a220a20${hash}`,
    );
    const decoded = type.decode(bytes);
    expect(decoded.name).toBe(request.name);
    expect(Buffer.from(decoded.digest?.sha256 || []).toString("hex")).toBe(
      hash,
    );
  });

  it("retains signer public key and deterministic signature recovery", async () => {
    const { signer, sign } = signerFixture();
    const key = await signer.getPublicKey();
    expect(key.toAddress().toString()).toMatch(/^(0x)?[a-fA-F0-9]{40}$/);
    const signature = await signer.sign(Bytes.fromString(hash));
    expect(signature.bytes.toString().replace(/^0x/, "")).toBe(
      "f66b26e8370aead7cab0fedd9650705be79be165ba807b5e2d1b18030d726d234e77b43a05c5901c38ed60957bc38dadea4a6b91837815f197a520871fa53e721c",
    );
    expect(sign).toHaveBeenCalledWith({
      name: "keyName",
      digest: { sha256: Bytes.fromString(hash).asUint8Array },
    });
  });

  it("still rejects a corrupted KMS signature checksum", async () => {
    const { signer } = signerFixture(true);
    await expect(signer.sign(Bytes.fromString(hash))).rejects.toThrow(/crc32c/);
  });
});
