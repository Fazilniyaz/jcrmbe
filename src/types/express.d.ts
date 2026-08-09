import type { AuthContext } from "../middleware/auth";

declare global {
  namespace Express {
    interface Request {
      /**
       * Set by requireAuth / requireMaster. Everything downstream reads the
       * tenant and the roles from HERE and never from the request body.
       */
      auth?: AuthContext;
      /** Output of `validate()` — the only parsed input a handler should read. */
      valid?: { body?: unknown; query?: unknown; params?: unknown };
    }
  }
}

export {};
