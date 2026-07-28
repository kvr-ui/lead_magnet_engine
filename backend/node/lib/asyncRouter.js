const express = require("express");

/**
 * Express 4 does not understand async route handlers: if one rejects, the
 * rejection is never passed to next(), so it surfaces as an unhandled
 * promise rejection — which Node >= 15 turns into a hard process exit.
 *
 * In practice that meant a single bad request (e.g. GET /api/campaigns/:id
 * with an id Mongoose can't cast to an ObjectId) killed the whole server
 * mid-response. The browser got a connection close / empty body, and fetch's
 * res.json() failed with "JSON.parse: unexpected end of data at line 1
 * column 1" instead of a real error message. Under `node --watch` the
 * process does not come back on crash either — it waits for a file change —
 * so the API stayed down until someone restarted it by hand.
 *
 * asyncRouter() returns a normal express.Router() whose verb methods wrap
 * every handler so rejections (and synchronous throws) go to next(), landing
 * in the JSON error handler in index.js. Handlers that already have their
 * own try/catch are unaffected.
 */

const VERBS = ["get", "post", "put", "patch", "delete", "head", "options", "all"];

function wrap(handler) {
  if (typeof handler !== "function") return handler;

  // Express identifies error-handling middleware by arity, so preserve it.
  if (handler.length === 4) {
    return function wrappedErrorHandler(err, req, res, next) {
      try {
        return Promise.resolve(handler(err, req, res, next)).catch(next);
      } catch (e) {
        return next(e);
      }
    };
  }

  return function wrappedHandler(req, res, next) {
    try {
      return Promise.resolve(handler(req, res, next)).catch(next);
    } catch (e) {
      return next(e);
    }
  };
}

function asyncRouter(options) {
  const router = express.Router(options);

  for (const verb of VERBS) {
    const original = router[verb].bind(router);
    router[verb] = (path, ...handlers) => original(path, ...handlers.map(wrap));
  }

  return router;
}

module.exports = { asyncRouter, wrap };
