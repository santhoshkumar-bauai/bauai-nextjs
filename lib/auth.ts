import { mongodbAdapter } from "@better-auth/mongo-adapter";
import { betterAuth } from "better-auth/minimal";
import { after } from "next/server";

import { password } from "@/lib/auth-password";
import { mongoClient, mongoDatabase } from "@/lib/db/mongodb";
import {
  sendResetPasswordEmail,
  sendVerificationEmail,
} from "@/lib/email/resend";
import { resolveRequestLocale } from "@/lib/i18n/request-locale";

const trustedOrigins = process.env.BETTER_AUTH_TRUSTED_ORIGINS?.split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const googleEnabled = Boolean(
  process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET,
);
const microsoftEnabled = Boolean(
  process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET,
);

export const auth = betterAuth({
  appName: "BAU AI",
  database: mongodbAdapter(mongoDatabase, { client: mongoClient }),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    requireEmailVerification: true,
    resetPasswordTokenExpiresIn: 60 * 60,
    // Migrated users carry a bcrypt hash from Supabase; everyone else is on
    // scrypt. See lib/auth-password.ts — only verification is dual, hashing
    // stays on scrypt so the bcrypt population only shrinks.
    password,
    // A reset is how someone locked out of the account takes it back. Assume the
    // old password leaked and drop every session the previous holder still has.
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async ({ user, url }, request) => {
      const locale = resolveRequestLocale(request);
      after(async () => {
        try {
          await sendResetPasswordEmail({
            to: user.email,
            name: user.name,
            resetUrl: url,
            locale,
          });
        } catch (error) {
          console.error("Failed to send password reset email", error);
        }
      });
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    sendOnSignIn: true,
    autoSignInAfterVerification: true,
    expiresIn: 60 * 60,
    sendVerificationEmail: async ({ user, url }, request) => {
      const locale = resolveRequestLocale(request);
      after(async () => {
        try {
          await sendVerificationEmail({
            to: user.email,
            name: user.name,
            verificationUrl: url,
            locale,
          });
        } catch (error) {
          console.error("Failed to send verification email", error);
        }
      });
    },
  },
  trustedOrigins,
  socialProviders: {
    ...(googleEnabled
      ? {
          google: {
            clientId: process.env.GOOGLE_CLIENT_ID!,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
            prompt: "select_account" as const,
          },
        }
      : {}),
    ...(microsoftEnabled
      ? {
          microsoft: {
            clientId: process.env.MICROSOFT_CLIENT_ID!,
            clientSecret: process.env.MICROSOFT_CLIENT_SECRET!,
            tenantId: process.env.MICROSOFT_TENANT_ID || "common",
            prompt: "select_account" as const,
          },
        }
      : {}),
  },
});
