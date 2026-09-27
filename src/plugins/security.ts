/**
 * Security plugin — @fastify/helmet with strict CSP + transport hardening.
 *
 * CSP: default-src 'self', base-uri 'self', form-action 'self',
 *      script-src 'self', style-src 'self', connect-src 'self',
 *      img-src 'self' data:, font-src 'self', object-src 'none',
 *      frame-src 'none', frame-ancestors 'none'.
 * Also enables HSTS, referrer policy, and no-Sniff.
 */
import fp from "fastify-plugin";
import helmet from "@fastify/helmet";
import type { FastifyInstance } from "fastify";

async function securityPlugin(app: FastifyInstance): Promise<void> {
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameSrc: ["'none'"],
        connectSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
    },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    noSniff: true,
  });
}

export default fp(securityPlugin, {
  name: "security",
});
