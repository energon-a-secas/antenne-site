// Copied verbatim from projects/vitrina-site/convex/auth.config.ts.
import type { AuthConfig } from "convex/server";

// The fleet's production Clerk instance, the same one every Neorgon site signs
// in against. The JWT template the kit asks for is named "convex" and carries
// aud: convex, which is what applicationID has to match.
const CLERK_JWT_ISSUER = "https://clerk.neorgon.com";

export default {
  providers: [
    {
      domain: CLERK_JWT_ISSUER,
      applicationID: "convex",
    },
  ],
} satisfies AuthConfig;
