import bcrypt from "bcryptjs";
import { hashPassword } from "better-auth/crypto";
import { describe, expect, it } from "vitest";

import { hash, isBcryptHash, verify } from "@/lib/auth-password";

describe("isBcryptHash", () => {
  it("recognises every prefix GoTrue could have written", () => {
    for (const prefix of ["$2a$", "$2b$", "$2x$", "$2y$"]) {
      expect(isBcryptHash(`${prefix}10$abcdefghijklmnopqrstuv`)).toBe(true);
    }
  });

  it("rejects a Better Auth scrypt hash", () => {
    expect(isBcryptHash("deadbeef:cafebabe")).toBe(false);
  });

  it("rejects argon2, which we deliberately do not verify", () => {
    expect(isBcryptHash("$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA")).toBe(false);
  });
});

describe("verify", () => {
  // Cost 10 is what GoTrue used; generating rather than pasting a fixture keeps
  // the test honest about the algorithm rather than about one frozen string.
  const legacyPassword = "correct horse battery staple";

  it("accepts a legacy Supabase password against its bcrypt hash", async () => {
    const legacyHash = await bcrypt.hash(legacyPassword, 10);
    expect(isBcryptHash(legacyHash)).toBe(true);
    await expect(verify({ hash: legacyHash, password: legacyPassword })).resolves.toBe(
      true,
    );
  });

  it("rejects a wrong password against a bcrypt hash", async () => {
    const legacyHash = await bcrypt.hash(legacyPassword, 10);
    await expect(verify({ hash: legacyHash, password: "wrong" })).resolves.toBe(false);
  });

  it("still accepts a Better Auth scrypt password", async () => {
    const scryptHash = await hashPassword("a-new-password");
    expect(isBcryptHash(scryptHash)).toBe(false);
    await expect(verify({ hash: scryptHash, password: "a-new-password" })).resolves.toBe(
      true,
    );
  });

  it("rejects a wrong password against a scrypt hash", async () => {
    const scryptHash = await hashPassword("a-new-password");
    await expect(verify({ hash: scryptHash, password: "wrong" })).resolves.toBe(false);
  });

  it("does not cross the algorithms over", async () => {
    const scryptHash = await hashPassword(legacyPassword);
    const legacyHash = await bcrypt.hash(legacyPassword, 10);
    // Same plaintext, different formats — each must verify under its own path
    // and neither hash may be mistaken for the other's format.
    await expect(verify({ hash: scryptHash, password: legacyPassword })).resolves.toBe(
      true,
    );
    await expect(verify({ hash: legacyHash, password: legacyPassword })).resolves.toBe(
      true,
    );
    expect(isBcryptHash(scryptHash)).toBe(false);
    expect(isBcryptHash(legacyHash)).toBe(true);
  });
});

describe("hash", () => {
  it("produces scrypt, never bcrypt, so the legacy population only shrinks", async () => {
    const produced = await hash("some-password");
    expect(isBcryptHash(produced)).toBe(false);
    await expect(verify({ hash: produced, password: "some-password" })).resolves.toBe(
      true,
    );
  });
});
