/**
 * Password hashing for Better Auth, spanning two eras.
 *
 * Phase 4 of the Supabase migration created `user` rows without credential
 * accounts, so 57 migrated users could only get in via a password reset.
 * `scripts/migrate-09-passwords.mts` backfills their legacy Supabase hashes,
 * which GoTrue wrote with bcrypt. Better Auth hashes with scrypt. Both formats
 * therefore live in `account.password` at once, and the verifier has to tell
 * them apart.
 *
 * The discriminator is the hash itself: bcrypt is self-describing (`$2a$`,
 * `$2b$` or `$2y$` followed by the cost and a base64 salt), while Better Auth's
 * scrypt output is a bare `<hex>:<hex>` pair that can never start with `$`.
 * There is no ambiguity to guess at.
 *
 * Only `verify` is dual. `hash` stays on scrypt, so every password set from now
 * on — sign-up, reset, change — is scrypt, and the bcrypt population can only
 * shrink. Overriding `hash` with bcrypt (as Better Auth's Supabase migration
 * guide suggests) would migrate the whole app onto the legacy algorithm to
 * accommodate a minority of rows.
 */
import bcrypt from "bcryptjs";
import { hashPassword, verifyPassword } from "better-auth/crypto";

/** `$2$` is not a real prefix, but `$2a$`, `$2b$`, `$2x$` and `$2y$` all are. */
const BCRYPT_HASH = /^\$2[abxy]\$\d{2}\$/;

export function isBcryptHash(hash: string): boolean {
  return BCRYPT_HASH.test(hash);
}

/**
 * Verifies against whichever algorithm produced the stored hash.
 *
 * Note bcrypt silently truncates the candidate at 72 bytes. That is not a new
 * weakness introduced here — GoTrue hashed under the same truncation, so a
 * legacy password verifies exactly as it did in the old app, no more and no
 * less.
 */
export async function verify({
  hash,
  password,
}: {
  hash: string;
  password: string;
}): Promise<boolean> {
  if (isBcryptHash(hash)) {
    return bcrypt.compare(password, hash);
  }
  return verifyPassword({ hash, password });
}

/** New passwords are always scrypt; see the module comment. */
export const hash = hashPassword;

export const password = { hash, verify };
