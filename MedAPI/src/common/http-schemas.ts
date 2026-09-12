import { z } from 'zod';

// Mirrors what app.ts's error handler sends.
export const errorResponseSchema = z.object({
  code: z.string(),
  message: z.string(),
});

/** OpenAPI `security` requirement for routes gated by `requireHousehold`. */
export const bearerAuthSecurity = [{ bearerAuth: [] }];
